// The token economy, simulated: fee income into the treasury, the VPS billed per
// hour, AI billed per call, budget states, epoch chat quotas and holder voting.
// Money is kept in integer micro-dollars so repeated charges never drift.
import { ethers } from "ethers";
import { isAddress as isSolanaAddress } from "@solana/addresses";
import { get, event } from "./store.mjs";
import { payloadHash } from "./canonical.mjs";
import { createAgentWallet, createHolderWallet, createTreasuryWallet, createPlaceholderAddress } from "./wallets.mjs";
import { requirePublicText } from "./public-safety.mjs";
import { PROPOSAL_TYPES, checkProposal } from "./rules.mjs";
import { PROFILE_TYPE, validateNewProfileProposal, applyApprovedProfile } from './project-profile.mjs';
import { usageOf } from "./usage-budget.mjs";
import { catalogPrices } from "./providers.mjs";
import { pumpCreatorFee, PUMP_CURVE_CREATOR_FEE_BPS } from "./solana-market.mjs";
import { packageReserveMicros, isPackageFunded, activationRequirementMicros } from './launch-package.mjs';
import { isDexType, validateNewDexProposal } from './dex-policy.mjs';
import { assertGovernanceSnapshot, needsChainVerification } from './governance-guard.mjs';
import { isWalletType, validateNewWalletProposal, finalizeWalletProposal } from './wallet-proposals.mjs';
import { chatAudience, chatRules } from './chat-policy.mjs';
import {isLaunchType,validateNewLaunchProposal,finalizeLaunchProposal} from './community-actions.mjs';
import { runtimeAiAvailabilityOf } from './runtime-budget.mjs';

export const MICRO = 1_000_000;
export const usd = (micros) => Number(micros) / MICRO;
export const toMicros = (dollars) => Math.round(Number(dollars) * MICRO);
const HOUR = 3_600_000;
const SUPPLY = 1_000_000_000;

const simIso = (s) => new Date(s.clock.simMs).toISOString();
const id = (prefix) => `${prefix}_${ethers.hexlify(ethers.randomBytes(6)).slice(2)}`;

// 792703809 is Relay's id for Solana mainnet (relay.mjs SOLANA_CHAIN_ID); a truthy id keeps chat sessions and wallet DTOs working.
const CHAIN_IDS = { base: 8453, ethereum: 1, arbitrum: 42161, optimism: 10, polygon: 137, bsc: 56, robinhood: 4663, solana: 792703809 };
export const chainIdOf = (key) => CHAIN_IDS[String(key).toLowerCase()] ?? null;

// ── token / holder identity across chains ─────────────────────────────────────
// EVM ids are case-insensitive and stored lowercased; Solana mints and wallets are
// base58 and case-sensitive, so they are stored exactly as given.
export const TOKEN_RE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";
export const isSolanaChain = (chainOrToken) => (typeof chainOrToken === "string" ? chainOrToken : chainOrToken?.chain) === "solana";
export const tokenKey = (chain, address) => chain === 'solana' ? String(address) : String(address).toLowerCase();
/// Key of a holder inside one token's maps (balances, epoch, votes).
export const holderKey = (t, holder) => tokenKey(t?.chain, holder);
/// Key of a wallet in maps shared across chains (profiles): 0x lowercased, base58 as is.
export const addressKey = (address) => EVM_ADDRESS_RE.test(String(address)) ? String(address).toLowerCase() : String(address);
/// Wallets that hold tokens but are not community members: the Pons curve on EVM;
/// pool vaults, the pair, the burn address and the treasury on Solana.
export function excludedHoldersOf(t) {
  const list = Array.isArray(t.excludedHolders) && t.excludedHolders.length ? t.excludedHolders : (t.curveAddress ? [t.curveAddress] : []);
  return list.filter((a) => typeof a === "string" && a).map((a) => holderKey(t, a));
}
export const isExcludedHolder = (t, holder) => excludedHoldersOf(t).includes(holderKey(t, holder));
/// Whole-token ↔ base-unit conversion: 18 decimals on EVM, the mint's decimals on Solana.
export const decimalsOf = (t) => t?.chain === 'solana' ? Number(t.onchain?.decimals ?? t.decimals ?? 9) : 18;
export function toBaseUnits(t, whole) {
  const d = decimalsOf(t);
  try { return ethers.parseUnits(String(whole), d).toString(); }
  catch { return (BigInt(Math.floor(Number(whole) || 0)) * 10n ** BigInt(d)).toString(); }
}
export const fromBaseUnits = (t, units) => Number(ethers.formatUnits(BigInt(units || 0), decimalsOf(t)));
/// The simulated curve that sim-mode holder helpers move supply from.
const simCurve = (t) => { if (!t.curveAddress) throw Object.assign(new Error("this project has no simulated curve"), { status: 400 }); return t.curveAddress.toLowerCase(); };

export function tokenOf(address) {
  const a = String(address);
  const t = get().tokens[/^0x/i.test(a) ? a.toLowerCase() : a];
  if (!t) throw Object.assign(new Error("unknown token"), { status: 404 });
  return t;
}

function ledger(s, t, deltaMicros, reason) {
  t.treasury.micros += deltaMicros;
  t.treasury.ledger.unshift({ simAt: simIso(s), deltaMicros, balanceMicros: t.treasury.micros, reason });
  if (t.treasury.ledger.length > 400) t.treasury.ledger.length = 400;
}

