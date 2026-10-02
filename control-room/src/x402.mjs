// Pay-per-request AI through NanoGPT's accountless x402 rail: no account, no API key.
// Every chat completion is quoted, the token's treasury signs an EIP-3009 USDC
// authorization for exactly the quoted amount, and the request is replayed with it.
// Money leaves the treasury only through this signature — bounded by the quote's
// amount, valid for minutes, single-use by nonce.
import { ethers } from "ethers";
import { env } from "./env.mjs";
import { USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES, USDC_BASE } from "./chain.mjs";
import { signTypedDataAsTreasury, solanaTreasurySigner } from "./wallets.mjs";
import * as rail from "./solana.mjs";
import { solanaRpc } from "./solana-billing.mjs";

const NANO = env("NANOGPT_X402_BASE", "https://nano-gpt.com/api/v1");
export const X402_PROVIDER = "nanogpt-x402";
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

async function post(path, body, headers = {}) {
  const res = await fetch(`${NANO}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000), redirect: "error",   // NanoGPT never redirects; a redirect would leave its origin
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text, headers: res.headers };
}

/// Asks the price of a request. Returns the "exact" USDC requirement on `network`:
/// 'base' (EIP-3009 authorization, EVM treasuries) or 'solana' (SPL transfer the treasury
/// signs, NanoGPT's facilitator pays the fee — Solana treasuries).
export async function quote(body, { network = "base" } = {}) {
  if (!["base", "solana"].includes(network)) throw fail(400, "unsupported x402 network");
  const r = await post("/chat/completions", { ...body, stream: false }, { "x-x402": "true" });
  if (r.status !== 402 || !r.json?.payment) throw fail(502, `NanoGPT did not return a quote (${r.status}): ${(r.json?.error?.message || r.text).slice(0, 160)}`);
  const req = (r.json.accepts || []).find((a) => a.scheme === "exact" && a.network === network);
  const opt = (r.json.payment.accepted || []).find((a) => a.network === network && (network === "base" ? a.scheme === "x402-exact" : a.scheme === "x402-solana-usdc"));
  if (!req || !opt) throw fail(502, `NanoGPT offered no ${network === "base" ? "Base" : "Solana"} USDC exact payment option`);
  const expiresAt = Number(req.expiresAt) > 1e12 ? Math.floor(Number(req.expiresAt) / 1000) : Number(req.expiresAt);
  const amountMicros = Number(req.maxAmountRequired ?? req.amount), amountUsd = Number(req.maxAmountRequiredUSD ?? opt.amountUsd ?? 0);
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw fail(502, "NanoGPT quote carries no usable amount");
  if (network === "solana") {
    const asset = String(req.asset || req.extra?.tokenAddress || "");
    if (asset !== rail.USDC_MINT || !rail.isSolanaAddress(req.payTo) || !rail.isSolanaAddress(req.extra?.feePayer)) throw fail(502, "quote is not for Solana USDC with a facilitator fee payer");
    return { network, payTo: req.payTo, feePayer: req.extra.feePayer, amountMicros, amountUsd, expiresAt, paymentId: req.paymentId };
  }
  if (String(req.extra?.tokenAddress || "").toLowerCase() !== USDC_BASE.toLowerCase() || Number(req.extra?.chainId) !== USDC_DOMAIN.chainId) throw fail(502, "quote is not for Base USDC");
  return {
    network, payTo: ethers.getAddress(req.payTo), amountMicros, amountUsd, expiresAt,
    paymentId: req.paymentId, domain: { name: req.extra?.name || USDC_DOMAIN.name, version: req.extra?.version || USDC_DOMAIN.version, chainId: USDC_DOMAIN.chainId, verifyingContract: USDC_BASE },
  };
}

export const X402_SOLANA_COMPUTE_UNIT_LIMIT = 100_000;
export const X402_SOLANA_COMPUTE_UNIT_PRICE = 1_000;   // µlamports/CU, well under the facilitator's ceiling
/// The Solana leg: a v0 transaction whose fee payer is NanoGPT's facilitator and whose only
/// value movement is ONE TransferChecked of exactly the quoted USDC from the treasury's
/// account to NanoGPT's. The treasury partially signs; nothing is sent by us — the
/// facilitator submits it when it accepts the X-PAYMENT.
export async function buildSolanaPayment(tokenAddress, treasury, q, { rpc = solanaRpc(), signer = null } = {}) {
  const s = signer || solanaTreasurySigner(tokenAddress);
  if (s.address !== treasury) throw fail(500, "treasury signer does not match the treasury wallet");
  const toAta = await rail.ataOf(q.payTo);
  if (!(await rpc.getAccountInfo(toAta))) throw fail(502, "NanoGPT's USDC account does not exist; refusing to pay rent for it");
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const nonce = ethers.hexlify(ethers.randomBytes(16)).slice(2);
  const built = await rail.buildTransfer({ from: treasury, to: q.payTo, usdcMicros: q.amountMicros, blockhash, lastValidBlockHeight, feePayer: q.feePayer, computeUnitLimit: X402_SOLANA_COMPUTE_UNIT_LIMIT, computeUnitPrice: X402_SOLANA_COMPUTE_UNIT_PRICE, memo: `x402:${nonce}` });
  const signed = await rail.partialSign(built, s);
  return { wire: signed.wire, signature: signed.signature, nonce, blockhash, lastValidBlockHeight, toAta };
}

/// Signs the quoted amount from the token's treasury and replays the request.
export async function payAndComplete(tokenAddress, treasury, body, q, onAuthorization = null, deps = {}) {
  if (q.network === "solana") {
    const p = await buildSolanaPayment(tokenAddress, treasury, q, deps);
    if (onAuthorization) await onAuthorization({ network: "solana", paymentId: q.paymentId || null, nonce: p.nonce, validBefore: String(q.expiresAt || 0), payTo: q.payTo, amountMicros: q.amountMicros, signature: p.signature });
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: p.wire } })).toString("base64");
    return replay(body, header, q);
  }
  const authorization = {
    from: ethers.getAddress(treasury), to: q.payTo, value: String(q.amountMicros),
    validAfter: "0", validBefore: String(Math.max(q.expiresAt || 0, Math.floor(Date.now() / 1000) + 300)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await signTypedDataAsTreasury(tokenAddress, q.domain, TRANSFER_WITH_AUTH_TYPES, {
    ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore),
  });
  // Persist public reconciliation identifiers before sending a paid request.
  // Never hand the caller the signature or wallet key.
  if (onAuthorization) await onAuthorization({ network: "base", paymentId: q.paymentId || null, nonce: authorization.nonce, validBefore: authorization.validBefore, payTo: authorization.to, amountMicros: q.amountMicros });
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } })).toString("base64");
  return replay(body, header, q);
}
async function replay(body, header, q) {
  const r = await post("/chat/completions", { ...body, stream: false }, { "X-PAYMENT": header });
  if (r.status !== 200) {
    // 402 to a submitted payment = the provider did not accept it and nothing was settled (a settled
    // payment always carries X-PAYMENT-RESPONSE). The caller releases its hold instead of carrying an
    // "uncertain" liability. Seen live 2026-09-22: NanoGPT's Solana facilitator (Coinbase CDP) refused
    // every payment with "payment_method_required" — an account problem on NanoGPT's side.
    const refused = r.status === 402 && !r.headers.get("x-payment-response");
    throw fail(r.status === 402 ? 402 : 502, `NanoGPT payment/replay failed (${r.status}): ${(r.json?.error?.message || r.text).slice(0, 200)}`, refused ? { settled: false, code: "payment_refused" } : {});
  }
  let settlement = null;
  const pr = r.headers.get("x-payment-response");
  if (pr) { try { settlement = JSON.parse(Buffer.from(pr, "base64").toString("utf8")); } catch { settlement = { raw: pr.slice(0, 120) }; } }
  return { json: r.json, paidMicros: q.amountMicros, amountUsd: q.amountUsd, settlement };
}

// ── NanoGPT's direct Base USDC rail ("base-usdc", no facilitator) ─────────────────────────────
// The quote names a unique deposit address per request; the payer sends USDC there itself (its own
// gas), then POSTs completeUrl, which replays the stored request once NanoGPT sees the transfer.
// No Coinbase facilitator is involved — the rail that kept working on 2026-09-23 when both x402
// "exact" rails were refused with payment_method_required on NanoGPT's CDP account.
const NANO_ORIGIN = () => new URL(NANO).origin;
const sameOriginUrl = (value, label, pathPrefix) => {
  let u; try { u = new URL(String(value || "")); } catch { throw fail(502, `NanoGPT ${label} is not a URL`); }
  if (u.origin !== NANO_ORIGIN() || u.protocol !== "https:") throw fail(502, `NanoGPT ${label} is not on NanoGPT's origin`);
  if (!u.pathname.startsWith(pathPrefix) || u.search || u.hash) throw fail(502, `NanoGPT ${label} is not a payment route`);
  return u.href;
};
export async function quoteDirect(body) {
  const r = await post("/chat/completions", { ...body, stream: false }, { "x-x402": "true" });
  if (r.status !== 402 || !r.json?.payment) throw fail(502, `NanoGPT did not return a quote (${r.status}): ${(r.json?.error?.message || r.text).slice(0, 160)}`);
  const acc = (r.json.payment.accepted || []).find((a) => a.scheme === "base-usdc" && a.network === "base");
  const req = (r.json.accepts || []).find((a) => a.scheme === "usdc-base" && a.network === "base");
  if (!acc || !req) throw fail(502, "NanoGPT offered no direct Base USDC option");
  if (String(req.extra?.tokenAddress || "").toLowerCase() !== USDC_BASE.toLowerCase() || Number(req.extra?.chainId) !== USDC_DOMAIN.chainId) throw fail(502, "direct quote is not for Base USDC");
  const payTo = ethers.getAddress(acc.payTo);
  if (ethers.getAddress(req.payTo) !== payTo) throw fail(502, "direct quote deposit address disagrees");
  const amountMicros = Number(req.maxAmountRequired ?? acc.amount);
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0 || String(acc.amount) !== String(amountMicros)) throw fail(502, "direct quote carries no usable amount");
  const expiresAt = Number(req.expiresAt) > 1e12 ? Math.floor(Number(req.expiresAt) / 1000) : Number(req.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now() + 60_000) throw fail(502, "direct quote expires too soon");
  return { rail: "base-direct", paymentId: String(acc.paymentId || req.paymentId || ""), payTo, amountMicros, amountUsd: Number(acc.amountUsd || req.maxAmountRequiredUSD || 0), expiresAt,
    statusUrl: sameOriginUrl(acc.statusUrl, "status URL", "/api/x402/status/"), completeUrl: sameOriginUrl(acc.completeUrl, "completion URL", "/api/x402/complete/"), requestHash: r.json.payment.requestHash || null };
}
/// After the USDC transfer: POST completeUrl until NanoGPT has seen the deposit (it answers 402
/// "not verified" meanwhile; statusUrl says how long to wait). Returns { json, settlement }.
export async function completeDirect(q, { fetchImpl = fetch, deadlineMs = 120_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now();
  let last = null, waitMs = 3_000;
  while (now() - t0 < deadlineMs) {
    const res = await fetchImpl(q.completeUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(180_000), redirect: "error" });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    if (res.status === 200 && json?.choices) return { json, settlement: { direct: true, paymentId: q.paymentId, success: true } };
    last = { status: res.status, message: String(json?.message || json?.error || text).slice(0, 200), state: String(json?.status || "") };
    if (res.status !== 402 && res.status !== 409) throw fail(502, `NanoGPT direct completion failed (${res.status}): ${last.message}`);
    if (/expired/i.test(last.message) || last.state === "expired") throw fail(502, `NanoGPT direct payment expired before completion: ${last.message}`);
    try {
      const st = await fetchImpl(q.statusUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000), redirect: "error" });
      const sj = await st.json().catch(() => null);
      const hint = Number(sj?.pollAfterSeconds); if (Number.isFinite(hint) && hint > 0) waitMs = Math.min(10_000, Math.max(1_000, hint * 1000));
    } catch {}
    await sleep(waitMs);
  }
  throw fail(504, `NanoGPT direct completion not confirmed within ${Math.round(deadlineMs / 1000)} s: ${last?.message || "no answer"}`, { code: "payment_unconfirmed" });
}
