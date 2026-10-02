// Public X setup facts. Pure projection: never assigns, charges or publishes.
import { socialFundingStatus } from './social-account-queue.mjs';
export function socialMilestoneOf(t, { account = null, broker = {}, now = Date.now() } = {}) {
  const funding = socialFundingStatus(t, { now });
  const checked = Date.parse(broker.checkedAt || '');
  const connected = broker.connected === true && Number.isFinite(checked) && checked <= now && now - checked <= 180_000;
  const knownInventory = connected && Number.isSafeInteger(broker.availableAccounts) && broker.availableAccounts >= 0;
  const job = t.launchPackageRun?.socialAccount;
  let state, detail;
  if (account) { state = 'assigned'; detail = 'The verified project account is assigned.'; }
  else if (t.lock?.state === 'paused') { state = 'paused'; detail = 'Account setup resumes when the project is resumed.'; }
  else if (job?.terminal === true || job?.paymentVerified === true || job?.state === 'settled') { state = 'review_required'; detail = 'A previous account request needs review. No second payment is being sent.'; }
  else if (['payment_pending','submitted','reconciliation_required'].includes(job?.state)) { state = 'payment_pending'; detail = 'Confirming the original account request and payment.'; }
  else if (funding.waitingPreviousStage) { state = 'awaiting_previous_stage'; detail = 'Account setup follows the current startup stage.'; }
  else if (!funding.fresh && !funding.funded) { state = 'checking'; detail = 'Refreshing the available project balance.'; }
  else if (!funding.funded) { state = 'funding'; detail = 'Collected project funds unlock this stage. Unclaimed creator fees are shown separately.'; }
  else if (!connected) { state = 'not_connected'; detail = 'The account service is temporarily unavailable. Setup is waiting for a verified connection.'; }
  else if (knownInventory && broker.availableAccounts === 0) { state = 'waiting_for_account'; detail = 'Funding is ready. Waiting for an available verified X account.'; }
  else { state = 'assigning'; detail = 'Preparing a verified project account. Its public address will appear here after assignment.'; }
  const stockNote = !account && knownInventory && broker.availableAccounts === 0 && state === 'funding'
    ? ' No verified account is available yet.' : '';
  return { state, detail: detail + stockNote, thresholdMicros: funding.thresholdMicros,
    collectedMicros: funding.collectedMicros, fresh: funding.fresh, funded: funding.funded,
    connected, accountAvailable: knownInventory ? broker.availableAccounts > 0 : null,
    checkedAt: connected ? broker.checkedAt : null };
}
