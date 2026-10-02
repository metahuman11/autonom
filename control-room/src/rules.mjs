// The hard rules from AGENT_SYSTEM_PROMPT.md, as code. The simulated agent checks
// proposals and replies with these before acting, and the local gateways check again
// — a rule the agent can argue itself out of is not a rule.
import { PROFILE_TYPE, validateProfilePayload } from './project-profile.mjs';
import { DEX_TYPES, validateDexPayload } from './dex-policy.mjs';
import { WALLET_TYPES, isWalletType, validateWalletPayload } from './wallet-proposals.mjs';
import {LAUNCH_TYPE,isLaunchType,validateLaunchPayload} from './community-actions.mjs';
const FORBIDDEN = [
  [/private\s*key|seed\s*phrase|mnemonic|api[\s_-]*key|\.env\b|\/etc\/gateway|\/run\/gateway|secrets?\//i, "requests or exposes protected credentials"],
  [/ignore (all |the )?(previous|prior) instructions|developer mode|disable (the )?(stream|firewall|signer|monitor)/i, "contains a prompt-injection instruction"],
  [/send (me |us )?(funds|eth|usdc|tokens|money)|transfer (the )?(funds|treasury)|withdraw|drain/i, "asks to move funds"],
  [/guarantee(d)? (returns?|profit)|100x|1000x|to the moon|price will|will pump|financial advice|not financial advice.*buy/i, "financial promises or price predictions"],
  [/connect (your )?wallet|sign this (message|transaction)|seed|airdrop claim/i, "wallet-connection or signature phishing"],
  [/<script|javascript:|onerror=|onload=/i, "executable script content"],
];

export function checkText(text, { maxLen = 1000 } = {}) {
  const s = String(text ?? "");
  if (!s.trim()) return { ok: false, reason: "empty content" };
  if (s.length > maxLen) return { ok: false, reason: `longer than ${maxLen} characters` };
  for (const [re, reason] of FORBIDDEN) if (re.test(s)) return { ok: false, reason };
  return { ok: true };
}

export const PROPOSAL_TYPES = ["X_POST", "FARCASTER_POST", "FARCASTER_EDIT_PROFILE", "FARCASTER_REPLY", "WEBSITE_UPDATE", "TASK", "MISSION_CHANGE", PROFILE_TYPE, ...DEX_TYPES, ...WALLET_TYPES, LAUNCH_TYPE];

/// Validates an approved proposal against the hard rules before any side effect.
export function checkProposal(p) {
  if (!PROPOSAL_TYPES.includes(p?.type)) return { ok: false, reason: "unknown proposal type" };
  const x = p.payload || {};
  if(isLaunchType(p.type)){try{validateLaunchPayload(x);return checkText(x.name+' '+x.symbol+' '+x.description,{maxLen:600});}catch(e){return {ok:false,reason:e.message};}}
  if(isWalletType(p.type)){try{validateWalletPayload(p.type,x);return {ok:true};}catch(e){return {ok:false,reason:e.message};}}
  switch (p.type) {
    case 'DEX_UPDATE':
    case 'DEX_BOOST':
      try { validateDexPayload(p.type,x); return checkText(JSON.stringify(x),{maxLen:6000}); }
      catch(e) { return {ok:false,reason:e.message}; }
    case PROFILE_TYPE:
      try { validateProfilePayload(x); return checkText(Object.entries(x.changes).filter(([k])=>k!=='logoPng').map(([,v])=>v).join('\n')||'Logo update', {maxLen:2500}); }
      catch(e) { return {ok:false,reason:e.message}; }
    case "X_POST":
      return checkText(x.text, { maxLen: 280 });
    case "FARCASTER_POST":
      return x.imageUrl && !/^https:\/\//.test(x.imageUrl) ? { ok: false, reason: "image URL must be https" } : checkText(x.text, { maxLen: 320 });
    case "FARCASTER_REPLY":
      if (!/^0x[0-9a-fA-F]{8,}$/.test(String(x.parentCastHash || ""))) return { ok: false, reason: "invalid parent cast hash" };
      return checkText(x.text, { maxLen: 320 });
    case "FARCASTER_EDIT_PROFILE": {
      if (!/\bAI\b|\bagent\b/i.test(String(x.bio || ""))) return { ok: false, reason: "the bio must disclose that the account is an AI agent" };
      const bio = checkText(x.bio, { maxLen: 160 });
      if (!bio.ok) return bio;
      return checkText(x.displayName || "agent", { maxLen: 40 });
    }
    case "WEBSITE_UPDATE":
      return checkText(`${x.description || ""}\n${x.content || ""}`, { maxLen: 5000 });
    case "TASK":
      return checkText(x.description, { maxLen: 2000 });
    case "MISSION_CHANGE":
      return checkText(x.mission, { maxLen: 1000 });
    default:
      return { ok: false, reason: "unsupported" };
  }
}

export const STATUS_PHRASES = [
  "starting up",
  "working on an approved task",
  "checking the website",
  "working on the default mission",
  "paused because the budget is exhausted",
  "paused because a required service is unavailable",
];

export const statusNoteText = (phrase, domain) => `🔴 Live: ${phrase} — watch at https://${domain}`;
