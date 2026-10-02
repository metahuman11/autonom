// One read-only funding projection for the directory, room and setup views.
// Project funds include current wallet money and verified current creator rewards.
// Billing eligibility is separate and always remains a server decision.
globalThis.GatewayProjectFunds = (() => {
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function model(t) {
    const spendableUsd = [t.funding?.treasuryUsd,t.lock?.treasuryUsd,t.budget?.remainingUsd].find(finite) ?? null;
    const fees = t.creatorFees;
    const expired = t.clientSnapshotExpired === true;
    const pendingUsd = expired ? null : fees ? (fees.fresh === true && finite(fees.pendingUsd) ? fees.pendingUsd : null) : t.onchain?.pump ? null : 0;
    const sum = spendableUsd !== null && pendingUsd !== null && !expired ? spendableUsd + pendingUsd : null;
    const totalUsd = finite(sum) ? sum : null;
    const targetUsd = [t.funding?.activationUsd,t.lock?.activationUsd,t.plan?.activationUsd].find(value => finite(value) && value > 0) ?? null;
    const realRunning = t.vps?.mode === 'real' && t.vps?.state === 'running';
    const running = realRunning && t.lock?.state !== 'paused' && t.funding?.state !== 'paused';
    const initialFunded = t.startup?.fundingComplete === true || t.launchPackage?.funded === true || realRunning;
    const targetReached = initialFunded || targetUsd !== null && totalUsd !== null && totalUsd >= targetUsd;
    const progressPct = initialFunded ? 100 : targetUsd !== null && totalUsd !== null ? Math.round(Math.min(100,totalUsd / targetUsd * 100) * 10) / 10 : null;
    const remainingUsd = targetReached ? 0 : targetUsd !== null && totalUsd !== null ? Math.max(0,Math.round((targetUsd - totalUsd) * 1e6) / 1e6) : null;
    const pendingCollection = !initialFunded && targetUsd !== null && totalUsd !== null && totalUsd >= targetUsd && spendableUsd < targetUsd;
    return {totalUsd,spendableUsd,pendingUsd,targetUsd,remainingUsd,progressPct,targetReached,initialFunded,pendingCollection,running};
  }
  return {model};
})();

