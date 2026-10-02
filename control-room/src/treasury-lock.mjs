// Central gateway, single writer. The durable journal also blocks after restart.
// Other processes must never share custody of these treasury keys.
const active = new Set();
export function assertTreasuryClear(t) {
  const rows = Object.values(t.communityActionReservations || {});
  if (rows.some(r => !['settled', 'released'].includes(r.state))) {
    throw Object.assign(new Error('Community transaction pending; reconcile before another treasury transaction'), {status:409});
  }
}
/// One lock per treasury wallet, on either chain: EVM keys are case-insensitive, Solana keys
/// are base58 and case-sensitive. A Solana treasury used to be refused here, which made every
/// Solana billing entry point throw (review 2026-09-21).
export function treasuryLockKey(t) {
  const wallet = String(t?.treasury?.wallet || '');
  if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) return `evm:${wallet.toLowerCase()}`;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return `solana:${wallet}`;
  return null;
}
export async function withTreasuryLock(t, task) {
  const key = treasuryLockKey(t);
  if (!key) throw new Error('Treasury address required');
  if (active.has(key)) throw Object.assign(new Error('Treasury is processing another transaction; retry later'), {status:409});
  active.add(key);
  try { return await task(); } finally { active.delete(key); }
}
export function withBillingTreasury(t, task) {
  return withTreasuryLock(t, async () => { assertTreasuryClear(t); return task(); });
}
