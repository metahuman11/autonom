// "Deploy": pick a vast.ai offer by the operator's criteria, rent it without SSH,
// hand the machine a single-use boot code, and follow it until its agent reports in
// and its stream is live. A machine that never reports in within the deadline is
// destroyed and the next offer is tried. Every step is written to the token's VPS
// record so the panel shows exactly where a deploy stands.
// Rental/deletion intent and reconciliation checkpoints must survive host loss,
// regardless of whether this project has ever used the community signer.
import { get, saveDurable as save, event } from "./store.mjs";
import { env } from "./env.mjs";
import { randomUUID } from "node:crypto";
import { issueBootCode, issueStreamKey, revokeSessions } from "./auth.mjs";
import { providerOf, listModelsDetailed, defaultModel, X402_ID } from "./providers.mjs";
import { searchOffers, quoteOffer, allocatedDiskGb, rentOffer, destroyInstance, showInstance, vastRentAllowed, assertExpectedRentalLifetime } from "./vast.mjs";
import { markGone } from "./inventory.mjs";
import { tokenOf, budgetOf, startVps, stopVps, toMicros } from "./economy.mjs";
import { viewersOf } from "./viewers.mjs";
import { RUNTIME_HEARTBEAT_MAX_AGE_MS } from "./runtime-capabilities.mjs";
import { heldUsage } from "./usage-budget.mjs";
import { assertVpsQuote, cappedVpsCriteria, VPS_MAX_DPH, persistRuntimeActivation, assertRuntimeStartupAffordable } from "./runtime-budget.mjs";
import { hasLaunchPackage, hasFreshMarketingObservation, activationRequirementMicros } from "./launch-package.mjs";
import { providerObservation, observeRecovery, publicRecoveryOf, incidentOrigin } from "./provider-recovery.mjs";
import { holdVpsUsageForReview, publicVpsUsageReviewOf, resolveVpsUsageReview } from "./vps-billing-recovery.mjs";

const BOOT_DEADLINE_MS = 12 * 60_000;
const BOOT_PROGRESS_DEADLINE_MS = 20 * 60_000;
// Authenticated fresh setup progress may extend a cold boot, never forever.
export function bootDeadlineMs(t, now = Date.now()) {
  const started = Number(t.vps?.rentedAt || 0), progress = Date.parse(t.vps?.bootStepAt || "");
  const recent = started > 0 && Number.isFinite(progress) && progress >= started && progress <= now && now - progress <= 90_000;
  return recent ? BOOT_PROGRESS_DEADLINE_MS : BOOT_DEADLINE_MS;
}
const POLL_MS = 30_000;
const lifecycleBusy = new Set();
const fail = (status, message) => Object.assign(new Error(message), { status });
export const deploymentInProgress = t => lifecycleBusy.has(String(t.address).toLowerCase());

function activationMinimum(t, required) {
  if (!required) return 0;
  const micros = activationRequirementMicros(t);
  if (!Number.isSafeInteger(micros) || micros <= 0) throw fail(400, "A valid startup funding target is required for rental");
  return micros;
}

function assertStartupFunding(t, required, offer) {
  if (!required) return;
  assertRuntimeStartupAffordable(t, { offer, requireFreshBalance: true });
}

function assertFreshPackageBalance(t) {
  if (!hasLaunchPackage(t)) return;
  if (!hasFreshMarketingObservation(t) ||
      !Number.isSafeInteger(t.treasury.micros) || t.treasury.micros < 0)
    throw fail(503, "A fresh verified marketing balance is required before rental; no server was ordered");
}

async function exclusive(t, fn) {
  const key = t.address.toLowerCase();
  if (lifecycleBusy.has(key)) throw fail(409, "a VPS lifecycle operation is already in progress");
  lifecycleBusy.add(key);
  try { return await fn(); } finally { lifecycleBusy.delete(key); }
}

function revokeVpsAuthority(t) {
  revokeSessions(t);
  const auth = get().vpsAuth?.[t.address.toLowerCase()];
  if (auth) auth.bootCodes = [];
  t.vps.streamKeyHash = null;
  t.agent.state = "paused";
}

