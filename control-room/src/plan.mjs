import { assertVpsQuote, persistRuntimeActivation, runtimeStartupFundingOf } from './runtime-budget.mjs';
// The launch plan and its lock. The operator picks an AI model and a vast.ai machine;
// the plan is priced and the token stays LOCKED until its treasury (trade tax, or real
// deposits) reaches the unlock threshold. The threshold slides between
// settings.unlockMinUsd (cheapest model + cheapest machine) and settings.unlockMaxUsd
// (most expensive of both). Once reached, everything starts by itself: the machine is
// rented, the agent boots, AI is paid per request. When the money is gone the VPS is
// stopped and the token locks again until the treasury refills to the threshold.
import { get, save, saveDurable, event } from "./store.mjs";
import { tokenOf } from "./economy.mjs";
import { listModelsDetailed, X402_ID, assertAgentModelCompatible } from "./providers.mjs";
import { inventory, offerById, dphRank } from "./inventory.mjs";
import { vastRentAllowed, vastKeyConfigured } from "./vast.mjs";
import { deploy, deploymentInProgress } from "./deploy.mjs";
import { hasLaunchPackage, isPackageFunded, activationRequirementMicros, packageReserveMicros } from "./launch-package.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const STEPS_PER_DAY = 500;           // what one agent burns in a day: ~500 steps of 10k in + 1k out
const stepUsd = (m) => (10_000 * m.promptUsd + 1_000 * m.completionUsd) / 1e6;
const activating = new Set();
const MAX_ACTIVATIONS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const PROVIDER_RETRY_MAX_MS = 60 * 60_000;
const activationKey = t => String(t.address).toLowerCase();
function startup(t, patch) {
  t.lock = { ...(t.lock || {}), startup: { ...(t.lock?.startup || {}), ...patch, updatedAt: new Date().toISOString() } };
}
const requiresReconciliation = t => Boolean(t.vps?.reconciliationRequired || ["stopping", "reconciliation_required"].includes(t.vps?.phase) ||
  ((t.vps?.pendingCreate || t.vps?.phase === "renting") && !deploymentInProgress(t)));
const rentalUnavailable = t => t.treasury.mode === "wallet" && (!vastKeyConfigured() || !vastRentAllowed());

/// 0 for the cheapest model in the catalog, 1 for the most expensive.
function modelRank(m, models) {
  const prices = models.map((x) => x.promptUsd + x.completionUsd).filter((p) => p > 0);
  if (prices.length < 2) return 0.5;
  const mine = m.promptUsd + m.completionUsd;
  return Math.min(1, prices.filter((p) => p < mine).length / (prices.length - 1));
}

export function activationUsd({ modelIdx, vpsIdx }) {
  const s = get().settings;
  const min = Number(s.unlockMinUsd), max = Math.max(min, Number(s.unlockMaxUsd));
  const idx = 0.5 * modelIdx + 0.5 * vpsIdx;
  return Math.round(min + (max - min) * idx);
}

/// Prices a model + machine pair: the unlock threshold and the daily burn. Nothing saved.
export async function quotePlan({ model, offerId = null, offer = null }) {
  const models = await listModelsDetailed();
  const m = models.find((x) => x.id === model);
  if (!m) throw fail(400, `model "${model}" is not in NanoGPT's catalog`);
  assertAgentModelCompatible(m.id);   // OCR / vision / embedding models are priced in the catalogue but never run an agent
  const inv = await inventory();
  let o = offer;
  if (offerId != null) { o = offerById(Number(offerId)); if (!o) throw fail(409, `offer ${offerId} is no longer in stock — pick another machine`); }
  if (!o) throw fail(400, "pick a machine from the stock");
  assertVpsQuote(o);
  const modelIdx = modelRank(m, models), vpsIdx = dphRank(o.dph, inv.offers);
  const unlock = activationUsd({ modelIdx, vpsIdx });
  const dailyUsd = o.dph * 24 + stepUsd(m) * STEPS_PER_DAY;
  return { m, o, modelIdx, vpsIdx, activationUsd: unlock, dailyUsd: Number(dailyUsd.toFixed(2)), modelName: m.name, machine: o.gpu, dph: o.dph, stepUsd: Number(stepUsd(m).toFixed(4)) };
}