export function createToken({ name, symbol, chain = "robinhood", domain, treasuryUsd = 50, volumeUsdPerHour = 2000, treasuryMode = "sim", onchain = null, treasuryWallet = null }) {
  const s = get();
  if (!name || !symbol) throw Object.assign(new Error("name and symbol are required"), { status: 400 });
  const solana = chain === "solana";
  let address, curve;
  if (solana) {
    // A Solana project IS its SPL mint (base58, case preserved); there is no curve, the
    // AMM pair is discovered by the market indexer. Nothing is simulated on Solana.
    const mint = onchain?.mint || onchain?.token;
    if (!mint || !isSolanaAddress(String(mint))) throw Object.assign(new Error("a valid Solana mint address is required"), { status: 400 });
    address = String(mint); curve = onchain?.pool || onchain?.pair || null;
    if (curve && !isSolanaAddress(String(curve))) throw Object.assign(new Error("invalid Solana pool address"), { status: 400 });
    if (treasuryMode === "wallet" && !isSolanaAddress(String(treasuryWallet || ""))) throw Object.assign(new Error("a Solana treasury wallet is required"), { status: 400 });
  } else {
    // A Pons-launched token IS the on-chain contract; a simulated one gets placeholder addresses (keys kept).
    address = onchain?.token ? ethers.getAddress(onchain.token) : createPlaceholderAddress(`token ${symbol}`);
    curve = onchain?.curve ? ethers.getAddress(onchain.curve) : createPlaceholderAddress(`curve ${symbol}`);
  }
  const key = tokenKey(chain, address);
  if (s.tokens[key]) throw Object.assign(new Error("this token is already a channel"), { status: 409 });
  const sym = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  const t = {
    address, name: String(name).slice(0, 40), symbol: sym, chain, domain: domain || `${sym.toLowerCase()}-agent.xyz`,
    createdSimAt: simIso(s), supply: solana ? Number(onchain?.supply ?? 0) || 0 : SUPPLY, curveAddress: curve, balances: onchain ? {} : { [curve.toLowerCase()]: SUPPLY },
    ...(solana ? { excludedHolders: [SOLANA_BURN_ADDRESS, ...(treasuryMode === "wallet" ? [String(treasuryWallet)] : []), ...(curve ? [curve] : [])] } : {}),
    volumeUsdPerHour: Number(volumeUsdPerHour) || 0,
    // "sim": a number this simulation moves. "wallet": a real wallet holders fund;
    // its balance is read from the chain and money leaves it only for AI and VPS hours.
    onchain: onchain ? (solana ? { ...onchain, chain: "solana", mint: address, decimals: onchain.decimals ?? null } : { pons: true, ...onchain }) : null,
    governanceVersion: onchain ? 2 : 1,
    treasury: treasuryMode === "wallet"
      ? (solana
        ? { mode: "wallet", chain: "solana", wallet: String(treasuryWallet), micros: 0, solLamports: 0, solUsd: 0, solMicros: 0, usdcMicros: 0, ledger: [] }
        : { mode: "wallet", wallet: treasuryWallet || createTreasuryWallet(address), micros: 0, usdgMicros: 0, usdcMicros: 0, robinhoodEth: 0, ledger: [] })
      : { mode: "sim", micros: 0, ledger: [] },
    agent: {
      wallet: createAgentWallet(address),
      farcaster: { username: `${sym.toLowerCase()}-agent`, fid: 100000 + Math.floor(Math.random() * 900000), bio: "", displayName: `${sym} Agent`, avatarUrl: null },
      state: "not_started", lastHeartbeatAt: null, firstHeartbeatAt: null, currentProposalId: null,
    },
    vps: { mode: null, state: "stopped", phase: "stopped", instanceId: null, hourlyMicros: 0, offer: null, startedSimAt: null, streamLive: false, log: [] },
    epoch: { index: 0, startedSimMs: s.clock.simMs, chatPoolMicros: 0, weights: {}, used: {}, accum: {} },
    messages: [], replies: [], proposals: [], suggestions: [], casts: [], statusLog: [],
    website: { content: `${name} (${sym}) — an AI agent project on Autonom. Operated by an AI agent.`, version: 0, updatedSimAt: simIso(s) },
  };
  s.tokens[key] = t;
  if (t.treasury.mode === "sim") ledger(s, t, toMicros(treasuryUsd), "initial treasury (simulated deposit)");
  rollEpoch(t, s);
  event("token", `Token ${sym} launched`, { token: address });
  return t;
}

// ── holders ───────────────────────────────────────────────────────────────────

export function eligibleSupply(t) {
  const excluded = excludedHoldersOf(t);
  return Object.entries(t.balances).reduce((sum, [a, b]) => (excluded.includes(a) ? sum : sum + b), 0);
}

export function addHolders(address, count = 5) {
  const s = get(), t = tokenOf(address);
  const curve = simCurve(t);
  const out = [];
  for (let i = 0; i < Math.min(50, Number(count) || 0); i++) {
    const holder = createHolderWallet().toLowerCase();
    const amount = Math.floor((0.2 + Math.random() * 4.8) * 1_000_000);   // 0.02%–0.5% of supply
    if (t.balances[curve] < amount) break;
    t.balances[curve] -= amount;
    t.balances[holder] = (t.balances[holder] || 0) + amount;
    const tradeUsd = amount / SUPPLY * 50_000;                          // notional price for fee simulation
    ledger(s, t, Math.round(tradeUsd * s.settings.feeBps / 10_000 * s.settings.treasuryShareBps / 10_000 * MICRO), `buy fee from ${holder.slice(0, 8)}`);
    out.push(holder);
  }
  if (!Object.keys(t.epoch.weights).length) rollEpoch(t, s, { keepIndex: true });
  event("holders", `${out.length} holders bought ${t.symbol}`, { token: t.address });
  return out;
}

/// A holder sells `fraction` of their bag back to the curve (moves votes and quota next epoch).
export function sellHolder(address, holder, fraction = 1) {
  const s = get(), t = tokenOf(address);
  const h = holderKey(t, holder), curve = simCurve(t);
  const amount = Math.floor((t.balances[h] || 0) * Math.min(1, Math.max(0, fraction)));
  if (!amount) throw Object.assign(new Error("nothing to sell"), { status: 400 });
  t.balances[h] -= amount;
  t.balances[curve] += amount;
  ledger(s, t, Math.round(amount / SUPPLY * 50_000 * s.settings.feeBps / 10_000 * s.settings.treasuryShareBps / 10_000 * MICRO), `sell fee from ${h.slice(0, 8)}`);
  return amount;
}

// ── epochs and quotas ─────────────────────────────────────────────────────────

