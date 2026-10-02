// Server-observed playback sessions, not website visits or unique people.
// MediaMTX v1.21 exposes hlsSession/webRTCSession readers. An older hlsMuxer
// reader is a shared muxer, NOT one viewer, and cannot produce a truthful count.
import { env } from "./env.mjs";

export const VIEWER_POLICY = Object.freeze({
  refreshEveryMs: 4000, staleAfterMs: 20_000, timeoutMs: 3000,
  itemsPerPage: 500, maxPages: 10, maxPageBytes: 1_048_576, maxReaders: 50_000,
});
// EVM tokens (any case) or base58 Solana mints (case-sensitive). Kept inline: the
// viewer tests load this file alone, so it must not import identity helpers.
const tokenPattern = /^(?:0[xX][0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const streamPath = /^live\/(0[xX][0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const tokenKey = (token) => (/^0x/i.test(token) ? token.toLowerCase() : token);
const failure = (reason) => Object.assign(new Error(reason), { reason });
const publicFailures = new Set(["telemetry_unavailable", "telemetry_limit", "invalid_telemetry", "inconsistent_snapshot", "telemetry_timeout"]);

async function boundedJSON(res) {
  if (!res.ok) throw failure("telemetry_unavailable");
  const declared = Number(res.headers.get("content-length"));
  if (declared > VIEWER_POLICY.maxPageBytes) throw failure("telemetry_limit");
  if (!res.body?.getReader) throw failure("invalid_telemetry");
  const reader = res.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > VIEWER_POLICY.maxPageBytes) throw failure("telemetry_limit");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(joined)); }
  catch { throw failure("invalid_telemetry"); }
}

// Dependency injection keeps tests entirely offline; the production singleton
// below only reads the configured loopback telemetry endpoint.
export function createViewerTracker({
  api = () => env("MEDIAMTX_API", "http://127.0.0.1:9997"),
  fetchFn = (...args) => fetch(...args), now = Date.now,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  let snapshot = new Map(), measuredAt = null, lastFailure = "not_sampled";
  let timer = null, inflight = null, controller = null, generation = 0;
  let everyMs = VIEWER_POLICY.refreshEveryMs;

  async function collect(signal) {
    const next = new Map();
    let expectedPages = null, expectedItems = null, items = 0, readerTotal = 0;
    const base = String(typeof api === "function" ? api() : api).replace(/\/$/, "");
    for (let page = 0; page < VIEWER_POLICY.maxPages; page++) {
      signal.throwIfAborted();
      const res = await fetchFn(`${base}/v3/paths/list?itemsPerPage=${VIEWER_POLICY.itemsPerPage}&page=${page}`, { signal });
      signal.throwIfAborted();
      const j = await boundedJSON(res);
      signal.throwIfAborted();
      if (!j || !Array.isArray(j.items) || !Number.isSafeInteger(j.pageCount) || j.pageCount < 0 ||
          !Number.isSafeInteger(j.itemCount) || j.itemCount < 0 || j.items.length > VIEWER_POLICY.itemsPerPage) throw failure("invalid_telemetry");
      if (j.pageCount > VIEWER_POLICY.maxPages || j.itemCount > VIEWER_POLICY.maxPages * VIEWER_POLICY.itemsPerPage) throw failure("telemetry_limit");
      if (expectedPages === null) { expectedPages = j.pageCount; expectedItems = j.itemCount; }
      if (j.pageCount !== expectedPages || j.itemCount !== expectedItems) throw failure("inconsistent_snapshot");
      items += j.items.length;
      for (const p of j.items) {
        if (!p || typeof p.name !== "string") throw failure("invalid_telemetry");
        const match = streamPath.exec(p.name);
        if (!match) continue;
        const token = tokenKey(match[1]);
        if (next.has(token)) throw failure("inconsistent_snapshot");
        const ready = typeof p.online === "boolean" ? p.online : p.ready;
        if (typeof ready !== "boolean" || !Array.isArray(p.readers)) throw failure("invalid_telemetry");
        readerTotal += p.readers.length;
        if (readerTotal > VIEWER_POLICY.maxReaders) throw failure("telemetry_limit");
        const rtc = new Set(), hls = new Set();
        let unsupported = false;
        for (const r of p.readers) {
          if (!r || typeof r.type !== "string") throw failure("invalid_telemetry");
          // Do not turn infrastructure readers or fuzzy type matches into people.
          if (r.type === "hlsMuxer") { unsupported = true; continue; }
          if (r.type !== "webRTCSession" && r.type !== "hlsSession") continue;
          if (typeof r.id !== "string" || !r.id || r.id.length > 128) throw failure("invalid_telemetry");
          (r.type === "webRTCSession" ? rtc : hls).add(r.id);
        }
        next.set(token, { viewers: rtc.size + hls.size, webrtc: rtc.size, hls: hls.size, ready, unsupported });
      }
      if (page + 1 >= expectedPages) {
        if (items !== expectedItems || (expectedPages === 0 && items !== 0)) throw failure("inconsistent_snapshot");
        return next;
      }
    }
    throw failure("telemetry_limit");
  }

  function refresh() {
    if (inflight) return inflight;
    const gen = generation, abort = new AbortController();
    controller = abort;
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeoutFn(() => { abort.abort(); reject(failure("telemetry_timeout")); }, VIEWER_POLICY.timeoutMs);
      timeout?.unref?.();
    });
    // One overall deadline covers pagination AND response bodies; a provider that
    // ignores abort cannot later overwrite a newer snapshot.
    inflight = Promise.race([collect(abort.signal), expired]).then((next) => {
      if (gen !== generation) return false;
      snapshot = next; measuredAt = now(); lastFailure = null;
      return true;
    }).catch((e) => {
      if (gen === generation) lastFailure = publicFailures.has(e?.reason) ? e.reason : "telemetry_unavailable";
      return false;
    }).finally(() => {
      clearTimeoutFn(timeout);
      if (controller === abort) controller = null;
      inflight = null;
    });
    return inflight;
  }

  function viewersOf(token) {
    const validToken = typeof token === "string" && tokenPattern.test(token);
    const ageMs = measuredAt === null ? null : Math.max(0, now() - measuredAt);
    const telemetryFresh = validToken && measuredAt !== null && !lastFailure && ageMs <= VIEWER_POLICY.staleAfterMs;
    const c = validToken ? snapshot.get(tokenKey(token)) : undefined;
    const known = telemetryFresh && !c?.unsupported;
    const reason = !validToken ? "invalid_token" : lastFailure ||
      (!telemetryFresh ? "sample_expired" : c?.unsupported ? "unsupported_hls_reader" : null);
    return {
      viewers: known ? c?.viewers ?? 0 : null,
      webrtc: known ? c?.webrtc ?? 0 : null, hls: known ? c?.hls ?? 0 : null,
      status: known ? "fresh" : validToken && measuredAt !== null && !telemetryFresh ? "stale" : "unavailable",
      telemetryFresh, ready: telemetryFresh ? c?.ready ?? false : null,
      measuredAt: measuredAt === null ? null : new Date(measuredAt).toISOString(), ageMs,
      source: "mediamtx", metric: "active-playback-sessions", protocols: ["webrtc", "hls"],
      refreshEveryMs: everyMs, staleAfterMs: VIEWER_POLICY.staleAfterMs, reason,
    };
  }

  function start(every = VIEWER_POLICY.refreshEveryMs) {
    if (timer !== null) return timer;
    everyMs = Number.isFinite(every) ? Math.min(30_000, Math.max(1000, Math.floor(every))) : VIEWER_POLICY.refreshEveryMs;
    timer = setIntervalFn(refresh, everyMs);
    timer?.unref?.();
    void refresh();
    return timer;
  }
  function stop() {
    if (timer !== null) clearIntervalFn(timer);
    timer = null; generation++; lastFailure = "poll_stopped"; controller?.abort();
  }
  return { refresh, viewersOf, start, stop };
}

const tracker = createViewerTracker();
export const startViewerPoll = (everyMs) => tracker.start(everyMs);
export const stopViewerPoll = () => tracker.stop();
export const viewersOf = (token) => tracker.viewersOf(token);