/// Saves the plan on the token and prices it. `offerId` must be in stock right now;
/// the offer is snapshotted so the fallback search knows what class to look for.
export async function setPlan(t, { model, offerId = null, offer = null, minCuda = 12.8 } = {}) {
  if (deploymentInProgress(t) || activating.has(activationKey(t))) throw fail(409, "Wait for the current server startup or shutdown before changing its plan");
  const { m, o, modelIdx, vpsIdx, activationUsd: quotedUnlock, dailyUsd } = await quotePlan({ model, offerId, offer });
  if (deploymentInProgress(t) || activating.has(activationKey(t))) throw fail(409, "Wait for the current server startup or shutdown before changing its plan");
  const unlock = hasLaunchPackage(t) ? activationRequirementMicros(t) / 1e6 : quotedUnlock;
  t.plan = {
    provider: X402_ID, model: m.id, modelName: m.name, promptUsd: m.promptUsd, completionUsd: m.completionUsd,
    offer: o, gpuName: o.gpu.replace(/^\d+x\s*/, ""), numGpus: Number(o.gpu.match(/^(\d+)x/)?.[1] || 1), minCuda: Number(minCuda) || 0,
    modelIdx: Number(modelIdx.toFixed(3)), vpsIdx: Number(vpsIdx.toFixed(3)), activationUsd: unlock, dailyUsd,
    setAt: new Date().toISOString(),
  };
  const keepPaused = t.lock?.state === "paused" || requiresReconciliation(t);
  t.lock = { ...(t.lock || {}), state: keepPaused ? "paused" : t.vps.state === "running" ? "unlocked" : "locked", activationUsd: unlock, note: keepPaused ? (t.lock?.note || "Server needs an operator check before starting") : null };
  event("plan", `${t.symbol}: plan ${m.name} + ${o.gpu} ($${o.dph}/h) — unlocks at $${unlock}`, { token: t.address });
  return lockStatus(t);
}

export function lockStatus(t) {
  const treasuryUsd = (t.treasury.micros || 0) / 1e6;
  let funding = null, fundingReviewRequired = false;
  try { funding = t.plan ? runtimeStartupFundingOf(t) : null; }
  catch { fundingReviewRequired = true; }
  const need = funding ? funding.requirementMicros / 1e6 : null;
  const state = !t.plan ? "no_plan" : requiresReconciliation(t) || fundingReviewRequired ? "paused" : (t.lock?.state || "locked");
  const blockedReason = requiresReconciliation(t) ? "server_reconciliation_required" : fundingReviewRequired ? "runtime_funding_review_required" : state === "paused" ? "paused" :
    t.vps?.recovery?.active && t.vps?.state === "running" ? "runtime_recovering" :
    funding?.liabilityReviewRequired ? "vps_usage_review_required" :
    funding && !funding.liabilitiesVerified ? "runtime_liabilities_unverified" :
    state === "locked" && funding && !funding.freshBalance ? "balance_refresh_required" :
    state === "locked" && funding && !funding.affordable ? "runtime_funding_required" :
    state === "locked" && rentalUnavailable(t) ? "real_rental_unavailable" :
    null;
  return {
    state, fundingReviewRequired, activationUsd: need, treasuryUsd: Number(treasuryUsd.toFixed(2)),
    progress: need ? Math.min(1, funding.availableMicros / funding.requirementMicros) : 0, missingUsd: need && funding.missingMicros !== null ? Number((funding.missingMicros / 1e6).toFixed(6)) : null,
    availableUsd: funding ? Number((funding.availableMicros / 1e6).toFixed(6)) : null, heldUsd: fundingReviewRequired || funding?.heldMicros === null ? null : funding ? funding.heldMicros / 1e6 : 0,
    fundingMode: fundingReviewRequired ? null : funding?.resumed ? "runtime_resume" : "initial_activation",
    dailyUsd: t.plan?.dailyUsd ?? null, runwayDays: fundingReviewRequired || funding && (!funding.liabilitiesVerified || funding.liabilityReviewRequired) ? null : t.plan?.dailyUsd ? Number((Math.max(0, funding?.heldMicros ? funding.availableMicros / 1e6 : treasuryUsd - packageReserveMicros(t) / 1e6) / t.plan.dailyUsd).toFixed(1)) : null,
    note: t.lock?.note || null, unlockedAt: t.lock?.unlockedAt || null,
    blockedReason,
  };
}