function rollEpoch(t, s, { keepIndex = false } = {}) {
  const excluded = excludedHoldersOf(t);
  const accumTotal = Object.values(t.epoch.accum).reduce((a, b) => a + b, 0);
  // Time-weighted: last epoch's average holding decides this epoch's share, so buying
  // right before a rollover and selling after earns nothing. The first epoch (no
  // history yet) falls back to current balances.
  const basis = accumTotal > 0 ? t.epoch.accum : Object.fromEntries(Object.entries(t.balances).filter(([a]) => !excluded.includes(a)));
  const total = Object.values(basis).reduce((a, b) => a + b, 0);
  const weights = {};
  for (const [a, v] of Object.entries(basis)) if (v > 0 && total > 0) weights[a] = v / total;
  t.epoch = {
    index: keepIndex ? t.epoch.index : t.epoch.index + 1,
    ...(keepIndex && t.epoch.realStartedAt ? { realStartedAt: t.epoch.realStartedAt } : {}),
    startedSimMs: s.clock.simMs,
    chatPoolMicros: Math.max(0, Math.floor(t.treasury.micros * chatShareBpsOf(t, s) / 10_000)),
    weights, used: keepIndex ? t.epoch.used : {}, accum: keepIndex ? t.epoch.accum : {},
  };
}

/// The market indexer opens the first epoch once real holders exist.
export function rollEpochFor(t) { rollEpoch(t, get(), { keepIndex: true }); }

export function quotaOf(t, holder) {
  return usageOf(t, holder);
}
/// The holder's AI share as the page and Kurt's refusals describe it: the money, the same money as
/// prompt tokens at the project's model price (the number a holder can picture), what one answer
/// has recently cost and how many of those are left, and when the period renews.
export function allowanceOf(t, holder) {
  const q = usageOf(t, holder), model = t.agent?.ai?.model || null, { promptUsd } = catalogPrices(model);
  const aiAvailability = runtimeAiAvailabilityOf(t);
  const spendableMicros = Math.min(q.remainingMicros, aiAvailability.availableMicros);
  const tokens = (micros) => (promptUsd > 0 ? Math.floor(micros / promptUsd) : null);
  const recent = Object.values(t.usageReservations || {}).filter((r) => r.kind === "ai" && r.state === "settled" && Number.isSafeInteger(r.actualMicros) && r.actualMicros > 0).slice(-5);
  const perAnswerMicros = recent.length ? Math.ceil(recent.reduce((n, r) => n + r.actualMicros, 0) / recent.length) : null;
  const renewsAt = t.treasury?.mode === "wallet" && t.epoch?.realStartedAt ? new Date(t.epoch.realStartedAt + (get().settings.epochHours || 24) * 3_600_000).toISOString() : null;
  return { ...q, model, tokensLeft: tokens(q.remainingMicros), tokensTotal: tokens(q.totalMicros), perAnswerMicros,
    answersLeft: perAnswerMicros ? Math.floor(q.remainingMicros / perAnswerMicros) : null, renewsAt, exhausted: q.remainingMicros <= 0,
    aiAvailability, spendableMicros, spendableTokens: tokens(spendableMicros) };
}
/// One sentence a holder can act on: how much is left, in tokens and dollars, and when it renews.
export function allowanceText(a) {
  const n = (x) => (Number.isSafeInteger(x) ? x.toLocaleString("en-US") : "0"), usd = (m) => "$" + ((m || 0) / 1e6).toFixed(2);
  const when = a.renewsAt ? `It renews at ${a.renewsAt.slice(11, 16)} UTC` : "It renews with the next period";
  return a.exhausted
    ? `Your AI share is used up: ${n(a.tokensLeft)} tokens left of ${n(a.tokensTotal)} today (${usd(a.usedMicros)} of ${usd(a.totalMicros)} used). ${when} or when the treasury grows.`
    : `Your AI share: ${n(a.tokensLeft)} tokens left of ${n(a.tokensTotal)} today (${usd(a.remainingMicros)} of ${usd(a.totalMicros)}). ${when}.`;
}

/// The share of the treasury the community may spend on chat per period: the global setting, or a
/// per-project override the operator files in t.usageSettings.chatShareBps (0–10000).
export function chatShareBpsOf(t, s = get()) {
  const raw = t?.usageSettings?.chatShareBps, own = typeof raw === "number" ? raw : NaN;   // a number, never text
  return Number.isInteger(own) && own >= 0 && own <= 10_000 ? own : s.settings.chatShareBps;
}
export function initializeUsagePool(t) {
  if (t.treasury.micros > 0 && t.epoch.chatPoolMicros === 0 && Object.values(t.epoch.used).every(n => n === 0)) {
    if (!Object.keys(t.epoch.weights).length) rollEpoch(t, get(), { keepIndex: true });
    else t.epoch.chatPoolMicros = Math.max(0, Math.floor(t.treasury.micros * chatShareBpsOf(t, get()) / 10_000));
  }
}

// Wallet-mode communities do not run the simulator clock. Start their usage
// period on upgrade, preserving existing usage, then renew from current holdings.
// Missed periods never stack allowances. Pending payment liabilities survive.
export function refreshUsagePeriod(t, now = Date.now()) {
  if (t.treasury.mode !== 'wallet') return;
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid usage clock');
  if (!t.epoch.realStartedAt) t.epoch.realStartedAt = now;
  const duration = get().settings.epochHours * HOUR;
  if (now - t.epoch.realStartedAt >= duration) {
    rollEpoch(t, { ...get(), clock: { simMs: now } });
    t.epoch.realStartedAt = now;
  }
  initializeUsagePool(t);
}

function spendQuota(s, t, holder, micros) {
  const q = quotaOf(t, holder);
  if (q.remainingMicros < micros) throw Object.assign(new Error(`quota exhausted for this epoch (remaining $${usd(q.remainingMicros).toFixed(4)})`), { status: 402 });
  t.epoch.used[holderKey(t, holder)] = q.usedMicros + micros;
}

// ── budget ────────────────────────────────────────────────────────────────────