function pauseForReconciliation(t, note, phase = "reconciliation_required") {
  revokeVpsAuthority(t);
  t.lock = { ...(t.lock || {}), state: "paused", note };
  record(t, { phase, state: phase === "stopping" ? "stopping" : "unknown", reconciliationRequired: true, streamLive: false, note });
  save();
}

export const publicBase = () => env("GATEWAY_PUBLIC_URL", "http://127.0.0.1:4747").replace(/\/$/, "");
export const ingestHost = () => env("GATEWAY_INGEST_HOST", "127.0.0.1");

export function bootCommandFor(token, code) {
  // Runs as the container's command. curl may be missing from a bare CUDA image.
  return `export DEBIAN_FRONTEND=noninteractive; (command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null)); curl -fsSL "${publicBase()}/boot/${token}/${code}" -o /tmp/gateway-boot.sh && exec bash /tmp/gateway-boot.sh`;
}

function record(t, patch) {
  Object.assign(t.vps, patch, { updatedAt: new Date().toISOString() });
  t.vps.log ||= [];
  if (patch.note) { t.vps.log.unshift({ at: new Date().toISOString(), note: patch.note }); if (t.vps.log.length > 60) t.vps.log.length = 60; }
}

// Presentation only: never grants tools, restarts a process, destroys a server,
// or rents a replacement. A past ready event is not ongoing stream evidence.
export function vpsHealthOf(t, now = Date.now(), telemetry = viewersOf(t.address)) {
  const v = t.vps || {}, a = t.agent || {};
  const timestamp = value => {
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(parsed) && parsed > 0 && parsed <= now + 5_000 ? parsed : null;
  };
  const registered = timestamp(v.registeredAt), heartbeat = timestamp(a.lastHeartbeatAt);
  const start = registered || timestamp(v.rentedAt) || timestamp(v.startedAt);
  const heartbeatFresh = heartbeat != null && now - heartbeat <= RUNTIME_HEARTBEAT_MAX_AGE_MS && (registered == null || heartbeat >= registered);
  const streamKnown = telemetry?.telemetryFresh === true && typeof telemetry.ready === "boolean";
  const streamReady = v.state === "running" && v.mode === "real" && streamKnown ? telemetry.ready : null;
  const paused = t.lock?.state === "paused" || a.state === "paused";
  const unresolved = Boolean(v.reconciliationRequired || v.phase === "reconciliation_required" || (v.pendingCreate && v.phase !== "renting"));
  const agentOnline = v.state === "running" && v.mode === "real" && !paused && !unresolved && ["starting", "idle", "working"].includes(a.state) && heartbeatFresh;
  // Safe provider evidence, not the private remote object (IP / host / errors).
  const checked = v.mode === 'real' && v.instanceId && v.providerCheck?.instanceId === v.instanceId ? timestamp(v.providerCheck.checkedAt) : null;
  const providerFresh = checked != null && now - checked <= 90_000;
  const providerStates = ['running','loading','created','stopped','exited','offline','destroyed','frozen','rebooting','unknown'];
  const provider = { status: !providerFresh ? 'unknown' : v.providerCheck?.ok ? 'checked' : 'unavailable',
    state: providerFresh && v.providerCheck?.ok && providerStates.includes(v.providerCheck.state) ? v.providerCheck.state : null,
    checkedAt: checked == null ? null : new Date(checked).toISOString() };
  const recovery = publicRecoveryOf(t);
  let status, message;
  if (unresolved) {
    status = "attention_required"; message = "The server needs an operator check before starting again";
  } else if (v.phase === "stopping") {
    status = "stopping"; message = "The server is shutting down and cleanup is being checked";
  } else if (v.state !== "running") {
    status = paused ? "paused" : v.phase === "renting" ? "starting" : "stopped";
    message = status === "paused" ? "The agent is paused" : status === "starting" ? "The server is being prepared" : "The agent is not running yet";
  } else if (v.mode !== "real") {
    status = "simulation"; message = "This is a demo, not a live server";
  } else if (paused) {
    status = "paused"; message = "The agent is paused";
  } else if (recovery?.active) {
    status = recovery.status === 'attention_required' ? 'attention_required' : 'recovering';
    message = recovery.status === 'attention_required' ? 'The existing server needs an operator check; its allocation is preserved' : 'The existing server is being checked after an uncertain provider report';
  } else if (!agentOnline) {
    if (v.phase === "booting" && start != null && now - start > bootDeadlineMs(t, now)) {
      status = "attention_required"; message = "The server is taking longer than expected to start";
    } else {
      status = (start != null && now - start <= RUNTIME_HEARTBEAT_MAX_AGE_MS) || v.phase === "booting" ? "starting" : "heartbeat_stale";
      message = status === "starting" ? "The agent is starting and has not checked in yet" : "The agent has not checked in recently";
    }
  } else if (!streamKnown) {
    status = "stream_check_unavailable"; message = "The agent is online, but the live screen cannot be confirmed right now";
  } else if (!streamReady) {
    status = start != null && now - start > 10 * 60_000 ? "stream_delayed" : "waiting_for_stream";
    message = status === "stream_delayed" ? "The agent is online, but its live screen needs attention" : "The agent is online and its live screen is starting";
  } else {
    status = "live"; message = "The agent and live screen are online";
  }
  return {
    status, message, agentOnline, streamReady, provider, recovery,
    streamTelemetry: telemetry?.status || "unavailable",
    streamMeasuredAt: telemetry?.measuredAt || null,
    lastHeartbeatAt: heartbeat == null ? null : new Date(heartbeat).toISOString(),
    heartbeatAgeSeconds: heartbeat == null ? null : Math.max(0, Math.floor((now - heartbeat) / 1000)),
    startupAgeSeconds: start == null ? null : Math.max(0, Math.floor((now - start) / 1000)),
    lastReportedStreamLive: v.streamLive === true,
    checkedAt: new Date(now).toISOString(),
  };
}