/// Stops the automatic start (operator pressed stop). `resume` puts it back.
export function pause(t, note = "paused from the control room") { t.lock = { ...(t.lock || {}), state: "paused", note }; }
export function resume(t) {
  if (deploymentInProgress(t) || activating.has(activationKey(t))) throw fail(409, "Wait for the current server startup or shutdown before resuming");
  if (requiresReconciliation(t)) throw fail(409, "Check the unresolved server rental or cleanup before resuming");
  if (t.plan) t.lock = { ...(t.lock || {}), state: t.vps.state === "running" ? "unlocked" : "locked", note: null };
}

/// Runs every minute: locks tokens whose VPS stopped, starts the ones whose treasury
/// reached the threshold. Real rentals only for real treasuries with renting enabled.
export async function activateReady() {
  const s = get(), eligible = [];
  let changed = false;
  for (const t of Object.values(s.tokens)) {
    // Funding is a durable one-time launch event, independent of whether a
    // provider slot is currently free. The helper rejects stale observations.
    let packaged, funded, need, funding;
    try {
      packaged = hasLaunchPackage(t);
      persistRuntimeActivation(t, saveDurable);
      funded = packaged && isPackageFunded(t);
      funding = t.plan ? runtimeStartupFundingOf(t) : null;
      need = funding?.requirementMicros ?? null;
    } catch {
      const note = "Launch package funding record needs an operator check before starting";
      if (t.lock?.state !== "paused" || t.lock?.note !== note) { pause(t, note); changed = true; }
      continue; // Invalid project state must not consume every launch slot.
    }
    if (!t.plan || activating.has(activationKey(t)) || deploymentInProgress(t)) continue;
    if (requiresReconciliation(t)) {
      if (t.lock?.state !== "paused") {
        pause(t, t.lock?.note || "Server needs an operator check before starting");
        save();
      }
      continue;
    }
    const running = t.vps.state === "running" || ["renting", "booting"].includes(t.vps.phase);
    if (!running && funding?.liabilityReviewRequired) {
      const note = 'Previous server usage needs an operator billing review before another rental';
      if (t.lock?.state !== 'paused' || t.lock?.note !== note) { pause(t, note); changed = true; }
      continue;
    }
    if (t.lock?.state === "unlocked" && !running) {
      t.lock = { ...t.lock, state: "locked", lockedAt: new Date().toISOString(), note: t.vps.log?.[0]?.note || "VPS stopped" };
      changed = true;
      event("plan", `${t.symbol}: locked again (${t.lock.note}) — waits for $${need / 1e6}`, { token: t.address });
      continue;
    }
    if (t.lock?.state !== "locked" || running) continue;
    if (packaged && !funded) continue;
    if (!funding?.affordable) {
      const phase = funding?.resumed ? "runtime_funding" : "funding";
      if (t.lock.startup?.phase !== phase) {
        startup(t, { phase, nextRetryAt: null, errorCode: null });
        t.lock.note = funding?.resumed ? "Runtime restart needs unreserved funds for two quoted VPS hours and $1 of AI liquidity." : "Waiting for the initial startup funding target.";
        changed = true;
      }
      continue;
    }
    if (!funding.freshBalance) {
      if (t.lock.startup?.phase !== "checking_balance") {
        startup(t, { phase: "checking_balance", nextRetryAt: null, errorCode: null });
        t.lock.note = "Waiting for a fresh confirmed project balance before starting.";
        changed = true;
      }
      continue;
    }
    if (rentalUnavailable(t)) {
      const note = "Funding is ready, but real server rental is not enabled. No server has been started.";
      if (t.lock.note !== note) { t.lock = { ...t.lock, note }; save(); }
      continue; // A wallet-backed project is never silently turned into a demo.
    }
    if (Date.parse(t.lock?.startup?.nextRetryAt || '') > Date.now()) continue;
    if (t.lock.startup?.phase !== "queued") {
      startup(t, { phase: "queued", attempt: Number(t.lock.startup?.attempt) || 0, startedAt: t.lock.startup?.startedAt || new Date().toISOString(), lastAttemptAt: t.lock.startup?.lastAttemptAt || null, nextRetryAt: null, errorCode: null });
      changed = true;
    }
    eligible.push(t);
  }
  if (changed) save();
  // A slow/erroring project cannot monopolize all launches. Across overlapping
  // callers there are at most five active starts; older unattempted work goes first.
  eligible.sort((a, b) => (Date.parse(a.lock.startup?.lastAttemptAt || '') || 0) - (Date.parse(b.lock.startup?.lastAttemptAt || '') || 0));
  const selected = eligible.slice(0, Math.max(0, MAX_ACTIVATIONS - activating.size));
  const results = await Promise.all(selected.map(activateToken));
  return results.filter(Boolean);
}

