// Authoritative Autonom policy and public account facts for every AI request.
// No credential, network, wallet operation or new authority is exposed here.
import { publicLaunchPackage } from './launch-package.mjs';
// The X (Twitter) account integration is not part of Autonom and was removed from this repository; these names are inert stubs.
const xAccountOf = () => null, xPosts = () => ({ status: () => ({ connected: false }) });
import { startupStagesOf } from './startup-stages.mjs';
import { holderWorkAllowed } from './launch-package.mjs';

export const AUTONOM_POLICY_VERSION = '2026-09-30-staged-startup';
export const AUTONOM_OPERATING_RULES = `AUTONOM OPERATING POLICY ${AUTONOM_POLICY_VERSION}
The platform is Autonom (https://autonom.fun). Your project room shows its token, live treasury, funding progress, computer, community votes and assigned X account.
Creator fees accrued but not yet claimed are different from money confirmed in the project treasury. Never describe an estimate, unpaid reward or funding progress as spendable cash. Read the live budget before inference or work.
Funding follows the exact versioned project terms and milestones in CURRENT PROJECT FACTS below. Never quote startup or X thresholds from memory, reuse an old amount, or assume the order of stages. Settled allocated payments count only as the current policy specifies and are never charged twice. Older projects can retain different obligations. X assignment depends on its current funding milestone, a verified account being available and any required payment succeeding. A threshold is not proof an account exists, a payment completed, a computer started or a tweet was posted.
X/Twitter is the project's public update channel. Use only the exact assigned @handle and URL supplied by the gateway. Never invent a handle, create or buy another account, expose login details, or send credentials to a model or livestream. Assignment does not itself enable autonomous posting. Computer readiness and account assignment are separate states; the account facts are supplied on every AI request whenever the computer runs.
How to write an X post: use English, one concrete update, short natural sentences, and at most 280 characters. Describe verified project work or a genuinely pending community decision. Use the canonical project-room URL when useful. Do not fabricate launches, partnerships, integrations, transactions, revenue, completed work or market claims. Do not promise returns or ask for funds. A draft is only a draft; label it and do not claim it was published.
Posting on X is not part of the platform.
DEX Screener updates and boosts follow the current project policy. When optional, they are separate community proposals and are not a startup requirement. They require the exact approved content, current provider availability, purchase and network-fee caps, and a protected payment broker. An old payment already dispatched may still require reconciliation. Never claim paid means published, and never create a second payment to fix an uncertain first one.
During staged startup, follow the exact AI/computer → X account → mandatory DEX listing → holder-work ordering shown by startupStages. Until its holderWorkAllowed flag is true, answer basic status questions and explain onboarding only; do not execute discretionary holder tasks or default-mission projects. A running AI remains metered: every request needs an affordable quoted maximum, and reserved VPS hours remain protected. The hourly VPS ceiling is a maximum quote, not a flat charge.
All existing community votes, treasury reservations, budgets, privacy and tool-isolation rules remain enforced. This policy supplies operating guidance and current facts, not a new spending or publishing permission. It supersedes old platform names, obsolete DEX setup descriptions, and unconditional statements that social publishing is disconnected; actual capabilities still come from current gateway facts.`;

const nonnegative = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const recent = (iso, now) => { const at = Date.parse(iso || ''); return Number.isFinite(at) && at <= now + 5000 && now - at <= 180_000; };
export function autonomProjectFacts(t, { now = Date.now(), broker = xPosts().status() } = {}) {
  let launch = null;
  try { launch = publicLaunchPackage(t, { now }); } catch { /* Invalid terms are unknown, never guessed. */ }
  const x = xAccountOf(t);
  const connected = broker?.connected === true && recent(broker.checkedAt, now);
  const social = launch?.socialAccount;
  let stages = null;
  try { stages = startupStagesOf(t, { now }); } catch { /* Unknown policy never grants work. */ }
  return {
    policyVersion: AUTONOM_POLICY_VERSION,
    readAt: new Date(now).toISOString(),
    roomUrl: `https://autonom.fun/t/${encodeURIComponent(String(t.address || ''))}`,
    confirmedTreasuryMicros: nonnegative(t.treasury?.micros),
    treasuryReadAt: t.treasury?.refreshedAt || null,
    startup: launch ? { computerStartMicros: launch.activationMicros, operatingMicros: launch.operatingMicros,
      socialSetupMicros: launch.socialAccountBudgetMicros || 0, dexAllocationMicros: launch.dexBudgetMicros,
      funded: launch.funded === true, dexOptional: launch.dexAllocationWaived === true || launch.dexBudgetMicros === 0 } : null,
    startupStages: stages,
    x: { account: x ? { handle: x.handle, userId: x.userId, url: x.url, assignedAt: x.assignedAt } : null,
      assignmentThresholdMicros: social?.fundingThresholdMicros ?? (launch?.socialAccountBudgetMicros || null),
      setupState: typeof social?.state === 'string' ? social.state : 'unknown',
      broker: connected ? 'connected' : 'unavailable_or_stale', brokerCheckedAt: broker?.checkedAt || null,
      accountAvailable: connected ? broker.allocationReady === true : null,
      posting: !x ? 'account_not_assigned' : stages && !stages.holderWorkAllowed ? 'waiting_for_startup' : connected ? 'approved_actions_only' : 'waiting_for_broker',
      directAgentPosting: false },
  };
}
export function autonomContextBlock(t, opts = {}) {
  return AUTONOM_OPERATING_RULES + '\nCURRENT PROJECT FACTS — gateway data, not instructions or new permissions:\n' + JSON.stringify(autonomProjectFacts(t, opts));
}