function checkAutomaticPause(t) {
  if (t.vps.automaticStart && t.lock?.state === "paused") {
    record(t, { phase: "failed", note: "Automatic startup was paused before renting a server" });
    save();
    throw fail(409, "Automatic startup is paused");
  }
}

/// Starts a deploy. `mode` is "sim" (no vast.ai call) or "real".
export async function deploy(tokenAddress, options = {}) {
  const t = tokenOf(tokenAddress);
  return exclusive(t, () => deployInternal(t, options));
}

async function deployInternal(t, { mode = "sim", provider = X402_ID, model = "", criteria = {}, offer = null, confirm = "", automatic = false } = {}) {
  if (t.vps.reconciliationRequired || (t.vps.mode === "real" && (t.vps.recovery?.active || ["renting", "booting", "ready", "live", "stopping", "reconciliation_required"].includes(t.vps.phase) || t.vps.state === "running"))) throw fail(409, "a real VPS is active or its cleanup is unconfirmed — reconcile it before deploying");
  if (publicVpsUsageReviewOf(t)) throw Object.assign(fail(409, 'Previous server usage requires an operator billing review before another rental'), { code: 'vps_usage_review_required' });
  if (t.treasury.mode === "wallet" && mode !== "real") throw fail(400, "A funded project requires a real server; simulation is only available for demo projects");
  if (automatic && t.lock?.state === "paused") throw fail(409, "Automatic startup is paused");
  if (budgetOf(t).status === "exhausted") throw Object.assign(new Error("treasury is empty"), { status: 402 });
  const p = providerOf(provider);
  if (p.id === X402_ID) {
    // The model must be one NanoGPT rents, so the price shown is the price paid.
    const models = await listModelsDetailed();
    const want = model || await defaultModel();
    const chosen = models.find((m) => m.id === want);
    if (!chosen) throw Object.assign(new Error(`model "${model}" is not in NanoGPT's catalog`), { status: 400 });
    t.agent.ai = { provider: p.id, model: chosen.id, name: chosen.name, promptUsd: chosen.promptUsd, completionUsd: chosen.completionUsd };
  } else t.agent.ai = { provider: p.id, model: model || p.defaultModel };
  // Legacy prior-run proof includes the rented attempt. Capture its durable
  // activation receipt before a new deployment replaces the attempts list.
  if (mode === 'real' && t.treasury.mode === 'wallet') persistRuntimeActivation(t, save);
  t.vps.attempts = [];
  const requestedMaxDph = criteria?.maxDph;
  criteria = cappedVpsCriteria(criteria);
  if (offer) assertVpsQuote(offer);
  t.vps.criteria = criteria;
  revokeSessions(t);

  if (mode !== "real") {
    const chosen = offer || { id: "sim", dph: 0.12, gpu: "1x RTX 5070 Ti (sim)", ramGb: 32, cpus: 16, geo: "SIM", simulated: true };
    startVps(t, { mode: "sim", offer: chosen });
    record(t, { phase: "ready", note: `simulated deploy with ${p.id}/${t.agent.ai.model}`, remote: null, streamLive: false });
    save();
    return { ok: true, mode: "sim", vps: t.vps };
  }

  if (!vastRentAllowed()) throw Object.assign(new Error("real rentals are disabled (VAST_ALLOW_RENT=1 in .env)"), { status: 400 });
  // A real, billed machine is only ever paid by a real treasury; simulated money cannot rent one.
  if (t.treasury.mode !== "wallet") throw Object.assign(new Error("this token has a simulated treasury — a real rental needs a token with a real treasury wallet"), { status: 400 });
  if (confirm !== "DEPLOY") throw Object.assign(new Error('type "DEPLOY" to confirm a real, billed rental'), { status: 400 });
  // Package funding also applies to manual starts. Recompute after every await:
  // DEX settlement may legitimately reduce the target while quotes are fetched.
  // Replacing an already-paid failed boot remains recovery, not initial funding.
  const requireActivationFunding = automatic || hasLaunchPackage(t);
  activationMinimum(t, requireActivationFunding);
  const diskGb = allocatedDiskGb(criteria?.diskGb);
  if (offer?.allocatedDiskGb != null && offer.allocatedDiskGb !== diskGb) throw fail(409, "VPS disk allocation changed; refresh the quote");
  let selected = null, unavailableQuote = null;
  if (offer) {
    try { selected = assertVpsQuote(await quoteOffer(offer.id, { diskGb, maxDph: Math.min(VPS_MAX_DPH, Number(offer.dph)) })); }
    catch (e) {
      // Only a definite unavailable quote permits a class fallback. A429 or
      // transport failure must not multiply provider searches across all offers.
      if (e.status !== 409) throw e;
      unavailableQuote = e;
    }
  }
  const fallbackCriteria = cappedVpsCriteria(criteria);
  if (offer) {
    fallbackCriteria.gpuName ||= String(offer.gpu || '').replace(/^\d+x\s*/, '');
    fallbackCriteria.numGpus ||= Number(String(offer.gpu || '').match(/^(\d+)x/)?.[1] || 1);
    fallbackCriteria.maxDph = Math.min(VPS_MAX_DPH, Number(requestedMaxDph ?? offer.dph));
    if (!fallbackCriteria.gpuName || !Number.isFinite(fallbackCriteria.maxDph) || fallbackCriteria.maxDph <= 0) throw unavailableQuote || fail(409, "refresh the quote before selecting a replacement VPS");
  }
  const found = selected ? [] : await searchOffers({ ...fallbackCriteria, diskGb, limit: 8 });
  const candidates = selected ? [selected] : found.filter(o => Number.isFinite(o.dph) && o.dph > 0 && o.dph <= VPS_MAX_DPH);
  if (!candidates.length) throw unavailableQuote || Object.assign(new Error("no vast.ai offer matches the criteria"), { status: 404 });
  if (t.treasury.mode === "wallet") {
    const { refreshTreasury } = await import("./billing.mjs");
    await refreshTreasury(t);
    assertFreshPackageBalance(t);
    persistRuntimeActivation(t, save);
    assertStartupFunding(t, requireActivationFunding, candidates[0]);
    const need = toMicros(candidates[0].dph) * 2;
    const available = t.treasury.micros - heldUsage(t);
    if (available < need) throw Object.assign(new Error(`unreserved treasury holds $${(available / 1e6).toFixed(2)}; a real deploy needs at least two VPS hours ($${(need / 1e6).toFixed(2)})`), { status: 402 });
  }
  t.agent.lastHeartbeatAt = null;
  t.agent.firstHeartbeatAt = null;
  delete t.vps.runtimeCapabilities;
  t.screen = { title: "Starting the server", lines: [] };
  record(t, { phase: "checking_offer", mode: "real", automaticStart: automatic === true, allocatedDiskGb: diskGb, reconciliationRequired: false, cleanupReason: null, note: `real deploy with ${p.id}/${t.agent.ai.model}; ${candidates.length} candidate offers`, streamLive: false, remote: null,
    bootStep: null, bootStepAt: null, registeredAt: null, firstStreamAt: null, streamEventAt: null, providerCheck: null, recovery: null,
    cleanupAcknowledgement: null, cleanupProof: null, cleanupConfirmedAt: null, bootRecoveryGraceUntil: null, startupBounded: true });
  save();
  return await tryNext(t, candidates, requireActivationFunding);
}