export function budgetOf(t) {
  const s = get();
  const aiAvailability = runtimeAiAvailabilityOf(t);
  const since = s.clock.simMs - 24 * HOUR;
  const aiLast24 = t.treasury.ledger.filter((e) => e.reason.startsWith("AI request") && Date.parse(e.simAt) >= since)
    .reduce((a, e) => a - e.deltaMicros, 0);
  const burnPerHour = (t.vps.state === "running" ? t.vps.hourlyMicros : 0) + aiLast24 / 24;
  const remaining = t.treasury.micros;
  const operating = Math.max(0, remaining - packageReserveMicros(t));
  const runwayHours = burnPerHour > 0 ? operating / burnPerHour : null;
  let status = "normal";
  if (operating <= 0) status = "exhausted";
  else if (operating < toMicros(s.settings.lowBudgetUsd) || (runwayHours != null && runwayHours < 24)) status = "low";
  // A real treasury with a running VPS must cover the NEXT hour, or it is out.
  if (t.treasury.mode === "wallet" && t.vps.state === "running" && t.vps.hourlyMicros > 0 && operating < t.vps.hourlyMicros) status = "exhausted";
  return {
    status, remainingMicros: remaining, operatingMicros: operating, launchReservedMicros: packageReserveMicros(t), burnPerHourMicros: Math.round(burnPerHour), runwayHours: runwayHours == null ? null : Math.floor(runwayHours),
    // A wallet treasury can buy AI when a pocket holds USDC (Solana, Base) or native value can refill one.
    aiRequestsAllowed: aiAvailability.status === 'ready' && aiAvailability.availableMicros > 0 && status !== "exhausted" && (t.treasury.mode !== "wallet" || (t.treasury.usdcMicros || 0) > 0 || (t.treasury.basePocket?.usdcMicros || 0) > 0 || (t.treasury.ethMicros || 0) > 500_000 || (t.treasury.solMicros || 0) > 500_000),
    aiAvailability, aiAvailableMicros: aiAvailability.availableMicros,
    mode: t.treasury.mode, wallet: t.treasury.wallet || null,
    validUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

/// What the token has spent so far and how much is left in its treasury, in the units
/// the operator asks about: dollars, AI tokens and VPS hours (the last 24 h separately).
export function spendStats(t) {
  const now = Date.now(), day = now - 24 * HOUR;
  const aiAvailability = runtimeAiAvailabilityOf(t, { now });
  const sum = (entries) => entries.reduce((a, e) => {
    const isAi = e.reason.startsWith("AI request"), isVps = e.reason.startsWith("VPS hour");
    if (isAi) { a.aiUsd += -e.deltaMicros / MICRO; a.aiRequests++; a.promptTokens += e.promptTokens || 0; a.completionTokens += e.completionTokens || 0; }
    if (isVps) { a.vpsUsd += -e.deltaMicros / MICRO; a.vpsHours++; }
    return a;
  }, { aiUsd: 0, aiRequests: 0, promptTokens: 0, completionTokens: 0, vpsUsd: 0, vpsHours: 0 });
  const spent = t.treasury.ledger.filter((e) => e.deltaMicros < 0);
  const total = sum(spent), last24h = sum(spent.filter((e) => Date.parse(e.simAt) >= day));
  const treasuryUsd = t.treasury.micros / MICRO;
  const operatingUsd = Math.max(0, t.treasury.micros - packageReserveMicros(t)) / MICRO;
  const aiAvailableUsd = aiAvailability.availableMicros / MICRO;
  const ai = t.plan || t.agent.ai || {};
  const hourly = t.vps.state === "running" ? t.vps.hourlyMicros / MICRO : (t.plan?.offer?.dph ?? 0);
  // Blended $ per token at the agent's usual 10:1 prompt:completion mix.
  const perToken = ai.promptUsd != null ? (10 * ai.promptUsd + ai.completionUsd) / 11 / 1e6 : null;
  const dailyUsd = t.plan?.dailyUsd ?? (hourly * 24 + (last24h.aiUsd || 0));
  const round = (n, d = 2) => Number(Number(n).toFixed(d));
  return {
    total: { ...total, aiUsd: round(total.aiUsd, 4), vpsUsd: round(total.vpsUsd, 4) },
    last24h: { ...last24h, aiUsd: round(last24h.aiUsd, 4), vpsUsd: round(last24h.vpsUsd, 4) },
    treasuryUsd: round(treasuryUsd),
    remaining: {
      vpsHours: hourly > 0 ? Math.floor(operatingUsd / hourly) : null,
      aiTokensM: perToken ? round(aiAvailableUsd / perToken / 1e6, 2) : null,
      aiRequests: perToken ? Math.floor(aiAvailableUsd / (perToken * 11_000)) : null,
      days: dailyUsd > 0 ? round(operatingUsd / dailyUsd, 1) : null,
      dailyUsd: round(dailyUsd),
    },
    aiAvailability,
    model: ai.model || null, hourlyUsd: hourly, perMillionTokensUsd: perToken ? round(perToken * 1e6, 3) : null,
  };
}

/// Where the money that unlocks the agent comes from, and how far it is: creator tax
/// collected on the curve (chain), direct deposits, what was already spent, and the
/// gap to the threshold. Shown on the channel so holders see "$12 of $87 so far".
export function fundingOf(t) {
  const treasuryUsd = (t.treasury.micros || 0) / MICRO;
  const ethUsd = (t.chain === "solana" ? t.treasury.solUsd : t.treasury.ethUsd) || 0;   // the quote unit's price: SOL on Solana
  const spentUsd = t.treasury.ledger.filter((e) => e.deltaMicros < 0).reduce((a, e) => a - e.deltaMicros / MICRO, 0);
  let taxEth = 0, taxTrades = 0;
  // Pons trades carry their creator tax from the chain; pump.fun curve trades pay the flat creator fee.
  if (t.market?.trades) { for (const x of t.market.trades) { const fee = x.creatorTaxEth ?? pumpCreatorFee(x, t) ?? 0; taxEth += fee; if (fee) taxTrades++; } }
  const simTaxUsd = t.onchain ? 0 : t.treasury.ledger.filter((e) => /^(buy|sell) fee from/.test(e.reason)).reduce((a, e) => a + e.deltaMicros / MICRO, 0);
  const taxUsd = t.onchain ? taxEth * ethUsd : simTaxUsd;
  const collectedUsd = treasuryUsd + spentUsd;                       // everything that ever arrived
  const depositsUsd = Math.max(0, collectedUsd - taxUsd);
  const need = t.plan ? activationRequirementMicros(t) / MICRO : null;
  const r = (n) => Number(Number(n).toFixed(2));
  return {
    state: !t.plan ? "no_plan" : (t.lock?.state || "locked"), activationUsd: need,
    treasuryUsd: r(treasuryUsd), collectedUsd: r(collectedUsd), taxUsd: r(taxUsd), taxEth: Number(taxEth.toFixed(9)), taxTrades, creatorTaxBps: t.onchain?.creatorTaxBps ?? t.market?.creatorTaxBps ?? (t.onchain?.pump && !t.market?.price?.graduated ? PUMP_CURVE_CREATOR_FEE_BPS : null),
    depositsUsd: r(depositsUsd), spentUsd: r(spentUsd), missingUsd: isPackageFunded(t) ? 0 : need ? r(Math.max(0, need - treasuryUsd)) : null, progress: isPackageFunded(t) ? 1 : need ? Math.min(1, treasuryUsd / need) : 0,
    ethUsd, wallet: t.treasury.wallet || null, hourlyUsd: t.plan?.offer?.dph ?? null, dailyUsd: t.plan?.dailyUsd ?? null,
  };
}

/// Gives a specific address a share of the supply from the curve (a demo holder,
/// e.g. the operator's own wallet, so they can message and vote from the public page).
export function addHolderAddress(address, holder, sharePct = 1) {
  const s = get(), t = tokenOf(address);
  const h = ethers.getAddress(String(holder)).toLowerCase(), curve = simCurve(t);
  const amount = Math.floor(SUPPLY * Math.min(20, Math.max(0.01, Number(sharePct) || 1)) / 100);
  if (t.balances[curve] < amount) throw Object.assign(new Error("not enough supply left on the curve"), { status: 400 });
  t.balances[curve] -= amount;
  t.balances[h] = (t.balances[h] || 0) + amount;
  rollEpoch(t, s, { keepIndex: true });
  event("holders", `${t.symbol}: ${h.slice(0, 10)}… added as a holder (${sharePct}%)`, { token: t.address });
  return { holder: h, balance: t.balances[h] };
}

/// Charges one AI request to the treasury. Refuses when the budget is exhausted.
export function chargeAi(t, reason = "AI request", micros = null) {
  const s = get();
  if (budgetOf(t).status === "exhausted") throw Object.assign(new Error("budget exhausted"), { status: 402, code: "budget_exhausted" });
  if (t.treasury.mode === "wallet") return;   // paid for real by the x402 rail; recorded there
  ledger(s, t, -(micros ?? toMicros(s.settings.aiCostPerCallUsd)), reason);
}
/// A real payment that already happened, written to the ledger and the cached balance.
export function recordRealSpend(t, micros, reason, extra = {}) {
  const { ledgerOnly = false, ...rest } = extra; extra = rest;
  // ledgerOnly: the money left long enough ago that the cached balances already show it (a
  // reconciled receipt) — only the ledger row is written.
  if (ledgerOnly) { /* balances untouched */ }
  // pocket:'base' — a Solana project paid from its Base USDC pocket, not from its Solana USDC.
  else if (extra.pocket === "base" && t.treasury.basePocket) { t.treasury.basePocket.usdcMicros = Math.max(0, (t.treasury.basePocket.usdcMicros || 0) - micros); t.treasury.basePocket.revision = (t.treasury.basePocket.revision || 0) + 1; }   // a read that began before this debit is discarded
  else t.treasury.usdcMicros = Math.max(0, (t.treasury.usdcMicros || 0) - micros);
  t.treasury.micros = treasuryNativeMicros(t) + (t.treasury.usdcMicros || 0) + (t.treasury.basePocket?.usdcMicros || 0);
  t.treasury.ledger.unshift({ simAt: new Date().toISOString(), deltaMicros: -micros, balanceMicros: t.treasury.micros, reason, ...extra });
  if (t.treasury.ledger.length > 400) t.treasury.ledger.length = 400;
}

// ── messages, proposals, votes (holder side; signatures checked by site-api) ──

/// A holder's standing in the community: share of the eligible supply and whether
/// that share is enough to give the agent orders (settings.orderMinBps) or just chat.
/// USD value of the treasury's native coin (ETH+USDG on Robinhood, SOL on Solana), in micros.
function treasuryNativeMicros(t) {
  const tr = t.treasury;
  if (tr.chain === "solana") return tr.solMicros ?? Math.round(((tr.solLamports || 0) / 1e9) * (tr.solUsd || 0) * MICRO);
  return (tr.ethMicros || 0) + (tr.usdgMicros || 0);
}

export function holderRole(t, holder) {
  const s = get(), h = holderKey(t, holder);
  const supply = t.governanceVersion === 2 ? t.supply : eligibleSupply(t), bal = t.balances[h] || 0;
  const sharePct = supply ? (bal / supply) * 100 : 0;
  let role = bal <= 0 ? "none" : bal * 10_000 >= supply * s.settings.orderMinBps ? "order" : "chat";
  if (t.governanceVersion === 2) {
    const total = BigInt(t.totalSupplyWei || toBaseUnits(t, t.supply));
    const amount = BigInt(t.holderBalancesWei?.[h] || toBaseUnits(t, bal));
    role = amount <= 0n ? "none" : amount * 100n > total ? "order" : "chat";
  }
  return { balance: bal, sharePct, role, orderMinPct: s.settings.orderMinBps / 100 };
}

const MSG_GAP_MS = 20_000, MSG_PER_DAY = 120;
/// Holdership and personal allowance are both checked for wallet-mode chat.
/// Explicit signed permissions are still required for holder actions.
export function workbenchPermissions(value = []) {
  if (!Array.isArray(value) || value.length > 3 || value.some((x) => !["write", "execute", "publish"].includes(x)) || new Set(value).size !== value.length) {
    throw Object.assign(new Error("permissions must be a unique array of write, execute, publish"), { status: 400 });
  }
  return ["write", "execute", "publish"].filter((x) => value.includes(x));
}

export function postMessage(t, holder, text, requestedPermissions = []) {
  requirePublicText(text);
  const s = get(), h = holderKey(t, holder);
  const r = holderRole(t, h);
  if (r.role === "none") throw Object.assign(new Error(`this wallet holds no ${t.symbol} — only holders can write to the agent`), { status: 403 });
  const permissions = workbenchPermissions(requestedPermissions);
  if (permissions.length) throw Object.assign(new Error('Chat cannot authorize work. Use Suggest an idea and a community vote.'), { status: 403 });
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw Object.assign(new Error("text must contain 1–2000 characters"), { status: 400 });
  refreshUsagePeriod(t);
  initializeUsagePool(t);
  const audience = chatAudience(text);
  if (audience === 'agent' && t.treasury.mode === "wallet" && quotaOf(t, h).remainingMicros <= 0) throw Object.assign(new Error(`${allowanceText(allowanceOf(t, h))} Community chat without @Kurt still works.`), { status: 402 });
  const mine = t.messages.filter((m) => m.holder === h);
  const lastAt = mine.length ? Date.parse(mine[mine.length - 1].createdAt) : 0;
  if (Date.now() - lastAt < MSG_GAP_MS) throw Object.assign(new Error(`wait ${Math.ceil((MSG_GAP_MS - (Date.now() - lastAt)) / 1000)} s between messages`), { status: 429 });
  if (mine.filter((m) => Date.now() - Date.parse(m.createdAt) < 86_400_000).length >= MSG_PER_DAY) throw Object.assign(new Error("daily message limit reached for this wallet"), { status: 429 });
  const m = { id: id("msg"), holder: h, username: s.profiles?.[h]?.username || null, sharePct: Number(r.sharePct.toFixed(3)), role: r.role, text: String(text).slice(0, 2000), createdAt: new Date().toISOString(), simAt: simIso(s), costMicros: 0, seq: t.messages.length + 1 };
  m.permissions = Object.freeze(permissions);
  m.audience = audience;
  m.chatState = audience === 'agent' ? 'queued' : 'sent';
  t.messages.push(m);
  if (audience === 'rules') t.replies.push({ id: id('rule'), messageId: m.id, text: chatRules(t, s.settings), at: m.createdAt, stage: 'reply', source: 'community_rules', costMicros: 0 });
  return m;
}

/// One username per wallet, unique across the site, chosen by a signed request.
export function setUsername(holder, username) {
  const s = get(), h = addressKey(holder);
  const u = String(username || "").trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) throw Object.assign(new Error("username: 3–20 letters, digits or _"), { status: 400 });
  const taken = Object.entries(s.profiles).find(([a, p]) => a !== h && p.username.toLowerCase() === u.toLowerCase());
  if (taken) throw Object.assign(new Error("that username is taken"), { status: 409 });
  s.profiles[h] = { username: u, setAt: new Date().toISOString() };
  for (const t of Object.values(s.tokens)) for (const m of t.messages) if (m.holder === h) m.username = u;
  return s.profiles[h];
}

export function createProposal(t, holder, { type, title, payload, chainSnapshot = null }) {
  const s = get();
  if (!PROPOSAL_TYPES.includes(type)) throw Object.assign(new Error("unknown proposal type"), { status: 400 });
  const clean = JSON.parse(JSON.stringify(payload || {}));
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) throw Object.assign(new Error("proposal payload must be an object"), { status: 400 });
  if(isWalletType(type))validateNewWalletProposal(t,type,clean,{chainId:chainIdOf(t.chain),votingHours:s.settings.votingHours});
  if(isLaunchType(type)){
    validateNewLaunchProposal(t,clean,{chainId:chainIdOf(t.chain),votingHours:s.settings.votingHours});
    const checked=checkProposal({type,payload:clean});
    if(!checked.ok)throw Object.assign(new Error(checked.reason),{status:400});
  }
  if(isDexType(type)) {
    validateNewDexProposal(t,type,clean,{votingHours:s.settings.votingHours});
    const checked=checkProposal({type,payload:clean});
    if(!checked.ok)throw Object.assign(new Error(checked.reason),{status:400});
  }
  if(type==="X_POST"){
    // Posting needs a verified account the root broker assigned to this project;
    // the vote itself never creates one. Text limits are checked before voting.
    if(!t.social?.x?.handle)throw Object.assign(new Error("This project has no X account yet; a post cannot be proposed"),{status:409});
    const checked=checkProposal({type,payload:{text:clean.text}});
    if(!checked.ok)throw Object.assign(new Error(checked.reason),{status:400});
    for(const k of Object.keys(clean))if(k!=="text")delete clean[k];
  }
  if(type===PROFILE_TYPE){
    validateNewProfileProposal(t,clean);
    const checked=checkProposal({type,payload:clean});
    if(!checked.ok)throw Object.assign(new Error(checked.reason),{status:400});
  }
  // Launch artwork bytes and their digest were verified by the typed PNG parser
  // above. Do not interpret a computed SHA-256 digest as a private-key string.
  if(isLaunchType(type)){
    const {artworkPng,artworkSha256,...textFields}=clean;
    requirePublicText(JSON.stringify(textFields));
  }else requirePublicText(JSON.stringify(clean));
  if ("permissions" in clean) clean.permissions = workbenchPermissions(clean.permissions);
  if (type === "TASK" && clean.permissions?.includes("publish")) throw Object.assign(new Error("TASK proposals cannot grant publication"), { status: 400 });
  const h = holderKey(t, holder);
  const supply = eligibleSupply(t);
  if (t.governanceVersion === 2) {
    // Snapshot block hash: 0x-64-hex on EVM, a base58 blockhash on Solana (slot number as blockNumber).
    const hashOk = t.chain === "solana" ? BASE58_RE.test(chainSnapshot?.blockHash || "") : /^0x[a-f0-9]{64}$/i.test(chainSnapshot?.blockHash || "");
    if (!chainSnapshot || !Number.isSafeInteger(chainSnapshot.blockNumber) || !hashOk || !/^\d+$/.test(chainSnapshot.totalSupplyWei || "") || !/^\d+$/.test(chainSnapshot.proposerBalanceWei || "")) throw Object.assign(new Error("verified chain snapshot required"), { status: 503 });
    if (BigInt(chainSnapshot.totalSupplyWei) <= 0n || BigInt(chainSnapshot.proposerBalanceWei) * 100n <= BigInt(chainSnapshot.totalSupplyWei)) throw Object.assign(new Error("suggesting work requires more than 1% of total token supply"), { status: 403 });
  } else if (!supply || (t.balances[h] || 0) * 10_000 < supply * s.settings.proposalMinBps) {
    throw Object.assign(new Error(`opening a proposal needs at least ${s.settings.proposalMinBps / 100}% of the eligible supply`), { status: 403 });
  }
  // A real token starts unfunded. Its first epoch can therefore contain a zero
  // pool even after the treasury is funded. Initialize only that unused zero pool;
  // never refill a spent quota, change its percentage or debit real funds here.
  if (t.governanceVersion === 2 && t.treasury.micros > 0 && t.epoch.chatPoolMicros === 0 && Object.values(t.epoch.used).every(n => n === 0)) {
    t.balances[h] = fromBaseUnits(t, chainSnapshot.proposerBalanceWei);
    rollEpoch(t, s, { keepIndex: true });
  }
  spendQuota(s, t, h, toMicros(s.settings.aiCostPerCallUsd));
  const excluded = excludedHoldersOf(t);
  const snapshot = Object.fromEntries(Object.entries(t.balances).filter(([a, b]) => !excluded.includes(a) && b > 0));
  // Solana has no historical balanceOf: the per-holder base-unit map taken at the snapshot slot is persisted with the proposal.
  const snapshotWei = Object.fromEntries(Object.entries(chainSnapshot?.snapshotWei && typeof chainSnapshot.snapshotWei === "object" ? chainSnapshot.snapshotWei : {}).filter(([a, v]) => TOKEN_RE.test(a) && !excluded.includes(a) && /^\d+$/.test(String(v)) && BigInt(v) > 0n).map(([a, v]) => [a, String(v)]));
  const p = {
    id: id("prop"), type, title: String(title || type).slice(0, 120), payload: clean, payloadHash: payloadHash({ type, payload: clean }),
    proposer: h, createdAt: new Date().toISOString(), endsAt: t.onchain || t.treasury.mode === "wallet" ? new Date(Date.now() + s.settings.votingHours * HOUR).toISOString() : null,
    createdSimMs: s.clock.simMs, endsSimMs: s.clock.simMs + s.settings.votingHours * HOUR,
    snapshot, snapshotTotal: Object.values(snapshot).reduce((a, b) => a + b, 0), votes: {},
    status: "voting", agentStatus: null, agentReason: null, result: null, order: t.proposals.length + 1,
  };
  if (t.governanceVersion === 2) Object.assign(p, { governanceVersion: 2, snapshotBlock: chainSnapshot.blockNumber, snapshotBlockHash: chainSnapshot.blockHash, totalSupplyWei: chainSnapshot.totalSupplyWei, snapshotWei, requireMajority: true, approvalBps: 1500, proposalBps: 100 });
  t.proposals.push(p);
  event("proposal", `${t.symbol}: proposal "${p.title}" opened`, { token: t.address });
  return p;
}

