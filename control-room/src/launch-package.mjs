// Launch-time commercial terms, separate from optional community proposals.
// Pure functions: no wallet, network, secret or environment access.
import { createHash } from 'node:crypto';
const MICRO = 1_000_000;
export const LAUNCH_PACKAGE_V1 = Object.freeze({
  version: 1, required: true, activationMicros: 500 * MICRO,
  dexBudgetMicros: 300 * MICRO, operatingMicros: 200 * MICRO,
  product: 'enhanced-token-info', provider: 'dexscreener',
  fundingSource: 'creator_tax_and_deposits',
});
export const LAUNCH_PACKAGE_V2 = Object.freeze({
  version: 2, required: true, activationMicros: 420 * MICRO,
  dexBudgetMicros: 300 * MICRO, socialAccountBudgetMicros: 10 * MICRO,
  operatingMicros: 110 * MICRO,
  product: 'enhanced-token-info', provider: 'dexscreener',
  fundingSource: 'creator_tax_and_deposits',
});
// v3 (owner decision 2026-09-21): $310 goes to the platform's Solana USDC wallet at
// funding (it pays DEX Screener and the bridge/network costs), $10 to the platform
// operations wallet for the project's X account, $100 stays as AI/VPS operating funds.
export const LAUNCH_PACKAGE_V3 = Object.freeze({
  version: 3, required: true, activationMicros: 420 * MICRO,
  dexBudgetMicros: 310 * MICRO, socialAccountBudgetMicros: 10 * MICRO,
  operatingMicros: 100 * MICRO,
  product: 'enhanced-token-info', provider: 'dexscreener',
  fundingSource: 'creator_tax_and_deposits',
});
// v4: DEX Screener is no longer a mandatory launch allocation. Existing
// payment commitments keep their original terms and settlement evidence.
export const LAUNCH_PACKAGE_V4 = Object.freeze({
  version: 4, required: true, activationMicros: 110 * MICRO,
  dexBudgetMicros: 0, socialAccountBudgetMicros: 10 * MICRO,
  operatingMicros: 100 * MICRO,
  product: 'project-operations', provider: 'autonom',
  fundingSource: 'creator_tax_and_deposits',
});
export const LAUNCH_PACKAGE_V5 = Object.freeze({
  version: 5, required: true, activationMicros: 5 * MICRO,
  dexBudgetMicros: 310 * MICRO, socialAccountBudgetMicros: 20 * MICRO, operatingMicros: 5 * MICRO,
  totalOnboardingMicros: 335 * MICRO, maxVpsHourlyMicros: MICRO, staged: true,
  product: 'staged-project-setup', provider: 'autonom', fundingSource: 'creator_tax_and_deposits',
});
export const LAUNCH_PACKAGE = LAUNCH_PACKAGE_V5;
const versions = Object.freeze({ 1: LAUNCH_PACKAGE_V1, 2: LAUNCH_PACKAGE_V2, 3: LAUNCH_PACKAGE_V3, 4: LAUNCH_PACKAGE_V4, 5: LAUNCH_PACKAGE_V5 });
const termsError = () => Object.assign(new Error('Launch package terms require review'), { status: 409 });
export function newLaunchPackage(version = LAUNCH_PACKAGE.version) {
  if (!Number.isInteger(version) || !Object.hasOwn(versions, version)) throw termsError();
  return { ...versions[version] };
}
export function assertLaunchPackage(value) {
  const expected = value && Object.hasOwn(value, 'version') && Number.isInteger(value.version) &&
    Object.hasOwn(versions, value.version) ? versions[value.version] : null;
  if (!expected || Reflect.ownKeys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, required]) => !Object.hasOwn(value, key) || value[key] !== required))
    throw termsError();
  return value;
}
// Persisted terms, not the current default, govern an existing project's money.
export function packageTerms(t) {
  if (t.launchPackage == null) return null;
  const original = assertLaunchPackage(t.launchPackage), upgrade = t.launchPackageUpgrade;
  if (upgrade === undefined) return original;
  if (!upgrade || Reflect.ownKeys(upgrade).length !== 4 || upgrade.version !== 1 ||
      upgrade.sourceFingerprint !== upgradeFingerprint(t) || !Number.isFinite(Date.parse(upgrade.adoptedAt || '')) ||
      assertLaunchPackage(upgrade.terms).version !== 5 || original.version >= 5)
    throw Object.assign(new Error('Launch policy upgrade requires review'), { status: 409 });
  return upgrade.terms;
}