async function tryNext(t, candidates, requireActivationFunding = false) {
  // Every package rental, including a boot-timeout replacement, must reserve its
  // full current startup budget. Recovery does not waive the AI liquidity floor.
  requireActivationFunding ||= hasLaunchPackage(t);
  if (t.vps.reconciliationRequired) throw fail(409, "VPS reconciliation is required before another rental");
  if (publicVpsUsageReviewOf(t)) throw Object.assign(fail(409, 'Previous server usage requires an operator billing review before another rental'), { code: 'vps_usage_review_required' });
  checkAutomaticPause(t);
  const tried = new Set((t.vps.attempts || []).map((a) => a.offerId));
  let next = candidates.find((o) => !tried.has(o.id));
  if (!next) {
    if (t.vps.attempts?.length && t.vps.attempts.every(a => a.result === "quote unavailable")) {
      record(t, { phase: "failed", note: "Candidate offers are no longer available within their approved quotes; no rental was submitted" });
      save();
      throw fail(409, "selected VPS offers are unavailable within the approved price; checking again later");
    }
    revokeVpsAuthority(t);
    record(t, { phase: "failed", note: "every candidate offer failed to boot" });
    t.lock = { ...(t.lock || {}), state: "paused", note: "Startup failed on all approved offers; fix the cause before retrying" };
    t.agent.state = "not_started";
    event("vps", `${t.symbol}: deploy failed — no offer booted`, { token: t.address, level: "error" });
    save();
    return { ok: false, vps: t.vps };
  }
  // Re-read immediately before accepting; a saved/stale quote is never purchase
  // authority for a different price or disk size.
  try { next = assertVpsQuote(await quoteOffer(next.id, { diskGb: t.vps.allocatedDiskGb, maxDph: Math.min(VPS_MAX_DPH, Number(next.dph)) })); }
  catch (e) {
    if (e.status !== 409) {
      record(t, { phase: "failed", note: "Provider quote check is temporarily unavailable; no new rental was submitted" });
      save();
      throw e;
    }
    t.vps.attempts.push({ offerId: next.id, at: new Date().toISOString(), result: "quote unavailable" });
    save();
    return await tryNext(t, candidates, requireActivationFunding);
  }
  const { refreshTreasury } = await import("./billing.mjs");
  await refreshTreasury(t);
  assertFreshPackageBalance(t);
  persistRuntimeActivation(t, save);
  checkAutomaticPause(t);
  try { assertStartupFunding(t, requireActivationFunding, next); }
  catch (e) {
    record(t, { phase: "failed", note: "Project balance is below its startup target; no rental was submitted" });
    save();
    throw e;
  }
  if (t.treasury.micros - heldUsage(t) < toMicros(next.dph) * 2) {
    record(t, { phase: "failed", note: "unreserved treasury cannot cover two hours of this VPS quote" });
    save();
    return { ok: false, vps: t.vps };
  }
  // Freshness can change while balance/funding RPCs are in flight. Validate the
  // remaining guarantee again before durably committing any paid create intent.
  assertExpectedRentalLifetime(next);
  revokeVpsAuthority(t);
  const code = issueBootCode(t, { offerId: next.id });
  issueStreamKey(t);
  const bootCommand = bootCommandFor(t.address, code);
  const attempt = { requestId: randomUUID(), offerId: next.id, at: new Date().toISOString(), result: "create_pending" };
  attempt.label = `gateway-${t.symbol.toLowerCase()}-${attempt.requestId}`;
  t.vps.attempts.push(attempt);
  record(t, { phase: "renting", pendingCreate: attempt.requestId, candidates });
  if (t.vps.automaticStart && t.lock?.startup) t.lock.startup = { ...t.lock.startup, phase: "renting", updatedAt: new Date().toISOString() };
  save(); // Persist BEFORE the billed call; a process crash must block retry too.
  let instanceId;
  try {
    ({ instanceId } = await rentOffer({ offerId: next.id, label: attempt.label, bootCommand, diskGb: next.allocatedDiskGb }));
  } catch (e) {
    attempt.result = e.createOutcome === "rejected" ? "create_rejected" : "create_unknown";
    if (e.createOutcome !== "rejected") {
      pauseForReconciliation(t, "VPS creation result is unknown; check the unique rental label before retrying");
      return { ok: false, reconciliationRequired: true, vps: t.vps };
    }
    t.vps.pendingCreate = null;
    record(t, { note: `offer ${next.id}: rent failed — ${e.message.slice(0, 120)}` });
    save();
    return await tryNext(t, candidates, requireActivationFunding);
  }
  markGone(next.id);   // out of stock the moment we hold it
  Object.assign(attempt, { instanceId, result: "rented" });
  record(t, { instanceId, pendingCreate: null, state: "running", phase: "booting", rentedAt: Date.now(), offer: next,
    recovery: null, cleanupAcknowledgement: null, cleanupProof: null, cleanupConfirmedAt: null, bootRecoveryGraceUntil: null });
  save(); // Keep the exact paid instance even if subsequent setup fails.
  if (t.vps.automaticStart && t.lock?.state === "paused") {
    await teardownInternal(t, "automatic startup paused while the provider was creating the server");
    return { ok: false, vps: t.vps };
  }
  try { startVps(t, { mode: "real", offer: next, instanceId }); }
  catch (e) { await teardownInternal(t, "local setup failed after rental"); throw e; }
  record(t, { phase: "booting", rentedAt: Date.now(), candidates, remote: null, registeredAt: null, note: `instance ${instanceId} rented at $${next.dph}/h (${next.gpu}, ${next.geo}); waiting for boot` });
  event("vast", `${t.symbol}: REAL instance ${instanceId} rented ($${next.dph}/h)`, { token: t.address });
  save();
  return { ok: true, mode: "real", vps: t.vps };
}

