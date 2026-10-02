// Read-only public projection. Never exposes provider errors, machine addresses or
// boot credentials, and never treats funding or a past event as live evidence.
import { isStagedLaunch } from './launch-package.mjs';
import { runtimeStartupFundingOf } from './runtime-budget.mjs';
import { publicVpsUsageReviewOf } from './vps-billing-recovery.mjs';
const iso = value => {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};
const issueText = {
  provider_rate_limited: 'The server provider is busy. We will retry automatically without requesting another deposit.',
  offer_unavailable: 'The selected server is no longer available. We are checking equivalent servers within the approved price limit.',
  startup_failed: 'Server preparation could not finish. A safe automatic retry is scheduled.',
};
const dollars = micros => micros > 0 && micros < 10_000 ? '< $0.01' : `$${(micros / 1_000_000).toFixed(2)}`;
const resumeFundingDetail = funding => `Initial activation is complete. Restart requires ${dollars(funding.requirementMicros)} for two quoted VPS hours and $1 of AI liquidity. ${dollars(funding.availableMicros)} is unreserved; ${dollars(funding.missingMicros)} more is needed. Existing payment commitments remain reserved.`;
export function startupStatusOf(t, { health = {}, lock = {}, now = Date.now() } = {}) {
  const v = t.vps || {}, a = t.agent || {}, start = t.lock?.startup || {};
  let funding = null, fundingReviewRequired = false;
  try { funding = t.plan ? runtimeStartupFundingOf(t, { now }) : null; }
  catch { fundingReviewRequired = true; }
  const funded = Boolean(funding?.affordable);
  const usageReview = publicVpsUsageReviewOf(t);
  const recovering = Boolean(v.recovery?.active || health.status === 'recovering');
  const allocated = v.mode === 'real' && v.state === 'running' && Number(v.instanceId) > 0;
  const registeredAt = iso(v.registeredAt), rentedAt = iso(v.rentedAt);
  const online = allocated && health.agentOnline === true;
  const progressAt = iso(v.bootStepAt);
  const currentProgress = allocated && progressAt && (!rentedAt || progressAt >= rentedAt) ? String(v.bootStep || '') : '';
  const desktopReported = ['desktop ready','starting stream','nvenc unavailable, falling back to x264 1080p','GPU stream exited early','ffmpeg exited, restarting'].includes(currentProgress) || /^encoder started \((?:nvenc|x264|h264_nvenc|libx264)\)$/.test(currentProgress);
  const booted = Boolean(allocated && registeredAt && (!rentedAt || registeredAt >= rentedAt) && (desktopReported || online));
  const live = allocated && !recovering && online && health.streamReady === true;
  const unresolved = Boolean(v.reconciliationRequired || v.phase === 'reconciliation_required' || (v.pendingCreate && v.phase !== 'renting'));
  const paused = t.lock?.state === 'paused';
  const fundingComplete = Boolean(funding?.launchFunded || funded || allocated);
  let issueCode = Object.hasOwn(issueText, start.errorCode) ? start.errorCode : null;
  // Legacy failures can be classified, never copied into the public explanation.
  if (!issueCode && !allocated) {
    const note = String(t.lock?.note || '');
    if (/429|rate.limit/i.test(note)) issueCode = 'provider_rate_limited';
    else if (/offer.*unavailable|approved price/i.test(note)) issueCode = 'offer_unavailable';
    else if (/start failed/i.test(note)) issueCode = 'startup_failed';
  }
  let state, title, detail, problemStep = null;
  if (unresolved) {
    state = 'attention_required'; title = 'Server check needed';
    detail = 'A previous server request or shutdown needs confirmation. Automatic rental is paused to prevent duplicate charges.';
  } else if (v.state === 'stopping' || v.phase === 'stopping') {
    state = 'stopping'; title = 'Stopping the server'; detail = 'We are confirming shutdown with the provider.';
  } else if (paused) {
    state = 'paused'; title = 'Project paused'; detail = usageReview?.required ? 'Automatic startup is paused pending an operator review of uncertain server usage. Adding funds will not resolve this check.' : fundingReviewRequired ? 'Automatic startup is paused pending an operator review of the runtime funding history. Adding funds will not resolve this check.' : 'Automatic startup is paused. Adding funds will not restart this project.';
  } else if (v.mode === 'sim' && v.state === 'running') {
    state = 'simulation'; title = 'Demo mode'; detail = 'This is a simulated session, not a rented server or live AI.';
  } else if (fundingReviewRequired) {
    state = 'attention_required'; title = 'Runtime funding history needs a check';
    detail = allocated ? 'The existing server is retained. Its runtime funding history needs an operator review before another rental; adding funds will not resolve this check.' : 'Runtime funding history could not be verified. An operator review is required before another rental; adding funds will not resolve this check.';
  } else if (funding && !funding.liabilitiesVerified) {
    state = 'attention_required'; title = 'Payment commitments need a check';
    detail = 'Existing payment commitments could not be verified. An operator check is required before another server rental; adding funds will not resolve this check.';
  } else if (allocated && recovering) {
    const attention = v.recovery?.status === 'attention_required' || health.status === 'attention_required';
    state = attention ? 'attention_required' : 'recovering';
    title = attention ? 'Existing server needs a check' : 'Recovering the existing server'; problemStep = 'agent';
    detail = attention
      ? 'Repeated provider checks could not confirm recovery. The existing server is retained and needs an operator check; no replacement has been rented.'
      : 'The existing server is retained while its provider state and connection are checked. No replacement has been rented.';
  } else if (usageReview?.required) {
    state = 'attention_required'; title = 'Server usage needs a check';
    detail = allocated ? 'The existing server is retained. An uncertain service interval needs an operator billing review before further hourly payments; adding funds will not resolve this check.' : 'Previous server usage needs an operator billing review before another rental. Adding funds will not resolve this check.';
  } else if (live) {
    state = 'live'; title = 'Agent and screen are live'; detail = 'The agent is online and its live screen is connected.';
  } else if (allocated) {
    if (health.status === 'attention_required' || ['runtime setup FAILED','registration refused','agent module download FAILED','virtual desktop FAILED','native desktop setup FAILED','Kurt assets FAILED','Kurt desktop FAILED'].includes(currentProgress)) {
      state = 'attention_required'; title = 'Server setup needs attention'; problemStep = 'boot';
      detail = 'A server was rented, but setup is delayed or reported a failure. We are checking its status; do not send another deposit.';
    } else if (health.status === 'stream_delayed') {
      state = 'attention_required'; title = 'Live screen is delayed'; problemStep = 'stream';
      detail = 'The agent is online, but video has not connected as expected. The live screen needs a check.';
    } else if (health.status === 'heartbeat_stale') {
      state = 'attention_required'; title = 'Agent connection interrupted'; problemStep = 'agent';
      detail = 'The agent has stopped checking in. The server connection needs a check; adding funds will not fix this connection problem.';
      if (health.provider?.status === 'checked' && health.provider.state === 'running')
        detail = 'The provider reports the server is running, but its AI is not checking in. The agent or its connection needs recovery; no extra deposit is required.';
      else if (health.provider?.status === 'checked' && ['stopped','exited','offline','destroyed','frozen'].includes(health.provider.state))
        detail = 'The provider reports the server is not running. Its recovery needs an operator check; do not send another deposit.';
      else if (health.provider?.status === 'unavailable')
        detail = 'The AI connection is interrupted and the provider status check is unavailable. We cannot confirm the server is running; no replacement has been rented.';
    } else if (!booted) {
      state = 'booting'; title = 'Preparing your server'; detail = 'The server has been rented. Installing the desktop and agent software can take several minutes.';
      const preparation = { 'boot script started': 'The server has started and is preparing its software.', 'preparing runtime': 'Installing and checking the desktop software.', 'runtime ready': 'Desktop software is installed. Connecting the server to this project.', 'virtual desktop up': 'The desktop is running. Starting the agent and Kurt.' };
      if (Object.hasOwn(preparation, currentProgress)) detail = preparation[currentProgress];
    } else if (a.state === 'paused') {
      state = 'paused'; title = 'AI paused'; detail = 'The server exists, but the AI is paused.';
    } else if (!online) {
      state = 'starting_agent'; title = 'Connecting the agent'; detail = 'The desktop has checked in. Waiting for a fresh agent heartbeat.';
    } else {
      state = 'starting_stream'; title = 'Connecting the live screen'; detail = health.streamReady === false ? 'The agent is online. Waiting for its first live video frames.' : 'The agent is online. Live video status is being checked.';
    }
  } else if (v.phase === 'renting' || v.pendingCreate) {
    state = 'renting'; title = 'Reserving your server'; detail = 'The rental request is being confirmed. We will not submit a duplicate request.';
  } else if (!t.plan) {
    state = 'no_plan'; title = 'Choose a plan'; detail = 'Select an AI model and server before funding startup.';
  } else if (!funding?.freshBalance) {
    state = 'checking_balance'; title = 'Checking the project balance'; detail = 'The last balance is not fresh enough to authorize a rental. A new confirmed balance is required before setup can continue.';
  } else if (!funded) {
    state = funding?.resumed ? 'runtime_funding' : 'funding';
    title = funding?.resumed ? 'Runtime restart needs funding' : 'Waiting for funding';
    detail = funding?.resumed ? resumeFundingDetail(funding) : 'Automatic setup starts when unreserved project funds reach the initial startup target.';
  } else if (lock.blockedReason === 'real_rental_unavailable') {
    state = 'attention_required'; title = 'Server rental is disabled'; detail = 'Real server rental is not enabled. The operator needs to enable it before a fresh balance and server quote can authorize startup.';
  } else if (isStagedLaunch(t) && funding?.resumed && !funding.quoteValid) {
    state = 'attention_required'; title = 'Server quote needs a check'; detail = 'A valid server quote within the $1 per hour limit is required before the restart budget can be confirmed.';
  } else if (start.errorCode === 'runtime_funding_required') {
    state = 'runtime_funding'; title = 'Checking runtime restart funding'; detail = funding?.resumed ? `${resumeFundingDetail(funding)} The quote and balance must be checked again before rental.` : 'The latest rental attempt could not cover the required operating reserve. The quote and unreserved balance must be checked again before rental.';
  } else if (start.errorCode === 'balance_refresh_required') {
    state = 'checking_balance'; title = 'Checking the project balance'; detail = 'A fresh confirmed project balance is required before another rental attempt.';
  } else if (start.phase === 'retry_wait' || issueCode) {
    state = 'retry_wait'; title = 'Funding complete · retrying setup'; detail = issueText[issueCode] || issueText.startup_failed;
  } else if (start.phase === 'checking_offer') {
    state = 'checking_offer'; title = 'Checking server availability'; detail = 'Confirming availability, price and unreserved project funds before reserving the server.';
  } else {
    state = 'queued'; title = 'Funding complete · setup queued'; detail = 'Your project has enough unreserved funds at the saved quote. Availability, price and balance will be checked again before rental.';
  }
  const steps = [
    { id: 'funding', label: 'Funding received', status: fundingComplete ? 'complete' : state === 'funding' ? 'active' : 'pending' },
    { id: 'allocation', label: 'Reserve a server', status: allocated ? 'complete' : ['queued','checking_offer','renting'].includes(state) ? 'active' : ['retry_wait','attention_required'].includes(state) ? 'error' : 'pending' },
    { id: 'boot', label: 'Prepare the desktop', status: booted ? 'complete' : state === 'booting' ? 'active' : 'pending' },
    { id: 'agent', label: 'Connect the AI', status: online ? 'complete' : state === 'starting_agent' ? 'active' : 'pending' },
    { id: 'stream', label: 'Start the live screen', status: live ? 'complete' : state === 'starting_stream' ? 'active' : 'pending' },
  ];
  if (problemStep) steps.find(step => step.id === problemStep).status = 'error';
  // Measured startup durations. Each step is timed only from the milestone directly
  // before it; an unrecorded milestone reports null instead of a guessed span.
  const nowIso = iso(now);
  const span = (from, to) => {
    const a2 = Date.parse(from || ''), b2 = Date.parse(to || '');
    return Number.isFinite(a2) && Number.isFinite(b2) && b2 >= a2 ? b2 - a2 : null;
  };
  const fundedAt = fundingComplete ? iso(t.launchPackageRun?.fundedAt) || iso(t.treasury?.marketingObservedAt) : null;
  const anchors = [iso(t.plan?.setAt), fundedAt, allocated ? rentedAt : null, booted ? registeredAt : null,
    online ? iso(a.firstHeartbeatAt) : null, live ? iso(v.firstStreamAt) : null];
  steps.forEach((step, i) => {
    step.at = step.status === 'complete' ? anchors[i + 1] : null;
    step.ms = step.at ? span(anchors[i], step.at) : null;
    step.elapsedMs = step.status === 'active' ? span(anchors[i], nowIso) : null;
  });
  const timing = { planAt: anchors[0], fundedAt, liveAt: anchors[5], complete: Boolean(anchors[5]),
    totalMs: fundedAt ? span(fundedAt, anchors[5] || nowIso) : null };
  const retryAt = iso(start.nextRetryAt);
  const updated = [start.updatedAt, v.updatedAt, v.bootStepAt, t.plan?.setAt].map(iso).filter(Boolean).sort().at(-1) || null;
  return { version: 1, state, title, detail, fundingComplete, issueCode: state === 'retry_wait' ? issueCode : null,
    updatedAt: updated, timing, usageReview, fundingReviewRequired,
    runtimeFunding: funding ? { mode: funding.resumed ? 'runtime_resume' : 'initial_activation', requiredMicros: funding.requirementMicros,
      availableMicros: funding.availableMicros, heldMicros: funding.heldMicros, missingMicros: funding.missingMicros, freshBalance: funding.freshBalance,
      liabilitiesVerified: funding.liabilitiesVerified, liabilityReviewRequired: funding.liabilityReviewRequired } : null,
    nextRetryAt: state === 'retry_wait' && retryAt && Date.parse(retryAt) > now ? retryAt : null, steps };
}