const upgradeFingerprint = t => createHash('sha256').update(JSON.stringify({ terms: t.launchPackage,
  chain: t.chain, address: t.address, wallet: t.treasury?.wallet, launchTx: t.onchain?.launchTx })).digest('hex');
// Only projects with no previous setup, purchase, rental, AI spend or uncertain
// liability can adopt the new ordering. The original signed terms remain intact.
export function canAdoptStagedPackage(t) {
  if (!t.launchPackage || assertLaunchPackage(t.launchPackage).version >= 5 || t.launchPackageUpgrade !== undefined ||
      t.launchPackageRun != null || t.social?.x || t.social?.xIdentity || t.vps?.instanceId || t.vps?.pendingCreate ||
      t.vps?.reconciliationRequired || ['running','renting','booting','stopping'].includes(t.vps?.state) ||
      ['renting','booting','stopping','reconciliation_required'].includes(t.vps?.phase)) return false;
  for (const key of ['usageReservations','proposalUsageReservations','vpsUsageReservations','bridgeUsageReservations',
    'communityActionReservations','missionUsageReservations','packageUsageReservations','packageBridgeReservations','aiUsageReservations','aiDirectPayments']) {
    if (t[key] != null && (!record(t[key]) || Object.keys(t[key]).length)) return false;
  }
  if ((t.aiAccountUsage?.unsettledMicros || 0) || (t.aiAccountUsage?.settledMicros || 0) || (t.socialUsage?.unsettledMicros || 0) || (t.socialUsage?.settledMicros || 0)) return false;
  if (t.treasury?.ledger != null && (!Array.isArray(t.treasury.ledger) || t.treasury.ledger.some(row =>
      !record(row) || !Number.isSafeInteger(row.deltaMicros) || row.deltaMicros < 0 || row.socialAccountJobId || row.launchPackageJobId))) return false;
  return true;
}
export function adoptStagedPackage(t, { now = Date.now() } = {}) {
  if (!canAdoptStagedPackage(t)) return false;
  t.launchPackageUpgrade = { version: 1, sourceFingerprint: upgradeFingerprint(t), terms: newLaunchPackage(5), adoptedAt: new Date(now).toISOString() };
  return true;
}
export const isStagedLaunch = t => packageTerms(t)?.version === 5;
export const launchProjectKey = t => `${t.chain}:${isStagedLaunch(t) && t.chain === 'solana' ? String(t.address) : String(t.address).toLowerCase()}`;
export const launchTreasuryKey = t => isStagedLaunch(t) && t.chain === 'solana' ? String(t.treasury?.wallet) : String(t.treasury?.wallet).toLowerCase();
export const operationalAiLiquidityMicros = t => isStagedLaunch(t) ? MICRO : 0;
export function runtimeVpsReserveMicros(t, { now = Date.now() } = {}) {
  if (!isStagedLaunch(t)) return 0;
  const hourly = Number(t.vps?.hourlyMicros || Math.ceil(Number(t.plan?.offer?.dph || 0) * MICRO));
  if (!Number.isSafeInteger(hourly) || hourly <= 0) return 2 * MICRO;
  const last = typeof (t.vps?.lastBilledAt || t.vps?.startedAt) === 'number' ? (t.vps.lastBilledAt || t.vps.startedAt) : Date.parse(t.vps?.lastBilledAt || t.vps?.startedAt || '');
  const owed = t.vps?.state === 'running' && Number.isFinite(last) ? Math.max(0, Math.floor((now - last) / 3_600_000)) : 0;
  return hourly * Math.max(2, owed + 1);
}
export const operationalReserveMicros = (t, opts) => runtimeVpsReserveMicros(t, opts) + operationalAiLiquidityMicros(t);
const timeOf = value => typeof value === 'number' ? value : Date.parse(value || '');
export function runtimeStageReady(t, { now = Date.now() } = {}) {
  if (!isStagedLaunch(t)) return true;
  const v = t.vps || {}, registered = timeOf(v.registeredAt), rented = timeOf(v.rentedAt || v.startedAt), heartbeat = timeOf(t.agent?.lastHeartbeatAt);
  return isPackageFunded(t) && t.lock?.state !== 'paused' && t.agent?.state !== 'paused' &&
    v.mode === 'real' && v.state === 'running' && Number.isSafeInteger(v.instanceId) && v.instanceId > 0 &&
    Number.isSafeInteger(v.hourlyMicros) && v.hourlyMicros > 0 && v.hourlyMicros <= packageTerms(t).maxVpsHourlyMicros &&
    !v.reconciliationRequired && !v.pendingCreate && !v.recovery?.active && !['stopping','reconciliation_required'].includes(v.phase) &&
    Number.isFinite(rented) && Number.isFinite(registered) && registered >= rented &&
    Number.isFinite(heartbeat) && heartbeat >= registered && heartbeat <= now && now - heartbeat <= 90_000;
}
import { X_FEATURE_ENABLED } from './x-feature.mjs';
export const socialStageComplete = t => !X_FEATURE_ENABLED || socialAccountFundingCreditMicros(t) > 0;
/// Enhanced Token Info that DEX Screener's public orders API reports as approved although Autonom never
/// paid for it (the creator bought it directly, AUTONOM 2026-10-02): the stage is complete and the
/// $310 reserve is released, with no treasury payment and no broker order.
export const externalListingVerified = d => record(d?.externalListing) && d.externalListing.verified === true &&
  d.externalListing.status === 'approved' && typeof d.externalListing.type === 'string' && d.state === 'settled' && d.publication === 'published';
