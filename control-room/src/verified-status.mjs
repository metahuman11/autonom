// What Kurt may claim about its own powers, and how it must say it checked. The gateway is the
// only party that knows the live state (agent runtime, treasury, signer, publishing, voice); it
// writes this block into every holder chat request, stamped with the read time, so an answer
// such as "I hold no keys" carries the check behind it instead of a memory of the rules.
import { runtimeCapabilitiesOf } from './runtime-capabilities.mjs';
import { walletPolicyOf } from './wallet-proposals.mjs';
// The X (Twitter) account integration is not part of Autonom and was removed from this repository; these names are inert stubs.
const xAccountOf = () => null;
import { chainIdOf } from './economy.mjs';

const usd = (micros) => '$' + (Math.max(0, Number(micros) || 0) / 1e6).toFixed(2);
const hhmm = (iso) => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) + ' UTC' : 'unknown time'; };

/// The facts, as data (also what tests and the page can assert on).
export function verifiedStatusOf(t, { now = Date.now(), voice = null } = {}) {
  const rt = runtimeCapabilitiesOf(t, now), wallet = walletPolicyOf(t, chainIdOf(t.chain)), x = xAccountOf(t);
  const treasury = t.treasury || {};
  return {
    readAt: new Date(now).toISOString(),
    agent: rt.status,                                        // online | waiting_for_heartbeat | stopped
    shell: 'disabled',                                       // rt.execution is always false; the reason is fixed
    shellReason: rt.executionReason,
    files: rt.files ? 'file tools available' : `unavailable (${rt.workbenchStatus})`,
    website: 'approved WEBSITE_UPDATE votes publish inert static HTML through the gateway',
    keys: 'none — treasury keys stay in the gateway custody; only approved actions are signed',
    treasuryUsd: usd(treasury.micros), treasuryReadAt: treasury.refreshedAt || null,
    treasuryWallet: treasury.wallet || null,
    buyBurn: `proposals ${wallet.proposals ? 'allowed' : 'not open'}, execution ${wallet.execution ? 'connected' : 'not connected'} (${wallet.status})`,
    social: x ? `X account @${x.handle} assigned; posting only through a holder action or an approved vote, never from chat` : 'no X account assigned; social publishing not connected',
    voice: voice ? `${voice.status}${voice.streamPlayback === false ? ', stream playback off' : ''}` : 'unknown',
  };
}

/// The system message. Kept short: it rides on every billed chat turn.
export function verifiedStatusBlock(t, opts = {}) {
  const s = verifiedStatusOf(t, opts);
  return [
    `VERIFIED STATUS — read by the gateway at ${hhmm(s.readAt)}. These are the live checks behind any claim about what you can do; nothing here grants a new permission.`,
    `- agent runtime: ${s.agent}; shell execution: ${s.shell} (${s.shellReason}); file tools: ${s.files}`,
    `- keys: ${s.keys}`,
    `- treasury: ${s.treasuryUsd} as read at ${hhmm(s.treasuryReadAt)}${s.treasuryWallet ? ` (wallet ${s.treasuryWallet})` : ''}`,
    `- treasury buy/burn: ${s.buyBurn}`,
    `- social: ${s.social}`,
    `- website: ${s.website}`,
    `- voice: ${s.voice}`,
    `RULE: whenever you say you can, cannot or did not do something, or quote money or a limit, name the check in one short sentence, e.g. "Checked ${hhmm(s.readAt)} via the gateway status: shell execution disabled, treasury signer not connected." Never state a limit from memory alone, and never claim a check you did not get from this block or a tool result.`,
  ].join('\n');
}
