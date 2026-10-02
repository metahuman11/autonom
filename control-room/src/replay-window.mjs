// Keep a nonce for the entire acceptance window, including future-dated
// signatures. Capacity pressure must never make a fresh signature reusable.
export const SIGNATURE_FRESH_MS = 10 * 60_000;
export function consumeReplayNonce(nonces, nonce, now = Date.now(), capacity = 20_000) {
  const fail = (status, message) => Object.assign(new Error(message), {status});
  for (const [key, usedAt] of Object.entries(nonces)) {
    if (Number.isFinite(usedAt) && now - usedAt > 2 * SIGNATURE_FRESH_MS) delete nonces[key];
  }
  if (Object.hasOwn(nonces, nonce)) throw fail(409, 'nonce already used');
  if (Object.keys(nonces).length >= capacity) throw fail(429, 'signature replay window is full; retry with a new signature later');
  nonces[nonce] = now;
}