async function activateToken(t) {
  const key = activationKey(t), chosenPlan = t.plan, real = t.treasury.mode === "wallet";
  activating.add(key);
  try {
    startup(t, { phase: "checking_offer", attempt: (Number(t.lock.startup?.attempt) || 0) + 1, lastAttemptAt: new Date().toISOString(), nextRetryAt: null, errorCode: null });
    t.lock.note = null;
    save();
    if (t.lock?.state === "paused" || requiresReconciliation(t) || t.plan !== chosenPlan) return null;
    const criteria = { gpuName: chosenPlan.gpuName, numGpus: chosenPlan.numGpus, ramGb: 0, maxDph: Number((chosenPlan.offer.dph * 1.3).toFixed(4)), minUploadMbps: 50, minCuda: chosenPlan.minCuda, diskGb: chosenPlan.offer.allocatedDiskGb };
    // The saved offer is an intent, never a live quote. deploy revalidates its
    // exact ID/price and only searches the approved class if it really vanished.
    const r = await deploy(t.address, { mode: real ? "real" : "sim", provider: chosenPlan.provider, model: chosenPlan.model, offer: chosenPlan.offer, criteria, confirm: "DEPLOY", automatic: true });
    if (!r.ok) throw new Error(t.vps.log?.[0]?.note || "deploy failed");
    t.lock = { ...t.lock, state: "unlocked", unlockedAt: new Date().toISOString(), note: null };
    startup(t, { phase: "booting", nextRetryAt: null, errorCode: null });
    event("plan", `${t.symbol}: server rented and starting (${real ? "real rental" : "simulated"})`, { token: t.address });
    save();
    return t.address;
  } catch (e) {
    // A failed search is safe to retry later. An unknown billed create or an
    // operator pause is not; preserve those states and never schedule a retry.
    if (t.lock?.state !== "paused" && !requiresReconciliation(t)) {
      const rateLimited = e.providerStatus === 429 || e.code === "provider_rate_limited";
      if (e.startupQuote) startup(t, { lastQuote: e.startupQuote });
      const errorCode = e.status === 402 ? "runtime_funding_required" : e.status === 503 && /balance/i.test(e.message) ? "balance_refresh_required" : rateLimited ? "provider_rate_limited" : e.status === 409 || e.status === 404 ? "offer_unavailable" : "startup_failed";
      const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, (t.lock.startup?.attempt || 1) - 1)));
      // Keep the provider's full bounded Retry-After durable across restarts;
      // the five-minute ceiling is only for our own exponential backoff.
      const providerDelay = Number(e.providerRetryAfterMs ?? e.retryAfterMs);
      const retryMs = Math.max(exponential, rateLimited ? 60_000 : 0, Number.isFinite(providerDelay) ? Math.max(0, Math.min(PROVIDER_RETRY_MAX_MS, providerDelay)) : 0);
      t.lock = { ...t.lock, state: "locked", note: `start failed: ${String(e.message).slice(0, 140)}` };
      startup(t, { phase: "retry_wait", nextRetryAt: new Date(Date.now() + retryMs).toISOString(), errorCode });
    } else {
      if (t.lock?.state !== "paused") pause(t, "Server needs an operator check before starting");
      startup(t, { nextRetryAt: null });
    }
    event("plan", `${t.symbol}: start failed — ${String(e.message).slice(0, 140)}`, { token: t.address, level: "error" });
    save();
    return null;
  } finally { activating.delete(key); }
}

export { tokenOf };
