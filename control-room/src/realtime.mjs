// Public snapshots and authenticated inbox wake-ups. No model calls, credentials,
// transaction execution or control commands are accepted through this transport.
// Group key helper kept inline: realtime-ui.test evaluates this source in a vm without imports.
const identityKey = (v) => (/^0x/i.test(String(v)) ? String(v).toLowerCase() : String(v));

export function createRealtime({ snapshot, subscribe, hasInbox, maxClients = 512, maxPerToken = 256, maxWaiters = 128 }) {
  const groups = new Map(), waiters = new Set();
  let clients = 0, pending = null, closed = false;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  function frame(group, force = false) {
    const data = snapshot(group.token);
    // Global store updates must not fan out every token solely because its
    // measurement clocks changed. The 4s forced frame renews evidence separately.
    const key = JSON.stringify({ ...data, snapshotAtMs: undefined, snapshotSequence: undefined,
      budget: data.budget ? { ...data.budget, validUntil: undefined } : undefined,
      dexPayments: data.dexPayments ? { ...data.dexPayments, serverTime: undefined } : undefined,
      agent: data.agent ? { ...data.agent, lastHeartbeatAt: undefined } : undefined,
      viewers: data.viewers ? { ...data.viewers, ageMs: undefined, measuredAt: undefined } : undefined,
      vps: data.vps ? { ...data.vps, health: data.vps.health ? { ...data.vps.health,
        checkedAt: undefined, streamMeasuredAt: undefined, lastHeartbeatAt: undefined,
        heartbeatAgeSeconds: undefined, startupAgeSeconds: undefined } : undefined } : undefined,
    });
    if (!force && key === group.key) return false;
    const encoded = JSON.stringify(data);
    if (Buffer.byteLength(encoded) > 1_000_000) throw fail(503, "live snapshot too large");
    group.key = key;
    group.frame = `event: token\ndata: ${encoded}\n\n`;
    return true;
  }
  function write(res, data) {
    if (res.destroyed || res.writableEnded) return;
    // Never accumulate snapshots for a slow reader. EventSource reconnects to latest.
    if (res.writableLength > 256_000) { res.destroy(); return; }
    // A single normal snapshot may exceed Node's high-water mark. Let it drain;
    // only a still-buffered client at the next update/heartbeat is disconnected.
    res.write(data);
  }
  function flush(force = false) {
    clearTimeout(pending);
    pending = null;
    if (closed) return;
    for (const group of groups.values()) {
      try {
        const changed = frame(group, force);
        if (changed || group.dirty) {
          group.dirty = false;
          for (const res of group.clients) write(res, group.frame);
        }
      }
      catch { for (const res of [...group.clients]) res.destroy(); }
    }
  }
  const unsubscribe = subscribe(() => {
    for (const waiter of [...waiters]) waiter.check();
    if (!pending && groups.size && !closed) { pending = setTimeout(flush, 25); pending.unref?.(); }
  });
  const heartbeat = setInterval(() => {
    flush(true); // shared reconciliation, not one poll per viewer
    for (const group of groups.values()) for (const res of group.clients) write(res, ": keepalive\n\n");
  // Viewer telemetry is an in-memory snapshot and does not call store.save().
  // Reconcile once per token (not once per viewer) promptly after its 4s poll.
  // This adds no provider requests, database writes or browser polling.
  }, 4_000);
  heartbeat.unref?.();

  return {
    stream(req, res, token) {
      // Group key: lowercase for EVM tokens, verbatim for base58 Solana mints.
      token = identityKey(token);
      if (closed || clients >= maxClients || (groups.get(token)?.clients.size || 0) >= maxPerToken) throw fail(503, "live connection limit reached");
      let group = groups.get(token);
      if (!group) {
        group = { token, clients: new Set(), key: null, frame: null };
        frame(group); // validate before sending HTTP headers
        groups.set(token, group);
      } else if (frame(group, true)) {
        // A newcomer can already have a newer HTTP snapshot. Never greet it with
        // a cached older SSE frame. Existing peers get one coalesced update, not
        // quadratic fanout when many viewers join the same channel together.
        group.dirty = true;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
      res.flushHeaders();
      req.socket.setTimeout(0);
      group.clients.add(res); clients++;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return; cleaned = true;
        group.clients.delete(res); clients--;
        if (!group.clients.size) groups.delete(token);
      };
      res.once("close", cleanup); res.once("error", cleanup);
      write(res, "retry: 2000\n\n" + group.frame);
    },
    waitInbox(token, cursor, milliseconds, signal) {
      if (closed || signal?.aborted) return Promise.resolve();
      if (hasInbox(token, cursor)) return Promise.resolve();
      if (waiters.size >= maxWaiters || [...waiters].filter(w => w.token === token).length >= 2) throw fail(429, "inbox wait limit reached");
      return new Promise((resolve) => {
        let timer;
        const finish = () => { clearTimeout(timer); waiters.delete(waiter); signal?.removeEventListener("abort", finish); resolve(); };
        const waiter = { token, finish, check() { try { if (hasInbox(token, cursor)) finish(); } catch { finish(); } } };
        waiters.add(waiter);
        timer = setTimeout(finish, Math.min(25_000, Math.max(0, milliseconds))); timer.unref?.();
        signal?.addEventListener("abort", finish, { once: true });
        waiter.check(); // closes the snapshot-to-subscription race
      });
    },
    close() {
      closed = true; unsubscribe(); clearTimeout(pending); clearInterval(heartbeat);
      for (const w of [...waiters]) w.finish();
      for (const g of [...groups.values()]) for (const res of [...g.clients]) res.destroy();
    },
    counts: () => ({ clients, groups: groups.size, waiters: waiters.size }),
  };
}