export function vote(t, holder, proposalId, support, verifiedWeightWei = null, comment = null) {
  if (typeof support !== "boolean") throw Object.assign(new Error("vote support must be true or false"), { status: 400 });
  const s = get();
  const p = t.proposals.find((x) => x.id === proposalId);
  if (!p) throw Object.assign(new Error("unknown proposal"), { status: 404 });
  if (p.status !== "voting" || p.cancelledAt || p.revokedAt || (p.endsAt ? Date.now() >= Date.parse(p.endsAt) : s.clock.simMs >= p.endsSimMs)) throw Object.assign(new Error("voting is closed"), { status: 409 });
  if (p.governanceVersion === 2) {
    if (!/^\d+$/.test(verifiedWeightWei || "") || BigInt(verifiedWeightWei) <= 0n || BigInt(verifiedWeightWei) > BigInt(p.totalSupplyWei)) throw Object.assign(new Error("no token balance at the voting snapshot"), { status: 403 });
    p.votes[holderKey(t, holder)] = { support: !!support, weightWei: verifiedWeightWei, at: new Date().toISOString(), ...(comment ? { comment: String(comment).slice(0, 280) } : {}) };
    return p;
  }
  const weight = p.snapshot[holderKey(t, holder)] || 0;
  if (!weight) throw Object.assign(new Error("not a holder at the proposal snapshot"), { status: 403 });
  p.votes[holderKey(t, holder)] = { support: !!support, weight, at: new Date().toISOString(), ...(comment ? { comment: String(comment).slice(0, 280) } : {}) };
  return p;
}

