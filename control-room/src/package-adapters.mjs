// Trusted operator adapters for the launch package queues. They talk only to the
// two root-owned brokers over Unix sockets (DEX Screener purchase broker, X pool
// broker) and to billing for the treasury → operations debit that pays each
// step back. Nothing here is reachable from a request, a holder or the model.
//
// Money flow (v3): the project treasury bridges the $310 DEX allocation to the
// platform's pinned Solana wallet (the bridge IS the treasury debit, booked by
// billing with the job id), the broker pays the $299 order from that wallet once
// the USDC is proven there; the $10 X-account allocation is debited treasury →
// operations through `chargeTreasuryOnce`. A step is only reported as settled to
// the queue after the provider receipt and a fresh treasury observation exist.
import { createHash } from "node:crypto";
import { brokerCall } from "./x-posts.mjs";
import { env } from "./env.mjs";
import { chargeTreasuryOnce, refreshTreasury, bridgePackageAllocation } from "./billing.mjs";
import { stageFundingOf } from './startup-stages.mjs';
import { packageTerms, isStagedLaunch } from "./launch-package.mjs";
import { tokenOf } from "./economy.mjs";
import { projectProfile, projectLogo } from "./project-profile.mjs";

export const DEX_AMOUNT_MICROS = 299_000_000;
export const DEX_MAX_USDC_MICROS = DEX_AMOUNT_MICROS;     // the broker guard may never spend more than the order price
export const DEX_ALLOCATION_MICROS = 310_000_000;       // v3 allocation bridged to the platform DEX wallet (packageTerms wins when present)
// The whole $10 X-account allocation goes to the platform operations wallet at funding
// (owner decision 2026-09-21); it is not the seller's unit price.
export const X_ACCOUNT_MICROS = 10_000_000;
export const X_POOL_ORDER = "3d517c5db19742e3a2f802d5a12b22cc"; // the paid seller batch these accounts came from
export const dexSocketPath = () => env("DEX_BROKER_SOCKET", "/run/metahuman-dex/broker.sock");
export const intentFor = (...parts) => createHash("sha256").update(parts.join(":")).digest("hex");
const idOk = (s) => typeof s === "string" && /^[a-zA-Z0-9:_-]{1,180}$/.test(s);
const stripUrls = (s) => String(s || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();

function orderContent(t, { publicBase }) {
  const profile = projectProfile(t);
  const description = stripUrls(profile.description || profile.tagline || `${t.name} (${t.symbol}) is an AI agent project on Autonom: a live desktop, a treasury and holder votes.`).slice(0, 1000);
  const socials = [];
  if (t.social?.x?.handle) socials.push({ type: "twitter", url: `https://x.com/${t.social.x.handle}` });
  const websites = [{ label: "Website", url: `${publicBase}/t/${t.address}` }];
  return { description, socials, websites };
}

/// DEX Screener Enhanced Token Info for a funded launch package.
/// Money flow (owner decision 2026-09-21): at funding the project's treasury bridges its
/// whole DEX allocation ($310 in v3) as USDC to the platform's Solana DEX wallet; the
/// broker then pays the $299 order from that wallet. The bridge IS the treasury debit,
/// so nothing is reimbursed afterwards. Every step is durable and idempotent, and the
/// queue's `reconcile` simply advances the same state machine on every tick.
///
/// Attempt scheme (deterministic, no ad-hoc intents): bridge id
/// `package-dex-bridge:<job.id>:a<n>` where n = 1 + refunded records for that job (max 3);
/// pay intent `intentFor('dex-pay', job.id, 'a'+n)` and, for a later pay attempt p after an
/// on-chain failure, `intentFor('dex-pay', job.id, 'a'+n, 'p'+p)` (max 3 pay attempts).
/// Only payOrder dispatches the bridge (dispatch:true); reconcile observes it
/// (dispatch:false) and, once the USDC is proven in the DEX wallet, pays the order.
export const DEX_MIN_OUT_MICROS = 302_000_000;               // order price + $3 bridge/network slack
export const DEX_MAX_ATTEMPTS = 3;                            // bridge attempts (refunds) and pay attempts (on-chain failures)
export const DEX_DELIVERY_TIMEOUT_MS = 30 * 60_000;           // settled on Relay but USDC not seen → operator
export const DEX_WALLET_CACHE_MS = 60_000;
export const DEX_WALLET_DEFAULT = "DCB8WtbjRJ1DWntBo9LbtniCbkiVT5aoYp4mWPmPhe54";
export const pinnedDexWallet = () => env("DEX_WALLET_ADDRESS", DEX_WALLET_DEFAULT);
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SOL_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const RESUMABLE_PAY = new Set(["started", "prepared", "guarded"]);
const failure = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export function createDexPackageAdapter({ call = (m, p, b) => brokerCall(m, p, b, { socketPath: dexSocketPath(), timeoutMs: 55_000 }), bridge = bridgePackageAllocation, refresh = refreshTreasury,
  readBanner = async () => null, publicBase = () => env("PUBLIC_BASE", env("GATEWAY_PUBLIC_URL", "https://autonom.fun")), now = Date.now, pinnedWallet = pinnedDexWallet } = {}) {
  const orderIntent = (job) => intentFor("dex-order", job.id);
  const payIntent = (job, n, p) => p > 1 ? intentFor("dex-pay", job.id, "a" + n, "p" + p) : intentFor("dex-pay", job.id, "a" + n);
  const bridgePrefix = (job) => `package-dex-bridge:${job.id}:a`;
  const bridgeId = (job, n) => bridgePrefix(job) + n;
  const refundedCount = (t, job) => Object.values(t.packageBridgeReservations || {}).filter((r) => r && typeof r.id === "string" && r.id.startsWith(bridgePrefix(job)) && r.state === "refunded").length;
  const payAttemptOf = (job) => Number.isSafeInteger(job.payAttempt) && job.payAttempt >= 1 ? job.payAttempt : 1;
  let walletCache = null;
  /// The broker's wallet must be the operator-pinned address: the bridge recipient is
  /// always the pinned one, and a broker answering with another key stops the job.
  async function dexWallet() {
    const pinned = pinnedWallet();
    if (!SOL_ADDRESS.test(String(pinned))) throw failure("DEX wallet pin is invalid", "DEX_WALLET_MISMATCH");
    if (walletCache && walletCache.address === pinned && now() - walletCache.at < DEX_WALLET_CACHE_MS) return pinned;
    const r = await call("GET", "/wallet");
    if (r.status !== 200 || !SOL_ADDRESS.test(String(r.json?.address || ""))) throw failure("DEX wallet address unavailable", "DEX_WALLET_UNAVAILABLE", { retryable: true, reason: "DEX wallet address unavailable" });
    if (r.json.address !== pinned) throw failure("DEX broker wallet differs from the pinned address", "DEX_WALLET_MISMATCH");
    walletCache = { address: pinned, at: now() };
    return pinned;
  }
  const allocationOf = (t) => packageTerms(t)?.dexBudgetMicros || DEX_ALLOCATION_MICROS;
  async function prepareOrder({ project, job }) {
    const t = tokenOf(project.token);
    const content = orderContent(t, { publicBase: publicBase() });
    let logo = null, banner = null;
    try { logo = projectLogo(t); } catch { logo = null; }
    try { banner = await readBanner(t); } catch { banner = null; }
    const r = await call("POST", "/order", { project: isStagedLaunch(t) && t.chain === 'solana' ? t.address : t.address.toLowerCase(), chainId: t.chain, tokenAddress: t.address, intentId: orderIntent(job),
      ...content, logoPngBase64: logo ? Buffer.from(logo).toString("base64") : null, bannerPngBase64: banner ? Buffer.from(banner).toString("base64") : null });
    if (r.status !== 200 || !idOk(r.json?.orderId) || !/^[a-f0-9]{24}$/.test(r.json?.paylinkId || "")) throw failure(`DEX order unavailable (${r.json?.error || r.status})`, r.json?.error || "DEX_ORDER_FAILED");
    if (isStagedLaunch(t) && (r.json.intentId !== orderIntent(job) || r.json.project !== (t.chain === 'solana' ? t.address : t.address.toLowerCase()) ||
        r.json.chainId !== t.chain || r.json.tokenAddress !== t.address || r.json.stage !== 'done' || r.json.amountCents !== 29900))
      throw failure('DEX order response is not bound to the project and approved amount', 'DEX_ORDER_MISMATCH');
    return { orderId: r.json.orderId, paylinkId: r.json.paylinkId, targetChain: t.chain, targetTokenAddress: isStagedLaunch(t) && t.chain === 'solana' ? t.address : t.address.toLowerCase(), paymentChain: "solana", amountMicros: DEX_AMOUNT_MICROS };
  }
  /// Delivery proof: Relay "success" is not the USDC in our wallet. The broker reads the
  /// destination transaction and reports the wallet's own USDC delta.
  async function deposit(signature, { minUsdcMicros = 0, minLamports = 0 } = {}) {
    if (!SOL_SIGNATURE.test(String(signature || ""))) return null;
    try { const r = await call("GET", `/deposit?signature=${encodeURIComponent(signature)}&minUsdcMicros=${minUsdcMicros}&minLamports=${minLamports}`); return r.status === 200 && r.json && typeof r.json === "object" ? r.json : null; }
    catch { return null; }
  }
  /// The payment step never re-signs: a signed/submitted/uncertain receipt is only
  /// reconciled (confirm loop); /pay is used when no receipt exists or it is resumable.
  /// A Solana project's allocation arrives as SOL, so the order is paid in SOL: the cap is
  /// the order price at the treasury's own SOL/USD valuation plus 3 % (Helio fixes the
  /// lamports at prepare time from its rate; the broker refuses anything above the cap).
  const solPayCapLamports = (t) => { const usd = t?.treasury?.solUsd; if (!(usd > 0)) throw Object.assign(new Error("SOL valuation is unavailable for the DEX payment cap"), { code: "DEX_SOL_PRICE_UNAVAILABLE" }); return Math.ceil((DEX_AMOUNT_MICROS / 1e6) / usd * 1.03 * 1e9); };
  async function payment(t, job, intentId) {
    const rc = await call("POST", "/reconcile", { intentId });
    if (rc.status === 200 && rc.json?.stage && !RESUMABLE_PAY.has(rc.json.stage)) return { via: "reconcile", ...rc.json };
    if (rc.status !== 200 && rc.json?.error !== "RECEIPT_NOT_FOUND") return { via: "reconcile", stage: "unavailable", reason: rc.json?.error || String(rc.status) };
    const solana = t?.treasury?.chain === "solana";
    const r = await call("POST", "/pay", { intentId, orderId: job.order.orderId, paylinkId: job.order.paylinkId, ...(solana ? { currency: "SOL", maxLamports: solPayCapLamports(t) } : { currency: "USDC", maxUsdcMicros: DEX_MAX_USDC_MICROS }) });
    if (r.status !== 200) return { via: "pay", stage: "unavailable", reason: r.json?.error || String(r.status) };
    return { via: "pay", ...r.json };
  }
  // A confirmed receipt must carry the exact order price; a larger, smaller or unknown
  // provider debit is never reported to the queue as paid.
  // On the SOL path the broker reports lamportsOut (Helio fixed the SOL amount for the $299 order); the USDC amount is 0.
  const confirmed = (rc, currency = "USDC") => rc?.stage === "confirmed" && idOk(rc.signature) && (currency === "SOL" ? Number(rc.lamportsOut) > 0 && (rc.amountMicros === undefined || rc.amountMicros === 0) : rc.amountMicros === DEX_AMOUNT_MICROS);
  /// One step of the durable state machine: bridge (dispatch only from payOrder), prove
  /// delivery, then pay. Returns what happened; `assess` turns it into the queue's result.
  async function advance(t, job, { dispatch, paused = false }) {
    const wallet = await dexWallet();
    const allocation = allocationOf(t), refundedBefore = refundedCount(t, job), attempt = refundedBefore + 1, payAttempt = payAttemptOf(job);
    const step = { attempt, payAttempt, intentId: payIntent(job, attempt, payAttempt), bridge: null, deposit: null, receipt: null, terminal: null, dispatched: false };
    if (refundedBefore >= DEX_MAX_ATTEMPTS) return { ...step, terminal: `DEX allocation bridge refunded ${DEX_MAX_ATTEMPTS} times; operator review` };
    if (payAttempt > DEX_MAX_ATTEMPTS) return { ...step, terminal: `DEX payment failed on-chain ${DEX_MAX_ATTEMPTS} times; operator review` };
    if (dispatch && isStagedLaunch(t) && !stageFundingOf(t,'dex',{now:now()}).ready) throw failure('DEX stage funding changed before dispatch','DEX_BRIDGE_NOT_DISPATCHED',{retryable:true});
    const b = await bridge(t, { id: bridgeId(job, attempt), micros: allocation, recipient: wallet, reason: "DEX Screener listing allocation", reservedMicros: allocation,
      ledgerKey: { launchPackageJobId: job.id }, minOutMicros: DEX_MIN_OUT_MICROS, dispatch });
    step.bridge = b && typeof b === "object" ? b : { state: "invalid", reason: "bridge returned no view" };
    step.dispatched = !["none", "unavailable", "released"].includes(step.bridge.state);
    if (step.bridge.state === "refunded" && refundedCount(t, job) >= DEX_MAX_ATTEMPTS) return { ...step, terminal: `DEX allocation bridge refunded ${DEX_MAX_ATTEMPTS} times; operator review` };
    if (step.bridge.state !== "settled" || !job.order) return step;
    const signature = Array.isArray(b.outTxHashes) ? b.outTxHashes[0] : null;
    const solana = t.treasury?.chain === "solana";
    step.deposit = await deposit(signature, solana ? { minLamports: Number(b.lamports) || 1 } : { minUsdcMicros: Math.floor(0.97 * allocation) });
    if (step.deposit?.confirmed !== true) {
      if (step.deposit?.found === true) return { ...step, terminal: step.deposit.err ? "bridged USDC transaction failed on Solana; operator review" : "bridged USDC delivery is below the allocation; operator review" };
      const settledAt = Date.parse(b.settledAt || "");
      if (Number.isFinite(settledAt) && now() - settledAt > DEX_DELIVERY_TIMEOUT_MS) return { ...step, terminal: "bridged USDC not seen in the DEX wallet" };
      return step;
    }
    if (paused) return step;
    step.receipt = await payment(t, job, step.intentId);
    const rc = step.receipt;
    if (rc.stage === "refused") return { ...step, terminal: `DEX payment refused by the guard (${rc.reason || "guard"}); operator review` };
    if (rc.stage === "confirmed" && !confirmed(rc, solana ? "SOL" : "USDC")) return { ...step, terminal: rc.amountMicros === undefined ? "DEX payment confirmed without an amount; operator review" : "DEX payment amount differs from the order; operator review" };
    if (rc.stage === "failed" && payAttempt >= DEX_MAX_ATTEMPTS) return { ...step, terminal: `DEX payment failed on-chain ${DEX_MAX_ATTEMPTS} times; operator review` };
    return step;
  }
  async function verifyOrder({ project, job }) {
    const t=tokenOf(project.token),currency=t.treasury?.chain==='solana'?'SOL':'USDC';
    if (!job.order || !/^[a-f0-9]{24}$/.test(job.order.paylinkId || '')) return {verified:false};
    const r=await call('GET',`/quote?paylinkId=${encodeURIComponent(job.order.paylinkId)}&currency=${currency}`);
    const at=Date.parse(r.json?.checkedAt || '');
    return {verified:r.status===200 && r.json?.verified===true && r.json?.paylinkId===job.order.paylinkId &&
      r.json?.amountMicros===DEX_AMOUNT_MICROS && r.json?.currency===currency && Number.isFinite(at) && at<=now() && now()-at<=30000,
      paylinkId:job.order.paylinkId,amountMicros:r.json?.amountMicros,checkedAt:r.json?.checkedAt};
  }
  async function payOrder({ project, job }) {
    const t = tokenOf(project.token);
    const a = await advance(t, job, { dispatch: true });
    const b = a.bridge;
    if (b && !a.dispatched) throw failure(`DEX allocation bridge was not dispatched (${b.reason || b.state})`, "DEX_BRIDGE_NOT_DISPATCHED", { retryable: true, reason: String(b.reason || b.state) });
    if (b?.state === "invalid") throw failure(`DEX allocation bridge needs review (${b.reason})`, "DEX_BRIDGE_INVALID");
    if (b?.state === "uncertain") throw failure(`DEX allocation bridge outcome unknown (${b.reason})`, "DEX_BRIDGE_UNCERTAIN");
    if (b?.state === "refunded") throw failure("DEX allocation bridge was refunded", "DEX_BRIDGE_REFUNDED");
    if (a.receipt?.stage === "refused") throw failure("DEX payment was refused by the guard", "DEX_PAY_REFUSED");
    if (a.receipt?.stage === "confirmed" && !confirmed(a.receipt,t.treasury?.chain === "solana" ? "SOL" : "USDC")) throw failure("DEX payment amount differs from the order", "DEX_PAY_AMOUNT");
    if (a.terminal) throw failure(a.terminal, "DEX_OPERATOR_REVIEW");
    // The reference is the deterministic pay intent for this attempt.
    return { paymentReference: a.intentId };
  }
  async function verifyPublication(t) {
    try { const v = await call("GET", `/verify?chainId=${encodeURIComponent(t.chain)}&tokenAddress=${encodeURIComponent(t.address)}`); return v.status === 200 && v.json?.published === true; }
    catch { return false; }
  }
  async function reconcile({ job, project = null, paused = false }) {
    const t = tokenOf(project?.token || job.id.split(":").slice(2, 3)[0] || job.token || "");
    const base = { jobId: job.id, paymentVerified: false };
    if (job.terminal === true) return { ...base, terminal: true, reason: typeof job.detail === "string" && job.detail ? job.detail : "operator review required" };
    if (job.state === "settled" || job.paymentVerified === true) {
      // Paid: never touch the bridge or /pay again; only publication and the accounting read.
      const publicationVerified = await verifyPublication(t);
      await refresh(t);
      return { jobId: job.id, orderId: job.order?.orderId, paymentVerified: true, paymentReference: job.paymentReference, actualMicros: job.actualMicros, paidAt: job.paidAt,
        sourceObservedAt: t.treasury.marketingObservedAt, sourceBalanceReconciled: true, publicationVerified };
    }
    if (!job.order) {
      // An order created just before a lost response is recovered through the
      // same order intent; the broker never creates a second one for it.
      try { const order = await prepareOrder({ project: { token: t.address }, job }); return { ...base, recoveredOrder: order }; }
      catch (e) { return { ...base, reason: `DEX order recovery failed (${e.code || e.message})` }; }
    }
    let a;
    try { a = await advance(t, job, { dispatch: false, paused: paused === true }); }
    catch (e) { if (e.code === "DEX_WALLET_UNAVAILABLE") return { ...base, reason: "DEX wallet address unavailable" }; throw e; }
    const b = a.bridge, common = { ...base, attempt: a.attempt, payAttempt: a.payAttempt };
    if (a.terminal) return { ...common, bridgeState: b?.state ?? null, terminal: true, reason: a.terminal };
    if (["none", "unavailable", "released"].includes(b.state)) return { ...common, bridgeState: b.state, restartable: true, reason: String(b.reason || `DEX allocation bridge not dispatched (${b.state})`) };
    if (b.state === "refunded") return { ...common, bridgeState: "refunded", restartable: true, reason: `DEX allocation bridge refunded (attempt ${a.attempt}): ${b.reason || "Relay refund"}` };
    if (b.state === "uncertain") return { ...common, bridgeState: "uncertain", terminal: true, reason: String(b.reason || "bridge dispatch outcome unknown; operator review") };
    if (b.state === "invalid") return { ...common, bridgeState: "invalid", terminal: true, reason: String(b.reason || "bridge record requires operator review") };
    if (b.state !== "settled") return { ...common, bridgeState: b.state, reason: null };
    if (a.deposit?.confirmed !== true) return { ...common, bridgeState: "delivering", reason: null };
    if (paused === true) return { ...common, bridgeState: "delivered", reason: "paused" };
    const rc = a.receipt;
    if (rc.stage === "failed") return { ...common, bridgeState: "paying", payAttempt: a.payAttempt + 1, reason: `DEX payment failed on-chain (attempt ${a.payAttempt}); a new payment intent is scheduled` };
    if (!confirmed(rc, t.treasury?.chain === "solana" ? "SOL" : "USDC")) return { ...common, bridgeState: "paying", reason: rc.stage === "unavailable" ? `DEX payment unavailable (${rc.reason})` : null };
    const publicationVerified = await verifyPublication(t);
    await refresh(t);
    const actualMicros = Number.isSafeInteger(b.actualMicros) && b.actualMicros > 0 ? b.actualMicros : allocationOf(t);
    return { jobId: job.id, orderId: job.order.orderId, paymentVerified: true, paymentReference: a.intentId, actualMicros, bridgeState: "paid", payAttempt: a.payAttempt,
      paidAt: b.settledAt, sourceObservedAt: t.treasury.marketingObservedAt, sourceBalanceReconciled: true, publicationVerified };
  }
  return { prepareOrder, verifyOrder, payOrder, reconcile, dexWallet };
}

/// X account at its independently funded $10 milestone: assigned from the verified pool by the
/// root X broker, then the $10 allocation is debited from the treasury to operations.
export function createSocialPoolAdapter({ call = (m, p, b) => brokerCall(m, p, b, { timeoutMs: 20_000 }), charge = chargeTreasuryOnce, refresh = refreshTreasury, now = Date.now } = {}) {
  const projectId = project => { const t=tokenOf(project.token); return isStagedLaunch(t) && t.chain === 'solana' ? t.address : t.address.toLowerCase(); };
  const debitId = (job) => `package-social:${job.id}`;
  const allocationOf = project => { const amount=packageTerms(tokenOf(project.token))?.socialAccountBudgetMicros || X_ACCOUNT_MICROS; if (![10_000_000,20_000_000].includes(amount) || project.budgetMicros != null && project.budgetMicros !== amount) throw failure('X allocation changed', 'X_BUDGET_MISMATCH'); return amount; };
  // Only a verified pool record (session stored, post verified) is worth the $10 debit.
  const usable = (a, project) => a && typeof a === "object" && /^[a-zA-Z0-9_]{1,15}$/.test(String(a.handle || "")) &&
    /^[1-9][0-9]{0,29}$/.test(String(a.userId || "")) && a.assignedProject === projectId(project) &&
    a.postVerified === true && a.sessionStored === true;
  async function inventory(project) {
    const r = await call("GET", "/accounts");
    if (r.status !== 200 || !Array.isArray(r.json?.accounts)) throw failure("X broker unavailable", "X_BROKER_UNAVAILABLE");
    const matching = r.json.accounts.filter(a => a?.assignedProject === projectId(project));
    if (matching.length > 1) throw failure("Multiple X assignments need review", "X_ASSIGNMENT_CONFLICT");
    const a = matching[0];
    if (a && (!usable(a, project) || r.json.accounts.some(other => other !== a &&
        (String(other?.userId) === String(a.userId) || String(other?.handle).toLowerCase() === a.handle.toLowerCase()))))
      throw failure("Assigned X account identity needs review", "X_ACCOUNT_UNVERIFIED");
    const available = r.json.accounts.some(candidate => candidate && !candidate.assignedProject &&
      /^[a-zA-Z0-9_]{1,15}$/.test(String(candidate.handle || "")) && /^[1-9][0-9]{0,29}$/.test(String(candidate.userId || "")) &&
      candidate.postVerified === true && candidate.sessionStored === true &&
      !r.json.accounts.some(other => other !== candidate && (String(other?.userId) === String(candidate.userId) ||
        String(other?.handle).toLowerCase() === candidate.handle.toLowerCase())));
    return { account: a || null, available };
  }
  async function checkAvailability({ project }) {
    const result = await inventory(project);
    return { available: !!result.account || result.available, reason: result.account || result.available ? null : "X_POOL_EMPTY" };
  }
  async function assigned(project) { return (await inventory(project)).account; }
  async function acquireOne({ project }) {
    let a = await assigned(project);
    if (!a) {
      const r = await call("POST", "/assign", { project: projectId(project) });
      if (r.status !== 200 || !r.json?.handle) throw failure(`No X account available (${r.json?.error || r.status})`, r.json?.error || "X_ASSIGN_FAILED");
      if (!usable(r.json, project)) throw failure("Assigned X account is not verified (post/session)", "X_ACCOUNT_UNVERIFIED");
      a = r.json;
    }
    return { purchaseReference: `pool:${a.handle}` };
  }
  async function reconcile({ project, job, paused = false }) {
    const t = tokenOf(project.token);
    const base = { jobId: job.id, acquisitionVerified: false, paymentVerified: false };
    let a = await assigned(project);
    if (!a) {
      // A paused project acquires nothing; a lost assignment response is otherwise
      // recovered through the broker's idempotent assign (it returns the existing
      // assignment or takes one free account, never replaces an existing one).
      if (paused === true) return { ...base, reason: "paused" };
      const r = await call("POST", "/assign", { project: projectId(project) });
      if (r.status !== 200 || !r.json?.handle) return { ...base, reason: `X assignment unavailable (${r.json?.error || r.status})` };
      if (!usable(r.json, project)) return { ...base, reason: "assigned X account is not verified (post/session); no charge" };
      a = r.json;
    }
    if (!/^[1-9][0-9]{0,29}$/.test(String(a.userId || ""))) return { ...base, reason: "assigned X account has no numeric id" };
    if (paused === true) return { ...base, acquisitionVerified: true, reason: "paused" };
    const allocation = allocationOf(project);
    const previousDebit=t.packageUsageReservations?.[debitId(job)];
    // A reserved/released record proves no dispatch. Retrying it is a new debit
    // and still needs the current runtime and funding gate. Only a committed or
    // settled debit may reach receipt reconciliation after readiness is lost.
    const reconcilingDebit=['submitted','uncertain','settled'].includes(previousDebit?.state);
    if (isStagedLaunch(t) && !reconcilingDebit && !stageFundingOf(t,'social',{now:now()}).ready) return {...base,acquisitionVerified:true,reason:'waiting for the AI computer and available account funding'};
    const debit = await charge(t, { id: debitId(job), micros: allocation, reason: "Project X account (pool)", reservedMicros: allocation, ledgerKey: { socialAccountJobId: job.id } });
    if (!debit.paid) return { ...base, acquisitionVerified: true, reason: typeof debit.reason === "string" ? debit.reason : null };
    await refresh(t);
    return { jobId: job.id, purchaseReference: `pool:${a.handle}`, orderId: X_POOL_ORDER, accountId: String(a.userId), handle: a.handle, paymentReference: debit.tx, actualMicros: allocation,
      acquisitionVerified: true, paymentVerified: true, paidAt: debit.settledAt, sourceObservationStartedAt: t.treasury.marketingObservationStartedAt,
      sourceObservedAt: t.treasury.marketingObservedAt, sourceReconciledAt: new Date(now()).toISOString(), sourceBalanceReconciled: true };
  }
  return { checkAvailability, acquireOne, reconcile };
}
