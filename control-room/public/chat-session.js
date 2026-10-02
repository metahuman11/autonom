(function (root) {
  "use strict";
  root.GatewayChatSession = function ({ token, origin, sign, nonce, requestId, fetch: fetcher = root.fetch.bind(root), now = Date.now }) {
    let holder = null, version = 0, expires = 0, queue = Promise.resolve(), retry = null;
    const run = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
    async function api(route, body) {
      const r = await fetcher(`/api/site/holder/${token}/${route}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(root.AbortSignal?.timeout ? { signal: root.AbortSignal.timeout(20_000) } : {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || "Could not send. Please try again."), { status: r.status });
      return j;
    }
    // EVM addresses are case-insensitive and travel lowercased; a Solana address is base58 and
    // case-sensitive — lowercasing it makes the server refuse it (400) and breaks the signature.
    const canonical = a => (!a ? null : /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : String(a));
    const current = v => { if (v !== version || !holder) throw new Error("Wallet changed. Please send again from the connected wallet."); };
    return {
      active: () => !!holder && expires > now(),
      setWallet(address, { revoke = true } = {}) {
        holder = canonical(address); version++; expires = 0; retry = null;
        const v = version;
        return run(async () => {
          if (revoke) await api("chat-logout", {});
          if (v !== version || !holder) return;
          const s = await api("chat-status", { holder });
          if (v === version) expires = s.active ? Date.parse(s.expiresAt) : 0;
        });
      },
      send(text, onApproval = () => {}) {
        const v = version, wallet = holder;
        return run(async () => {
          current(v);
          if (expires <= now()) {
            const s = await api("chat-status", { holder: wallet }); current(v);
            if (s.active) expires = Date.parse(s.expiresAt);
            else {
              onApproval();
              const payload = { schemaVersion: 1, type: "holder_chat_session", tokenAddress: token, holder: wallet, timestamp: new Date(now()).toISOString(), nonce: nonce(), origin, chainId: s.chainId, scope: "chat", expiresAt: new Date(now() + 3_600_000).toISOString(), statement: s.statement };
              const signature = await sign(payload, wallet); current(v);
              const granted = await api("chat-session", { payload, signature });
              if (v !== version) { await api("chat-logout", {}); current(v); }
              expires = Date.parse(granted.expiresAt);
            }
          }
          current(v);
          // Keep the request id after an uncertain network failure. A retry must
          // not enqueue the same message twice or consume another AI reply.
          if (!retry || retry.text !== text || retry.holder !== wallet) retry = { holder: wallet, text, requestId: requestId() };
          try {
            const result = await api("chat-message", retry); current(v); retry = null; return result;
          } catch (e) { if (e.status === 401) expires = 0; throw e; }
        });
      },
    };
  };
})(globalThis);