function finalizeProjectProfile(t,p) {
  if(p.type!==PROFILE_TYPE||p.status!=='approved')return;
  try {
    const checked=checkProposal(p);if(!checked.ok)throw new Error(checked.reason);
    p.result=applyApprovedProfile(t,p);p.agentStatus='done';p.agentReason=null;
  } catch(e) {p.agentStatus='rejected_by_rules';p.agentReason=e.message;}
}
export function finalizeDue(t, { force = false } = {}) {
  const s = get();
  for (const p of t.proposals) {
    if (p.status !== "voting" || p.cancelledAt || p.revokedAt || (!force && (p.endsAt ? Date.now() < Date.parse(p.endsAt) : s.clock.simMs < p.endsSimMs))) continue;
    // Real votes, including migrated legacy votes, cannot be ended early by an
    // operator's simulator-only force option.
    if ((t.onchain || t.treasury.mode === 'wallet') && (!p.endsAt || !Number.isFinite(Date.parse(p.endsAt)) || Date.parse(p.endsAt) > Date.now())) continue;
    const votes = Object.values(p.votes);
    if (p.governanceVersion === 2) {
      if (needsChainVerification(t,p)) {
        try {assertGovernanceSnapshot(t,p);} catch {p.governanceCheck={status:'pending',reason:'Canonical finalized snapshot verification required before action'};continue;}
      }
      const yes = votes.filter(v => v.support).reduce((n, v) => n + BigInt(v.weightWei), 0n);
      const no = votes.filter(v => !v.support).reduce((n, v) => n + BigInt(v.weightWei), 0n);
      const total = BigInt(p.totalSupplyWei);
      const passed = yes + no <= total && yes * 10_000n > total * BigInt(p.approvalBps) && (!p.requireMajority || yes > no);
      p.status = passed ? "approved" : "rejected";
      p.tally = { yesWei: yes.toString(), noWei: no.toString(), totalSupplyWei: total.toString(), passed };
      p.approvedOrder = passed ? t.proposals.filter(x => x.approvedOrder).length + 1 : null;
      finalizeProjectProfile(t,p);
      finalizeWalletProposal(p);
      finalizeLaunchProposal(p);
      event("proposal", `${t.symbol}: ${p.title} ${p.status}`, { token: t.address });
      continue;
    }
    const forW = votes.filter((v) => v.support).reduce((a, v) => a + v.weight, 0);
    const total = votes.reduce((a, v) => a + v.weight, 0);
    const quorum = p.snapshotTotal > 0 && total * 10_000 >= p.snapshotTotal * s.settings.quorumBps;
    const passed = total > 0 && forW * 10_000 > total * s.settings.passBps;
    p.status = quorum && passed ? "approved" : "rejected";
    p.tally = { forWeight: forW, totalWeight: total, quorum, passed };
    p.approvedOrder = p.status === "approved" ? t.proposals.filter((x) => x.approvedOrder).length + 1 : null;
    finalizeProjectProfile(t,p);
    event("proposal", `${t.symbol}: "${p.title}" ${p.status}`, { token: t.address });
  }
}