export const dexStageComplete = t => {
  const terms = packageTerms(t), d = t.launchPackageRun?.dex;
  if (!terms) return false;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const key = launchProjectKey(t);
  const binding = hash({ policy: terms.version === 5 ? terms : t.launchPackage, token: key,
    treasury: launchTreasuryKey(t), launchTx: t.onchain?.launchTx || null });
  if (externalListingVerified(d) && d.version === 1 && d.id === `launch-dex:${key}:v1` && d.binding === binding) return true;
  if (!settledPayment(d, terms.dexBudgetMicros) || d.publication !== 'published') return false;
  return d.version === 1 && d.id === `launch-dex:${key}:v1` && d.binding === binding && record(d.order) &&
    d.orderFingerprint === hash(d.order) && d.order.targetChain === t.chain &&
    (terms.version === 5 && t.chain === 'solana' ? d.order.targetTokenAddress === t.address : String(d.order.targetTokenAddress).toLowerCase() === String(t.address).toLowerCase()) &&
    d.order.amountMicros === 299_000_000 && d.actualMicros >= d.order.amountMicros;
};
export const holderWorkAllowed = (t, opts) => !isStagedLaunch(t) || runtimeStageReady(t, opts) && socialStageComplete(t) && dexStageComplete(t);
const allocationStarted = r => record(r) && (['payment_pending','submitted','reconciliation_required','settled'].includes(r.state) || r.paymentReference || r.paymentVerified === true);
function stagedReserve(t, kind, budget) {
  const run = t.launchPackageRun?.[kind];
  if (allocationStarted(run)) return budget;
  if (!runtimeStageReady(t) || kind === 'dex' && !socialStageComplete(t)) return 0;
  return Math.min(budget, Math.max(0, (Number.isSafeInteger(t.treasury?.micros) ? t.treasury.micros : 0) - operationalReserveMicros(t)));
}