// Shared server-pushed snapshots. Poll only if the stream is unavailable.
globalThis.GatewayLiveToken = function ({ token, render, status = () => {}, onSnapshot = () => {} }) {
  const MAX_SNAPSHOT_AGE_MS = 20000;
  const clock = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  let source = null, fallback = null, freshness = null, stopped = true, eventVersion = 0, pending = null;
  let latest = null, receivedAt = 0, receivedWallAt = 0, displayedFreshness = null, renderedKey = null;

  function stamp(data) {
    if (Number.isSafeInteger(data?.snapshotAtMs) && data.snapshotAtMs > 0 &&
        Number.isSafeInteger(data?.snapshotSequence) && data.snapshotSequence >= 0)
      return { at: data.snapshotAtMs, sequence: data.snapshotSequence };
    const at = Date.parse(data?.vps?.health?.checkedAt || '');
    return Number.isFinite(at) && at > 0 ? { at, sequence: null } : null;
  }
  function cosmeticKey(data) {
    // Evidence is refreshed on every accepted snapshot, but clock-only metadata
    // must not rebuild charts, forms, funding bars or the mascot every four seconds.
    return JSON.stringify({ ...data, snapshotAtMs: undefined, snapshotSequence: undefined,
      budget: data.budget ? { ...data.budget, validUntil: undefined } : undefined,
      dexPayments: data.dexPayments ? { ...data.dexPayments, serverTime: undefined } : undefined,
      agent: data.agent ? { ...data.agent, lastHeartbeatAt: undefined } : undefined,
      viewers: data.viewers ? { ...data.viewers, ageMs: undefined, measuredAt: undefined } : undefined,
      vps: data.vps ? { ...data.vps, health: data.vps.health ? { ...data.vps.health,
        checkedAt: undefined, streamMeasuredAt: undefined, lastHeartbeatAt: undefined,
        heartbeatAgeSeconds: undefined, startupAgeSeconds: undefined } : undefined } : undefined,
    });
  }

  function presentLatest(force = false) {
    if (stopped || !latest) return;
    // Relative client receipt time, not server/client clock comparison. Wall-time
    // delta also catches browsers whose monotonic clock pauses during device sleep.
    const elapsed = Math.max(0, clock() - receivedAt, Date.now() - receivedWallAt);
    const v = latest.viewers;
    const limit = Number.isFinite(v?.staleAfterMs) && v.staleAfterMs > 0 ? Math.min(MAX_SNAPSHOT_AGE_MS, v.staleAfterMs) : MAX_SNAPSHOT_AGE_MS;
    const age = Number.isFinite(v?.ageMs) && v.ageMs >= 0 ? v.ageMs : 0;
    const snapshotStale = elapsed > MAX_SNAPSHOT_AGE_MS;
    const viewerStale = v?.telemetryFresh === true && age + elapsed > limit;
    const key = `${snapshotStale}:${viewerStale}`;
    if (!force && key === displayedFreshness) return;
    displayedFreshness = key;
    // Never mutate the saved DTO or financial/governance fields. Local expiry
    // changes presentation only and is never an authorization/control message.
    const data = JSON.parse(JSON.stringify(latest));
    // Display-only flag: preserve real error states while allowing every setup
    // consumer to stop presenting old purchases as current activity.
    data.clientSnapshotExpired = snapshotStale;
    if ((viewerStale || snapshotStale) && data.viewers) {
      data.viewers = { ...data.viewers, viewers: null, webrtc: null, hls: null,
        status: data.viewers.measuredAt || data.viewers.telemetryFresh ? 'stale' : 'unavailable',
        telemetryFresh: false, ready: null, ageMs: age + elapsed, reason: 'client_snapshot_expired' };
      if (data.vps?.health) data.vps.health = { ...data.vps.health, streamReady: null, streamTelemetry: 'stale',
        ...(data.vps.health.status === 'live' ? { status: 'stream_check_unavailable', message: 'Waiting for a fresh live screen update' } : {}) };
    }
    if (snapshotStale) {
      if (data.runtime) data.runtime = { ...data.runtime, online: false, chat: false, files: false, preview: false, status: 'waiting_for_heartbeat' };
      if (data.vps?.health) {
        const preserve = ['paused', 'stopping', 'stopped', 'simulation', 'attention_required'].includes(data.vps.health.status);
        data.vps.health = { ...data.vps.health, agentOnline: false, streamReady: null, streamTelemetry: 'stale',
          ...(preserve ? {} : { status: 'connection_stale', message: 'Waiting for a fresh project update' }) };
      }
      status('reconnecting'); polling();
    }
    if (data.startup?.version === 1 && (snapshotStale || (viewerStale && data.startup.state === 'live')) &&
        !['paused','stopping','attention_required','simulation'].includes(data.startup.state)) {
      data.startup = { ...data.startup, state: 'reconnecting', title: 'Waiting for a fresh project update',
        detail: snapshotStale ? 'Connection interrupted. The last setup status is out of date; reconnecting automatically.' : 'The agent is online, but a fresh live-screen update is needed.',
        nextRetryAt: null,
        steps: (data.startup.steps || []).map(step => ['stream', ...(snapshotStale ? ['agent'] : [])].includes(step.id) ? { ...step, status: 'pending' } : step) };
    }
    // vps.streamLive is intentionally retained so a telemetry outage does not
    // disconnect video that is still playing independently of this data stream.
    const keyForRender = cosmeticKey(data);
    if (keyForRender !== renderedKey) { render(data); renderedKey = keyForRender; }
  }
  function accept(data) {
    const incoming = stamp(data), previous = stamp(latest);
    if (previous && (!incoming || incoming.at < previous.at || (incoming.at === previous.at &&
        (incoming.sequence === null || previous.sequence === null || incoming.sequence <= previous.sequence)))) return false;
    latest = data; receivedAt = clock(); receivedWallAt = Date.now();
    // Lightweight consumers (e.g. the DEX proposal deadline's server-clock
    // anchor) still receive fresh evidence when no visible content changed.
    try { onSnapshot(JSON.parse(JSON.stringify(data))); } catch { /* One observer must not break the data feed. */ }
    presentLatest(true);
    return true;
  }
  async function refresh() {
    if (stopped || pending) return pending?.promise;
    const version = eventVersion;
    const request = { controller: new AbortController(), timer: null, promise: null };
    pending = request;
    request.timer = setTimeout(() => request.controller.abort(), 10000);
    request.promise = (async () => {
      try {
        const res = await fetch(`/api/site/token/${token}`, { cache: "no-store", signal: request.controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        const ordered = stamp(data) && stamp(latest);
        if (!stopped && pending === request && (version === eventVersion || ordered) &&
            String(data?.address).toLowerCase() === token.toLowerCase()) accept(data);
      } catch { /* Keep the last valid snapshot while reconnecting. */ }
      finally { clearTimeout(request.timer); if (pending === request) pending = null; }
    })();
    return request.promise;
  }
  function polling() { if (!fallback && !stopped) fallback = setInterval(refresh, 2500); }
  function start() {
    if (!stopped) return;
    stopped = false; status("connecting");
    freshness = setInterval(() => presentLatest(), 1000);
    presentLatest(); refresh();
    if (typeof EventSource === "undefined") { status("reconnecting"); polling(); return; }
    let current;
    try { current = new EventSource(`/api/site/token/${token}/events`); }
    catch { status("reconnecting"); polling(); return; }
    source = current;
    current.addEventListener("token", (event) => {
      if (stopped || source !== current) return;
      try {
        const data = JSON.parse(event.data);
        if (String(data.address).toLowerCase() !== token.toLowerCase()) return;
        if (!accept(data)) return;
        eventVersion++;
        clearInterval(fallback); fallback = null; status("live");
      } catch { status("reconnecting"); polling(); }
    });
    current.onerror = () => {
      if (stopped || source !== current) return;
      status("reconnecting"); polling(); // EventSource itself reconnects, no extra stream.
    };
  }
  function stop() {
    stopped = true; eventVersion++; source?.close(); source = null;
    clearInterval(fallback); fallback = null; clearInterval(freshness); freshness = null;
    if (pending) { pending.controller.abort(); clearTimeout(pending.timer); pending = null; }
  }
  return { start, stop, refresh };
};