// Legacy real proposals used a simulator clock. Preserve their remaining voting
// window once at migration; do not reopen completed or rejected proposals.
export function migrateProposalDeadlines(t, now = Date.now()) {
  if (!t.onchain && t.treasury.mode !== "wallet") return false;
  let changed = false;
  for (const p of t.proposals) if (p.status === "voting" && !p.endsAt) {
    const remaining = Math.max(0, Math.min(7 * 24 * HOUR, Number(p.endsSimMs) - get().clock.simMs));
    p.endsAt = new Date(now + (Number.isFinite(remaining) ? remaining : 6 * HOUR)).toISOString();
    p.deadlineMigratedAt = new Date(now).toISOString(); changed = true;
  }
  return changed;
}

// ── clock ─────────────────────────────────────────────────────────────────────

/// Advances simulated time hour by hour. Returns real instance ids whose treasury ran
/// dry, so the caller can destroy them on vast.ai (billing must stop with the money).
export function tick(hours = 1) {
  const s = get();
  const toDestroy = [];
  for (let h = 0; h < Math.min(24 * 30, Math.max(1, Math.floor(hours))); h++) {
    for (const t of Object.values(s.tokens)) {
      if (t.treasury.mode === "wallet") continue;   // real clock, real money: billing.mjs
      const income = Math.round(t.volumeUsdPerHour * s.settings.feeBps / 10_000 * s.settings.treasuryShareBps / 10_000 * MICRO);
      if (income > 0) ledger(s, t, income, "trade fees (1h)");
      if (t.vps.state === "running") {
        ledger(s, t, -t.vps.hourlyMicros, `VPS hour (${t.vps.mode})`);
        if (t.treasury.micros <= 0) {
          if (t.vps.mode === "real" && t.vps.instanceId) toDestroy.push({ token: t.address, instanceId: t.vps.instanceId });
          t.vps.state = "stopped";
          t.agent.state = "paused";
          event("vps", `${t.symbol}: treasury empty — VPS stopped`, { token: t.address });
        }
      }
      const excluded = excludedHoldersOf(t);
      for (const [a, b] of Object.entries(t.balances)) if (!excluded.includes(a) && b > 0) t.epoch.accum[a] = (t.epoch.accum[a] || 0) + b;
    }
    s.clock.simMs += HOUR;
    for (const t of Object.values(s.tokens)) {
      if (t.treasury.mode !== 'wallet' && s.clock.simMs - t.epoch.startedSimMs >= s.settings.epochHours * HOUR) rollEpoch(t, s);
      finalizeDue(t);
    }
  }
  return toDestroy;
}

export function startVps(t, { mode, offer, instanceId = null }) {
  const s = get();
  if (budgetOf(t).status === "exhausted") throw Object.assign(new Error("treasury is empty"), { status: 402 });
  Object.assign(t.vps, { mode, state: "running", instanceId: instanceId ?? `sim-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`, hourlyMicros: toMicros(offer.dph), offer, startedSimAt: simIso(s), startedAt: new Date().toISOString(), lastBilledAt: null });
  t.agent.state = "starting";
  event("vps", `${t.symbol}: VPS started (${mode}, $${offer.dph}/h)`, { token: t.address });
}

export function stopVps(t, reason = "stopped from control room") {
  t.vps.state = "stopped";
  t.agent.state = "paused";
  event("vps", `${t.symbol}: VPS ${reason}`, { token: t.address });
}

export function depositTreasury(t, dollars, note = "manual deposit (simulated)") {
  const s = get();
  if (t.treasury.mode === "wallet") throw Object.assign(new Error(t.treasury.chain === "solana" ? "this token has a real treasury wallet — send SOL or USDC (Solana) to it instead" : "this token has a real treasury wallet — send USDG (Robinhood) or USDC (Base) to it instead"), { status: 400 });
  ledger(s, t, toMicros(dollars), note);
}