/// A progress beacon from the booting machine (see bootstrap.sh).
export function noteProgress(t, step, detail = "") {
  record(t, { bootStep: step, bootStepAt: new Date().toISOString(), note: `VPS: ${step}${detail ? ` — ${detail}` : ""}` });
}

/// Called when the VPS redeems its boot code.
export function markRegistered(t, host) {
  if (t.vps.reconciliationRequired || ["stopping", "reconciliation_required"].includes(t.vps.phase)) throw fail(409, "VPS authority is paused while cleanup is unconfirmed");
  record(t, { phase: "ready", registeredAt: Date.now(), firstStreamAt: null, streamEventAt: null, streamLive: false, host, note: `VPS registered (${host?.hostname || "?"}, gpu ${host?.gpu || "?"})` });
  t.agent.lastHeartbeatAt = null;
  t.agent.firstHeartbeatAt = null;
  delete t.vps.runtimeCapabilities;
  t.agent.state = "starting";
  event("vps", `${t.symbol}: VPS booted and registered`, { token: t.address });
}

export function markStream(t, live) {
  if (t.vps.mode === "real" && (t.vps.reconciliationRequired || t.vps.state !== "running")) return;
  t.vps.streamEventAt = new Date().toISOString();
  if (live && !t.vps.firstStreamAt) t.vps.firstStreamAt = t.vps.streamEventAt;
  if (t.vps.streamLive === live) return;
  record(t, { streamLive: live, phase: live ? "live" : (t.vps.phase === "live" ? "ready" : t.vps.phase), note: live ? "stream is live" : "stream stopped" });
  event("stream", `${t.symbol}: stream ${live ? "LIVE" : "stopped"}`, { token: t.address });
}

