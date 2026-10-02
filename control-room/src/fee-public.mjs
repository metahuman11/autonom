// Pure public projection of an observed creator-fee vault. It grants no payment authority.
const LAMPORTS = 1_000_000_000;
const FRESH_MS = 90_000;
const uint = n => Number.isSafeInteger(n) && n >= 0;
const address = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const reasons = new Set(['below_minimum', 'gas_required', 'ready', 'pending', 'creator_mismatch']);

export function publicCreatorFees(t, { now = Date.now() } = {}) {
  if (t?.chain !== 'solana' || t?.launchIdentity?.kind !== 'pump') return null;
  const r = t.creatorFeeObservation, at = Date.parse(r?.observedAt || ''), clock = typeof now === 'function' ? now() : now;
  const valid = r?.version === 1 && r.mint === t.address && r.treasury === t.treasury?.wallet &&
    address(r.vault) && ['curve', 'pool'].includes(r.kind) && reasons.has(r.reason) &&
    [r.claimableLamports, r.treasuryLamports, r.thresholdLamports, r.gasReserveLamports].every(uint) &&
    r.thresholdLamports > 0 && typeof r.creatorMatches === 'boolean' && Number.isFinite(at);
  const fresh = valid && Number.isFinite(clock) && at <= clock && clock - at <= FRESH_MS &&
    !(Number.isFinite(Date.parse(r.errorAt || '')) && Date.parse(r.errorAt) >= at);
  const pendingLamports = fresh && r.creatorMatches ? r.claimableLamports : null;
  const price = Number(t.treasury?.solUsd), pendingSol = pendingLamports === null ? null : pendingLamports / LAMPORTS;
  const sponsorConfigured = valid && r.kind === 'curve' && r.sponsorConfigured === true && r.gasFunding === 'platform';
  const sponsorAt = Date.parse(r?.sponsorCheckedAt || '');
  const sponsorConnected = fresh && sponsorConfigured && r.sponsorConnected === true &&
    Number.isFinite(sponsorAt) && sponsorAt <= clock && clock - sponsorAt <= FRESH_MS;
  const gasBlocked = !fresh || !r.creatorMatches ? null : !sponsorConfigured ? r.treasuryLamports < r.gasReserveLamports :
    !sponsorConnected ? null : r.sponsorReason === 'CLAIM_SPONSOR_UNFUNDED' ? true :
    ['signed','submitted','uncertain','confirmed'].includes(r.sponsorState) ? false : null;
  return {
    source: 'pump_creator_vault', currency: 'SOL', observedAt: valid ? r.observedAt : null, fresh,
    pendingLamports, pendingSol, pendingUsd: pendingSol !== null && Number.isFinite(price) && price > 0 ? Math.round(pendingSol * price * 100) / 100 : null,
    thresholdLamports: valid ? r.thresholdLamports : 100_000_000,
    thresholdSol: (valid ? r.thresholdLamports : 100_000_000) / LAMPORTS,
    gasBlocked, gasPayer: sponsorConfigured ? 'platform' : 'project', sponsorConfigured, sponsorConnected,
    reason: t.lock?.state === 'paused' ? 'paused' : !fresh ? 'unavailable' : r.reason,
  };
}