export function hasLaunchPackage(t) {
  return packageTerms(t) !== null;
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEX_BRIDGE_PREFIX = 'package-dex-bridge:';
const UNUSED_DEX_FIELDS = new Set(['version', 'id', 'binding', 'state', 'createdAt', 'updatedAt', 'order', 'orderFingerprint',
  'attempt', 'payAttempt', 'paymentReference', 'paymentVerified', 'actualMicros', 'bridgeState', 'detail', 'nextAttemptAt', 'terminal']);
// This is a policy view, not a migration of financial history. Any dispatch,
// uncertain journal or money-movement evidence retains the original allocation.
// In particular, a bridge reservation is not released here: billing owns it.
export function dexAllocationWaived(t) {
  const terms = packageTerms(t);
  if (!terms) return false;
  if (terms.version === 5) return false;
  if (terms.dexBudgetMicros === 0) return true;
  for (const rows of [t.packageBridgeReservations, t.packageUsageReservations]) {
    if (rows == null) continue;
    if (!record(rows)) return false;
    for (const [id, row] of Object.entries(rows)) {
      if (!record(row) || id.startsWith(DEX_BRIDGE_PREFIX) || String(row.id || '').startsWith(DEX_BRIDGE_PREFIX) || row.launchPackageJobId) return false;
    }
  }
  const ledger = t.treasury?.ledger;
  if (ledger != null && (!Array.isArray(ledger) || ledger.some(row => !record(row) || row.launchPackageJobId ||
      String(row.billingId || '').startsWith(DEX_BRIDGE_PREFIX) || /^DEX Screener\b/.test(String(row.reason || ''))))) return false;
  const run = t.launchPackageRun;
  if (run == null) return true;
  if (!record(run)) return false;
  if (!Object.hasOwn(run, 'dex')) return true;
  const d = run.dex;
  const key = `${t.chain}:${String(t.address).toLowerCase()}`;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const binding = hash({ policy: terms, token: key,
    treasury: String(t.treasury?.wallet).toLowerCase(), launchTx: t.onchain?.launchTx || null });
  return record(d) && d.version === 1 && ['queued', 'not_connected', 'prepared'].includes(d.state) &&
    d.id === `launch-dex:${key}:v1` && d.binding === binding &&
    (d.state === 'prepared' ? record(d.order) && d.orderFingerprint === hash(d.order) : d.order == null) &&
    Reflect.ownKeys(d).every(key => UNUSED_DEX_FIELDS.has(key)) &&
    (d.attempt == null || d.attempt === 0) && (d.payAttempt == null || d.payAttempt === 0) &&
    (d.paymentReference == null || d.paymentReference === '') && (d.paymentVerified == null || d.paymentVerified === false) &&
    (d.actualMicros == null || d.actualMicros === 0) && d.bridgeState == null && d.nextAttemptAt == null && d.terminal !== true;
}
export function packageActivationMicros(t) {
  const terms = packageTerms(t);
  return terms ? terms.activationMicros - (dexAllocationWaived(t) ? terms.dexBudgetMicros : 0) : null;
}
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function hasFreshMarketingObservation(t, now = Date.now()) {
  const start = Date.parse(t.treasury?.marketingObservationStartedAt || '');
  const end = Date.parse(t.treasury?.marketingObservedAt || '');
  if (!(Number.isSafeInteger(now) && Number.isFinite(start) && Number.isFinite(end) &&
    start <= end && end <= now && now - start <= 30_000)) return false;
  const tr = t.treasury, p = tr?.basePocket;
  if (tr?.chain !== 'solana' || !p?.address) return true;
  const proof = tr.marketingBasePocketObservation;
  const pocketStart = Date.parse(p.observationStartedAt || ''), pocketEnd = Date.parse(p.observedAt || '');
  return p.readOk === true && p.observedAddress === p.address && p.observedRevision === (p.revision || 0) &&
    Number.isSafeInteger(p.usdcMicros) && p.usdcMicros >= 0 && proof?.address === p.address &&
    proof.revision === p.observedRevision && proof.usdcMicros === p.usdcMicros &&
    proof.startedAt === p.observationStartedAt && proof.observedAt === p.observedAt &&
    start <= pocketStart && pocketStart <= pocketEnd && pocketEnd <= end;
}
export function isPackageFunded(t) {
  const terms = packageTerms(t);
  if (!terms) return false;
  const r = t.launchPackageRun;
  if (r == null) return false;
  // X can start at its own $10 threshold. This explicit journal is not a VPS
  // funding certificate, and it may not carry partial or ambiguous funding proof.
  if (r.fundingStage === 'social') {
    if (!record(r) || r.version !== 1 || Reflect.ownKeys(r).some(key => !['version','fundingStage','socialAccount'].includes(key)))
      throw Object.assign(new Error('Early social funding record requires review'), { status: 409 });
    return false;
  }
  // Old journals must still prove their ORIGINAL funding threshold. Only new
  // journals carrying this exact policy marker may prove the reduced threshold.
  const policy = r.fundingPolicy;
  let requirement = terms.activationMicros;
  if (policy !== undefined) {
    if (!record(policy) || Reflect.ownKeys(policy).length !== 3 ||
        !['version', 'dexAllocation', 'requirementMicros'].every(key => Object.hasOwn(policy, key)) || policy.version !== 1 ||
        policy.dexAllocation !== 'waived' || !dexAllocationWaived(t) ||
        policy.requirementMicros !== packageActivationMicros(t))
      throw Object.assign(new Error('Launch funding policy requires review'), { status: 409 });
    requirement = policy.requirementMicros;
  }
  // A verified account debit is part of the gross launch target. Persist both
  // sides of the sum so restarting cannot silently treat a lower wallet balance
  // as if it alone had funded the package.
  if (r.socialFundingCreditMicros !== undefined || r.fundedWalletMicros !== undefined) {
    if (!Number.isSafeInteger(r.socialFundingCreditMicros) || r.socialFundingCreditMicros <= 0 ||
        r.socialFundingCreditMicros !== socialAccountFundingCreditMicros(t) ||
        !Number.isSafeInteger(r.fundedWalletMicros) || r.fundedWalletMicros < 0 ||
        r.fundedMicros !== r.fundedWalletMicros + r.socialFundingCreditMicros)
      throw Object.assign(new Error('Social funding credit requires review'), { status: 409 });
  }
  // version is the funding journal schema; v1 journals also record later terms.
  if (r.version !== 1 || !iso(r.fundedAt) || !Number.isSafeInteger(r.fundedMicros) ||
      r.fundedMicros < requirement)
    throw Object.assign(new Error('Launch funding record requires review'), { status: 409 });
  return true;
}
// A launch funding journal alone is never proof that a real runtime activated.
// Keep the historical receipt bound to this project and its funding event so a
// later replacement can retain the original activation without reusing $5 as a
// lifetime spending entitlement. Legacy runtime history is checked before it is
// captured; current wallet freshness is a separate dispatch requirement.
const runtimeActivationBinding = t => createHash('sha256').update(JSON.stringify({
  terms: packageTerms(t), project: launchProjectKey(t), treasury: launchTreasuryKey(t),
  launchTx: t.onchain?.launchTx || null, fundedAt: t.launchPackageRun?.fundedAt,
  observedAt: t.launchPackageRun?.observedAt, fundedMicros: t.launchPackageRun?.fundedMicros,
})).digest('hex');
function coherentRuntimeActivation(t, r, now) {
  const funded = timeOf(t.launchPackageRun?.fundedAt), observed = timeOf(t.launchPackageRun?.observedAt);
  const rented = timeOf(r?.rentedAt), registered = timeOf(r?.registeredAt), streamed = timeOf(r?.firstStreamAt), attempted = timeOf(r?.rentalAttemptAt);
  return Number.isSafeInteger(now) && [funded, observed, rented, registered, streamed, attempted].every(Number.isFinite) &&
    observed <= funded && funded - observed <= 30_000 && funded <= attempted && attempted <= rented && rented <= registered && registered <= streamed && streamed <= now &&
    Number.isSafeInteger(r?.instanceId) && r.instanceId > 0 &&
    Number.isSafeInteger(r?.hourlyMicros) && r.hourlyMicros > 0 && r.hourlyMicros <= packageTerms(t).maxVpsHourlyMicros;
}
export function hasPriorRuntimeActivation(t, { now = Date.now() } = {}) {
  if (!isStagedLaunch(t) || !isPackageFunded(t)) return false;
  const receipt = t.launchPackageRun.runtimeActivation;
  if (receipt !== undefined) {
    if (!record(receipt) || receipt.version !== 1 || receipt.binding !== runtimeActivationBinding(t) ||
        !coherentRuntimeActivation(t, receipt, now) || !iso(receipt.recordedAt) ||
        timeOf(receipt.recordedAt) < timeOf(receipt.firstStreamAt) || timeOf(receipt.recordedAt) > now)
      throw Object.assign(new Error('Runtime activation history requires review'), { status: 409 });
    return true;
  }
  const v = t.vps, attempt = v?.attempts?.find(row => row?.instanceId === v.instanceId && row.result === 'rented');
  return v?.mode === 'real' && Boolean(attempt) && coherentRuntimeActivation(t, { ...v, rentalAttemptAt: attempt.at }, now);
}
export function recordRuntimeActivation(t, { now = Date.now() } = {}) {
  if (!hasPriorRuntimeActivation(t, { now }) || t.launchPackageRun.runtimeActivation) return false;
  const v = t.vps;
  t.launchPackageRun.runtimeActivation = { version: 1, binding: runtimeActivationBinding(t),
    instanceId: v.instanceId, hourlyMicros: v.hourlyMicros,
    rentedAt: new Date(timeOf(v.rentedAt)).toISOString(), registeredAt: new Date(timeOf(v.registeredAt)).toISOString(),
    firstStreamAt: new Date(timeOf(v.firstStreamAt)).toISOString(),
    rentalAttemptAt: new Date(timeOf(v.attempts.find(row => row.instanceId === v.instanceId && row.result === 'rented').at)).toISOString(),
    recordedAt: new Date(now).toISOString() };
  return true;
}
// Called only with a successful all-components wallet observation. A failed RPC
// refresh must never turn a stale cached balance into payment authority.
export function markPackageFunded(t, { now = Date.now(), availableMicros = null } = {}) {
  const releasedLegacyReserve = canAdoptStagedPackage(t) ? packageReserveMicros(t) : 0;
  const upgraded = adoptStagedPackage(t, { now });
  if (upgraded && Number.isSafeInteger(availableMicros)) availableMicros += releasedLegacyReserve;
  const terms = packageTerms(t);
  if (!terms || isPackageFunded(t)) return upgraded;
  const requirement = packageActivationMicros(t), credit = terms.version === 5 ? 0 : socialAccountFundingCreditMicros(t);
  if (terms.version === 5 && (!Number.isSafeInteger(availableMicros) || availableMicros < requirement || availableMicros > t.treasury.micros)) return upgraded;
  if (!hasFreshMarketingObservation(t, now) || !Number.isSafeInteger(t.treasury.micros) || t.treasury.micros < 0 ||
      !Number.isSafeInteger(t.treasury.micros + credit) || t.treasury.micros + credit < requirement) return upgraded;
  const socialAccount = t.launchPackageRun?.socialAccount;
  t.launchPackageRun = { version: 1, fundedAt: new Date(now).toISOString(),
    fundedMicros: t.treasury.micros + credit, observedAt: t.treasury.marketingObservedAt,
    ...(credit ? { fundedWalletMicros: t.treasury.micros, socialFundingCreditMicros: credit } : {}),
    ...(socialAccount !== undefined ? { socialAccount } : {}),
    ...(requirement < terms.activationMicros ? { fundingPolicy: { version: 1, dexAllocation: 'waived', requirementMicros: requirement } } : {}) };
  return true;
}
const publicId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(value);
const verifiedPayment = (r, budget) => r?.paymentVerified === true &&
  typeof r.paymentReference === 'string' && r.paymentReference.trim().length > 0 &&
  Number.isSafeInteger(r.actualMicros) && r.actualMicros > 0 && r.actualMicros <= budget;
const settledPayment = (r, budget) => r?.state === 'settled' &&
  r.sourceBalanceReconciled === true && verifiedPayment(r, budget);
export function dexReserveMicros(t) {
  const terms = packageTerms(t);
  if (!terms) return 0;
  if (dexAllocationWaived(t)) return 0;
  if (externalListingVerified(t.launchPackageRun?.dex)) return 0;
  // Reservation is released only after both verified settlement and a new
  // source-wallet balance read. The DEX queue certifies that read before it
  // persists sourceBalanceReconciled; old settlement journals remain valid.
  return settledPayment(t.launchPackageRun?.dex, terms.dexBudgetMicros) ? 0 : terms.version === 5 ? stagedReserve(t, 'dex', terms.dexBudgetMicros) : terms.dexBudgetMicros;
}
const verifiedAcquisition = r => r?.acquisitionVerified === true && publicId(r.accountId) && publicId(r.orderId);
function reconciledSocialAccount(r, budget) {
  if (!settledPayment(r, budget) || !verifiedAcquisition(r)) return false;
  // The trusted reconciler retains its public timing evidence. Check
  // freshness at reconciliation, so a settled hold stays released on restart.
  const paid = Date.parse(r.paidAt || ''), start = Date.parse(r.sourceObservationStartedAt || ''),
    observed = Date.parse(r.sourceObservedAt || ''), reconciled = Date.parse(r.sourceReconciledAt || '');
  return [paid, start, observed, reconciled].every(Number.isFinite) &&
    paid <= start && start <= observed && observed <= reconciled &&
    reconciled <= Date.now() && reconciled - start <= 30_000;
}
export function socialAccountReserveMicros(t) {
  if (!X_FEATURE_ENABLED) return 0;
  const terms = packageTerms(t), budget = terms?.socialAccountBudgetMicros || 0;
  return budget && !reconciledSocialAccount(t.launchPackageRun?.socialAccount, budget) ? terms.version === 5 ? stagedReserve(t, 'socialAccount', budget) : budget : 0;
}
// Only the account charge certified against a fresh post-payment balance can
// count toward launch funding. Quotes, assigned-but-unpaid accounts, pending
// creator rewards and unsettled payment records never count as money received.
export function socialAccountFundingCreditMicros(t) {
  const terms = packageTerms(t), budget = terms?.socialAccountBudgetMicros || 0;
  const job = t.launchPackageRun?.socialAccount;
  if (!budget || !reconciledSocialAccount(job, budget) || !/^[1-9][0-9]{0,29}$/.test(String(job.accountId || ''))) return 0;
  const binding = createHash('sha256').update(JSON.stringify({ terms, project: launchProjectKey(t),
    treasury: launchTreasuryKey(t), launchTx: t.onchain?.launchTx })).digest('hex');
  return job.version === 1 && job.binding === binding && job.id === `launch-social:${binding}` && publicId(job.purchaseReference) ? job.actualMicros : 0;
}
export function packageReserveMicros(t) {
  return dexReserveMicros(t) + socialAccountReserveMicros(t);
}
export function activationRequirementMicros(t) {
  const terms = packageTerms(t);
  if (!terms) return Math.ceil(Number(t.plan?.activationUsd) * MICRO);
  if (terms.version === 5) return terms.activationMicros;
  return isPackageFunded(t) ? terms.operatingMicros + packageReserveMicros(t) : packageActivationMicros(t) - socialAccountFundingCreditMicros(t);
}
const publicDetail = value => typeof value === 'string' && value.trim() ? value.slice(0, 200) : null;
const retryAt = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const clock = value => value.slice(11, 16) + ' UTC';
function publicSocialAccount(t, terms, funded, now = Date.now()) {
  const budget = terms.socialAccountBudgetMicros || 0;
  if (!budget) return null;
  const r = t.launchPackageRun?.socialAccount;
  const labels = {
    waiting_runtime: 'Waiting for the AI computer to come online',
    funding: 'Collecting the Twitter/X account allocation',
    not_connected: 'Twitter/X account acquisition connection pending',
    queued: 'Twitter/X account acquisition pending',
    preparing: 'Preparing the Twitter/X account acquisition',
    prepared: 'Twitter/X account acquisition prepared',
    payment_pending: 'Checking the Twitter/X account payment',
    submitted: 'Verifying the Twitter/X account acquisition',
    reconciliation_required: 'Checking the Twitter/X account acquisition — no second payment',
    settled: 'Twitter/X account acquisition verified',
  };
  let state = r?.state || (terms.version === 5 && !runtimeStageReady(t, {now}) ? 'waiting_runtime' : funded ? 'not_connected' : 'funding');
  if (!Object.hasOwn(labels, state) || state === 'settled' && !reconciledSocialAccount(r, budget)) state = 'reconciliation_required';
  const paid = verifiedPayment(r, budget) && ['submitted', 'settled'].includes(r?.state);
  const terminal = r?.terminal === true && state !== 'settled', nextAttemptAt = r && state !== 'settled' ? retryAt(r?.nextAttemptAt) : null;
  const statusText = terminal ? 'Operator review required — no second payment' :
    nextAttemptAt && Date.parse(nextAttemptAt) > now ? `Retrying the account acquisition at ${clock(nextAttemptAt)}` :
    state === 'queued' && r?.detail === 'X_POOL_EMPTY' ? 'Waiting for an available verified X account — no payment taken' : labels[state];
  const account = paid && verifiedAcquisition(r) && /^[a-zA-Z0-9_]{1,15}$/.test(String(r.handle || '')) ? { handle: r.handle, userId: r.accountId, url: `https://x.com/${r.handle}` } : null;
  return { budgetMicros: budget, fundingThresholdMicros: budget, startsBeforeComputer: terms.version !== 5, account, reservedMicros: socialAccountReserveMicros(t), state,
    statusText, acquired: verifiedAcquisition(r), paid,
    spentMicros: paid ? r.actualMicros : 0, automaticPaymentConnected: r?.state === 'not_connected' ? false : null,
    acquisitionConnected: r?.state === 'not_connected' ? false : null, detail: r && state !== 'settled' ? publicDetail(r?.detail) : null, nextAttemptAt, terminal };
}
export function publicLaunchPackage(t, { now = Date.now() } = {}) {
  const terms = packageTerms(t);
  if (!terms) return null;
  const funded = isPackageFunded(t), d = t.launchPackageRun?.dex;
  const waived = dexAllocationWaived(t), activationMicros = packageActivationMicros(t);
  const state = !funded ? 'funding' : terms.version === 5 && !d ? !runtimeStageReady(t,{now}) ? 'waiting_runtime' : !socialStageComplete(t) ? 'waiting_social' : 'queued' : waived ? 'not_required' : d?.state || 'queued';
  const labels = {
    waiting_runtime: 'Waiting for the AI computer', waiting_social: 'Waiting for the verified X account',
    funding: `Collecting the $${activationMicros / MICRO} launch budget`, queued: 'DEX Screener setup queued',
    not_required: 'Launch budget funded — DEX Screener is not required',
    not_connected: 'DEX Screener checkout connection pending',
    preparing: 'Preparing the DEX Screener order', prepared: 'DEX Screener order ready',
    payment_pending: 'Checking the DEX Screener payment', submitted: 'Confirming payment',
    reconciliation_required: 'Checking a previous attempt — no second payment',
    settled: 'DEX Screener payment confirmed',
  };
  const shown = Object.hasOwn(labels, state) ? state : 'reconciliation_required';
  const paid = d?.paymentVerified === true && ['submitted','settled'].includes(d.state);
  // Distinct texts for the bridge-first money flow; every label is fixed text, never provider output.
  const bridgeLabels = { reserved: 'Bridging the DEX Screener allocation', submitted: 'Bridging the DEX Screener allocation',
    delivering: 'USDC delivered, verifying the DEX wallet', delivered: 'USDC delivered, verifying the DEX wallet', paying: 'Paying the DEX Screener order' };
  const bridgeState = funded && typeof d?.bridgeState === 'string' && /^[a-z_]{1,40}$/.test(d.bridgeState) ? d.bridgeState : null;
  const terminal = funded && shown === 'reconciliation_required' && d?.terminal === true;
  const nextAttemptAt = funded && shown === 'prepared' ? retryAt(d?.nextAttemptAt) : null;
  const statusText = terminal ? 'Operator review required — no second payment' :
    nextAttemptAt && Date.parse(nextAttemptAt) > now ? `Retrying the allocation at ${clock(nextAttemptAt)}` :
    ['payment_pending','submitted'].includes(shown) && !paid && bridgeLabels[bridgeState] ? bridgeLabels[bridgeState] : labels[shown];
  return { ...terms, activationMicros, dexBudgetMicros: waived ? 0 : terms.dexBudgetMicros, socialAccountBudgetMicros: X_FEATURE_ENABLED ? terms.socialAccountBudgetMicros : 0, totalOnboardingMicros: X_FEATURE_ENABLED ? terms.totalOnboardingMicros : terms.totalOnboardingMicros - (terms.socialAccountBudgetMicros || 0),
    dexAllocationWaived: waived, originalActivationMicros: terms.activationMicros, originalDexBudgetMicros: terms.dexBudgetMicros,
    funded, fundedAt: t.launchPackageRun?.fundedAt || null, socialFundingCreditMicros: terms.version === 5 ? 0 : socialAccountFundingCreditMicros(t),
    remainingWalletTargetMicros: activationRequirementMicros(t),
    reservedMicros: packageReserveMicros(t), state: shown,
    dexReservedMicros: dexReserveMicros(t), socialAccount: publicSocialAccount(t, terms, funded, now),
    statusText, detail: funded && shown !== 'settled' ? publicDetail(d?.detail) : null, nextAttemptAt, terminal, bridgeState,
    paid,
    spentMicros: d?.paymentVerified === true ? d.actualMicros : 0,
    publication: d?.publication === 'published' ? 'published' : 'not_verified',
    automaticPaymentConnected: d?.state === 'not_connected' ? false : null,
    // This is an allocation of actual treasury receipts, NOT a Pons curve fee
    // change or an additional $300 attached to launchAndBuy calldata.
    collection: 'treasury_allocation', additionalLaunchChargeMicros: 0 };
}
