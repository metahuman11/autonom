// Exact, community-voted purchase intents. These are NOT payment credentials.
import { isIP } from 'node:net';
export const DEX_TYPES = Object.freeze(['DEX_UPDATE', 'DEX_BOOST']);
export const isDexType = type => DEX_TYPES.includes(type);
const fail = message => Object.assign(new Error(message), {status:400});
export function positiveInteger(value, name, max = 1_000_000_000_000) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw fail(`Invalid ${name}`);
  return value;
}
export function publicHttps(value) {
  if (typeof value !== 'string' || value.length > 500) throw fail('Use a public HTTPS URL under 500 characters');
  let u; try { u = new URL(value); } catch { throw fail('Invalid HTTPS URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || u.search || isIP(u.hostname) ||
      !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname) || u.hostname.endsWith('.') || u.hostname.startsWith('['))
    throw fail('Use a public HTTPS URL without credentials, query parameters or fragments');
  return value; // No URL is fetched by this module or the Gateway server.
}
export function validateDexPayload(type, x, t = null) {
  if (!isDexType(type) || !x || typeof x !== 'object' || Array.isArray(x)) throw fail('Invalid DEX purchase');
  const padre = x.provider === 'padre';
  const common = ['chain','tokenAddress','maxCostMicros','expiresAt',...(padre?['provider','maxNetworkFeeMicros']:['maxNetworkFeeLamports'])];
  const extra = type === 'DEX_UPDATE' ? ['description','iconImageUrl','headerImageUrl','links'] : ['boosts'];
  if (Object.keys(x).some(k => ![...common,...extra].includes(k))) throw fail('Unexpected DEX purchase field');
  if (typeof x.chain !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(x.chain)) throw fail('Invalid target chain');
  if (typeof x.tokenAddress !== 'string' || !(x.chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(x.tokenAddress)) throw fail('Invalid target token address');
  if (t && (x.chain !== t.chain || (x.chain === 'solana' ? x.tokenAddress !== t.address : x.tokenAddress.toLowerCase() !== t.address.toLowerCase()))) throw fail('Only this project token can be promoted');
  positiveInteger(x.maxCostMicros,'spending limit');
  if(padre)positiveInteger(x.maxNetworkFeeMicros,'network fee limit in USD',100_000_000);
  else positiveInteger(x.maxNetworkFeeLamports,'network fee limit',100_000_000);
  if (typeof x.expiresAt !== 'string' || !Number.isFinite(Date.parse(x.expiresAt)) || new Date(x.expiresAt).toISOString() !== x.expiresAt) throw fail('Invalid purchase expiry');
  if (type === 'DEX_BOOST') positiveInteger(x.boosts,'boost quantity',1_000_000);
  else {
    if (typeof x.description !== 'string' || !x.description.trim() || x.description.length > 1000) throw fail('Description must contain 1–1000 characters');
    publicHttps(x.iconImageUrl); publicHttps(x.headerImageUrl);
    if (!Array.isArray(x.links) || x.links.length > 5) throw fail('At most five public links are allowed');
    for (const link of x.links) {
      if (!link || typeof link !== 'object' || Object.keys(link).some(k=>!['url','label'].includes(k)) || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 40) throw fail('Invalid social link');
      publicHttps(link.url);
    }
  }
  return x;
}
export function validateNewDexProposal(t,type,payload,{now=Date.now(),votingHours=6}={}) {
  validateDexPayload(type,payload,t);
  const end = Date.parse(payload.expiresAt), voteEnd = now + votingHours * 3_600_000;
  if (end <= voteEnd || end > voteEnd + 7 * 86_400_000) throw fail('Purchase must expire after voting and within seven days of its end');
  if ((t.proposals||[]).filter(p=>isDexType(p.type)&&p.status==='voting'&&!p.cancelledAt&&!p.revokedAt).length >= 8) throw fail('Eight open DEX purchase votes already exist');
}
export function dexCapabilities(t) {
  return DEX_TYPES.map(type => ({type, label:type==='DEX_UPDATE'?'Dex Update':'Dex Boost', provider:'padre', preparationAvailable:true, automaticPayment:false,
    status: type==='DEX_BOOST'?'provider_unverified':'account_not_connected',
    targetChain:t.chain,targetChainVerified:false,
    reason: type==='DEX_BOOST'?'Boost purchasing through Padre is not verified. Approval can prepare a request, but cannot place an order or pay.':
      'Padre account not connected. Approved requests can be prepared; chain eligibility, checkout and payment must still be verified.',
    source:type==='DEX_UPDATE'?'https://x.com/TradingTerminal/status/2008947770560823440':'https://docs.dexscreener.com/api/reference',
    priceMicros:null}));
}