/// Tears down a real instance and marks the VPS stopped.
export async function teardown(t, reason) {
  return exclusive(t, () => teardownInternal(t, reason));
}

async function teardownInternal(t, reason) {
  revokeVpsAuthority(t);
  if (t.vps.mode === "real" && (t.vps.pendingCreate || t.vps.phase === "renting" || (!t.vps.instanceId && t.vps.reconciliationRequired))) {
    pauseForReconciliation(t, "VPS creation is unresolved; identify the billed instance before stopping it");
    throw fail(409, "cannot confirm VPS deletion until the pending rental is reconciled");
  }
  if (t.vps.mode === "real" && t.vps.instanceId) {
    // A confirmed instance ID is historical evidence, not a fresh DELETE target.
    if (t.vps.phase === 'stopped' && t.vps.state === 'stopped' && t.vps.cleanupProof?.instanceId === t.vps.instanceId && t.vps.cleanupConfirmedAt) return { ok: true, stopped: true };
    if (t.vps.cleanupAcknowledgement?.instanceId === t.vps.instanceId) {
      let remote = null, error = null;
      try { remote = await showInstance(t.vps.instanceId); } catch (e) { error = e; }
      const observation = providerObservation(remote, error);
      if (observation.kind === 'destroyed' || error?.providerStatus === 404 || error?.providerInstanceAbsent === true)
        return finalizeStopped(t, reason, observation.kind === 'destroyed' ? 'provider_destroyed' : 'acknowledged_delete_absent');
      pauseForReconciliation(t, 'Acknowledged VPS deletion is still being checked; billing may continue', 'stopping');
      throw fail(502, 'Vast instance deletion is not confirmed; billing may continue');
    }
    record(t, { phase: "stopping", state: "stopping", cleanupReason: reason, streamLive: false });
    save();
    try {
      const result = await destroyInstance(t.vps.instanceId, { onAcknowledged: () => {
        record(t, { cleanupAcknowledgement: { instanceId: t.vps.instanceId, at: new Date().toISOString() } });
        save();
      } });
      if (result?.confirmed !== true) throw new Error("provider deletion is not confirmed");
      event("vast", `${t.symbol}: instance ${t.vps.instanceId} deletion confirmed (${reason})`, { token: t.address });
    } catch (e) {
      pauseForReconciliation(t, `VPS deletion is unconfirmed; billing may continue (${reason})`, "stopping");
      event("vast", `${t.symbol}: cleanup unconfirmed for instance ${t.vps.instanceId}`, { token: t.address, level: "error" });
      save();
      throw e;
    }
  }
  return finalizeStopped(t, reason, 'explicit_delete');
}

function finalizeStopped(t, reason, source) {
  holdVpsUsageForReview(t, save);
  revokeVpsAuthority(t);
  const at = new Date().toISOString();
  stopVps(t, reason);
  record(t, { phase: "stopped", reconciliationRequired: false, cleanupConfirmedAt: at,
    cleanupProof: { instanceId: t.vps.instanceId, source, at }, cleanupReason: null,
    recovery: null,
    streamLive: false, remote: null, note: `stopped: ${reason}` });
  save();
  return { ok: true, stopped: true };
}

/// Periodic follow-up of every real deploy: vast.ai state, boot deadline, retries.
export async function poll() {
  const s = get();
  for (const t of Object.values(s.tokens)) {
    if (t.vps.mode !== "real" || !["booting", "ready", "live", "stopping"].includes(t.vps.phase) || lifecycleBusy.has(t.address.toLowerCase())) continue;
    await exclusive(t, () => pollToken(t));
  }
  save();
}

async function pollToken(t) {
    if (t.vps.phase === "stopping") {
      // Read first after an interrupted cleanup. A durable acknowledgement plus
      // exact absence confirms the earlier DELETE without sending another one.
      let remote = null, error = null;
      try { remote = await showInstance(t.vps.instanceId); } catch (e) { error = e; }
      const observation = providerObservation(remote, error);
      const acknowledged = t.vps.cleanupAcknowledgement?.instanceId === t.vps.instanceId;
      if (observation.kind === 'destroyed' || (acknowledged && (error?.providerStatus === 404 || error?.providerInstanceAbsent === true))) {
        finalizeStopped(t, t.vps.cleanupReason || 'confirmed earlier cleanup', observation.kind === 'destroyed' ? 'provider_destroyed' : 'acknowledged_delete_absent');
        return;
      }
      if (acknowledged) return; // Pending acknowledgement is polled, not resent.
      // A failed cleanup is retried, never replaced with another billed machine.
      try { await teardownInternal(t, t.vps.cleanupReason || "retry unconfirmed cleanup"); } catch { /* remains paused for the next poll */ }
      return;
    }
    const vps = t.vps, allocation = { instanceId: vps.instanceId, startedAt: vps.startedAt, registeredAt: vps.registeredAt };
    let remote = null, error = null;
    try { remote = await showInstance(allocation.instanceId); } catch (e) { error = e; }
    // An observation begun for an earlier allocation/registration cannot alter
    // the current lifetime after the asynchronous provider read returns.
    if (t.vps !== vps || t.vps.instanceId !== allocation.instanceId || t.vps.startedAt !== allocation.startedAt ||
        t.vps.registeredAt !== allocation.registeredAt) return;
    const now = Date.now(), observation = providerObservation(remote, error, now);
    record(t, { providerCheck: { instanceId: t.vps.instanceId, checkedAt: new Date(now).toISOString(), ok: Boolean(remote && !error),
      state: remote && !error && ['running','loading','created','stopped','exited','offline','destroyed','frozen','rebooting','unknown'].includes(remote.actualState) ? remote.actualState : null } });
    if (remote && !error) record(t, { remote });
    if (observation.kind === 'destroyed') {
      record(t, { lastIncident: { kind: 'provider_destroyed', instanceId: t.vps.instanceId, startedAt: t.vps.startedAt || null,
        ...incidentOrigin(t, observation, now), at: new Date(now).toISOString(), providerState: observation.evidence } });
      // The allocation is already gone. Never DELETE it again or buy inside the
      // observation loop; any later startup must pass the normal funding gates.
      finalizeStopped(t, 'provider confirmed instance destroyed', 'provider_destroyed');
      return;
    }
    const health = vpsHealthOf(t, now);
    observeRecovery(t, observation, { now, heartbeatFresh: health.agentOnline, streamReady: health.streamReady,
      allocation, streamMeasuredAt: health.streamMeasuredAt });
    // The provider confirming this exact machine running, with its runtime alive, closes an open
    // usage review: a control-plane timeout is not evidence that the paid container stopped.
    const resolved = resolveVpsUsageReview(t, save, { now, observation, health, allocation });
    if (resolved) event("vps", `${t.symbol}: server usage review closed — the provider confirms instance ${t.vps.instanceId} running with a live runtime; ${resolved.waivedHours} unbilled hour(s) since ${resolved.since || "the review"} waived, hourly billing resumes now`, { token: t.address });
    if (t.vps.recovery?.instanceId === t.vps.instanceId) holdVpsUsageForReview(t, save);
    if (t.vps.recovery?.instanceId === t.vps.instanceId && (t.vps.recovery.active || now < Number(t.vps.bootRecoveryGraceUntil))) {
      // Unknown/stopped allocations stay preserved. A confirmed return receives
      // one durable grace period before an unfinished initial boot may time out.
      save();
      return;
    }
    const awaitingFirstStream = !t.vps.firstStreamAt && (t.vps.phase === "booting" || (t.vps.startupBounded === true && t.vps.phase === "ready" && Number(t.vps.rentedAt) > 0));
    const setupFailed = /FAILED|registration refused/i.test(String(t.vps.bootStep || ""));
    if (awaitingFirstStream && (setupFailed || Date.now() - (t.vps.rentedAt || 0) > bootDeadlineMs(t))) {
      if (t.vps.attempts?.length) t.vps.attempts.at(-1).result = setupFailed ? "runtime setup failed" : "boot deadline passed";
      record(t, { note: setupFailed ? "Runtime setup failed; cleaning up the exact instance" : `instance ${t.vps.instanceId} did not produce its first stream within the bounded startup deadline — cleaning up` });
      if (setupFailed) {
        // An application/configuration error is not repaired by buying the same
        // runtime on another host. Pause before cleanup, including crash recovery.
        t.lock = { ...(t.lock || {}), state: "paused", note: "Runtime setup failed; awaiting a fix before another paid start" };
        save();
        try { await teardownInternal(t, "runtime setup failed"); } catch { /* cleanup retries without another purchase */ }
        return;
      }
      try { await teardownInternal(t, "boot timeout"); } catch { return; }
      await tryNext(t, t.vps.candidates || []);
    }
}

export function startPoller() {
  const timer = setInterval(() => poll().catch((e) => console.error("[deploy poll]", e.message)), POLL_MS);
  timer.unref?.();
  return timer;
}

export const hourlyMicrosOf = (offer) => toMicros(offer.dph);
