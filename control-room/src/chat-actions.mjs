// Instant actions for ORDER-role holders (more than orderMinPct of the supply). Owner policy,
// 2026-10-02: their requests are carried out, not voted on, as long as no secret is exposed and
// no money moves. The AI on the project's machine ends its reply with one ACTION line; the
// gateway executes it here, strips the line from the public reply and appends what happened.
import { createHash, randomBytes } from 'node:crypto';
import { get, save, event } from './store.mjs';
import { payloadHash } from './canonical.mjs';
import { checkProposal } from './rules.mjs';
import { holderRole } from './economy.mjs';
// The X (Twitter) account integration is not part of Autonom and was removed from this repository; these names are inert stubs.
const xPosts = () => ({ status: () => ({ connected: false }), submitAction: async () => { throw Object.assign(new Error('X posting is not part of Autonom'), { status: 409 }); } }), xAccountOf = () => null;
import { enforceChatModeration } from './chat-moderation.mjs';
import { holderKey } from './solana-auth.mjs';
import { parseBuyIntent, treasuryBuy, isProjectCreator, BUY_MIN_USD, BUY_MAX_USD } from './treasury-buy.mjs';
import { projectLogo } from './project-profile.mjs';
import { parseLaunchIntent, launchCoinFromChat } from './chat-launch.mjs';
import sharp from 'sharp';
import { isOfficialToken, OFFICIAL_X_HANDLE } from './official-token.mjs';
import { X_FEATURE_ENABLED } from './x-feature.mjs';

export const STAGE_TTL_MS = 2 * 60 * 60 * 1000;
/// Machines registered before this moment run the older desktop app, which cannot show a staged page.
export const STAGE_SUPPORT_SINCE = Date.parse('2026-10-02T06:10:00Z');
const stampMs = (v) => (typeof v === 'number' ? v : Date.parse(v || ''));   // registeredAt is stored as epoch ms, startedAt as ISO
export function machineShowsStage(t) { const at = stampMs(t.vps?.registeredAt) || stampMs(t.vps?.startedAt); return Number.isFinite(at) && at >= STAGE_SUPPORT_SINCE; }
const ACTION_LINE = /^[ \t]*(?:[-*>`]+[ \t]*)?ACTION[ \t]+(open_url|close_url|x_post|website|x_profile|launch_coin)\b[ \t]*(.*?)[ \t`]*$/gim;
const PRIVATE_HOST = /^(localhost|.*\.(local|internal|lan|home|arpa)|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd]|\[?fe80)/i;

export function parseChatActions(text) {
  const actions = [];
  const stripped = String(text ?? '').replace(ACTION_LINE, (_m, kind, arg) => { actions.push({ kind: kind.toLowerCase(), arg: String(arg || '').trim() }); return ''; });
  return { actions, text: stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}
export function safeStageUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim().replace(/^<|>$/g, '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 500 || PRIVATE_HOST.test(u.hostname)) return null;
  return u;
}
/// What the MACHINE opens. YouTube's normal pages greet a datacenter IP with the "Before you continue"
/// consent wall and nothing plays (owner 2026-10-02, "feel good song"); the privacy-enhanced embed player
/// has no wall and autoplays with sound on the machine's Chrome. A search becomes its first result.
const YT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export async function machineStageUrl(u) {
  const h = u.hostname.replace(/^(www|m)\./, '');
  const embed = (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`;
  if (h === 'youtu.be') return embed(u.pathname.slice(1).split('/')[0]);
  if (h !== 'youtube.com' && h !== 'music.youtube.com') return u.href;
  const v = u.searchParams.get('v'), list = u.searchParams.get('list'), q = u.searchParams.get('search_query') || u.searchParams.get('q');
  const path = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
  if (v) return embed(v);
  if (path) return embed(path[1]);
  if (list) return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}&autoplay=1&rel=0`;
  if (q) {
    try {
      const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': YT_UA, Cookie: 'SOCS=CAI; CONSENT=YES+1', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
      const id = (await r.text()).match(/"videoId":"([\w-]{11})"/)?.[1];
      if (id) return embed(id);
    } catch { /* the search page itself is still better than nothing */ }
  }
  return u.href;
}
/// What the desktop page frames. YouTube pages refuse framing; their embed player does not.
export function embedUrlFor(u) {
  const h = u.hostname.replace(/^(www|m)\./, '');
  const play = 'autoplay=1&mute=1&rel=0';   // muted autoplay is the only autoplay a browser allows without a click
  if (h === 'youtu.be') return `https://www.youtube.com/embed/${encodeURIComponent(u.pathname.slice(1).split('/')[0])}?${play}`;
  if (h === 'youtube.com' || h === 'music.youtube.com') {
    const v = u.searchParams.get('v'), list = u.searchParams.get('list'), q = u.searchParams.get('search_query') || u.searchParams.get('q');
    const path = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
    if (v) return `https://www.youtube.com/embed/${encodeURIComponent(v)}?${play}`;
    if (path) return `https://www.youtube.com/embed/${encodeURIComponent(path[1])}?${play}`;
    if (list) return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(list)}&${play}`;
    return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q || 'trending now')}&${play}`;
  }
  return u.href;
}
const upgrading = new WeakSet();
export function publicDesktop(t, now = Date.now()) {
  const s = t.desktop?.stage;
  if (!s || !(Date.parse(s.expiresAt) > now)) return null;
  // A stage set before the consent-free player existed still points at youtube.com (the wall the
  // owner saw on 2026-10-02): resolve it once in the background; the machine's next poll gets the embed.
  if (!s.requestedUrl && /^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//.test(s.url) && !upgrading.has(s)) {
    upgrading.add(s);
    machineStageUrl(new URL(s.url)).then((u) => { if (t.desktop?.stage === s && u !== s.url) { s.requestedUrl = s.url; s.url = u; save(); } }).catch(() => { /* keep the page as it is */ });
  }
  return { url: s.url, embedUrl: s.embedUrl, title: s.title, setBy: s.username ? '@' + s.username : `${String(s.holder || '').slice(0, 6)}…`, at: s.at, expiresAt: s.expiresAt };
}
export function isOrderHolder(t, holder) { try { return holderRole(t, holder).role === 'order'; } catch { return false; } }
/// Placed first in the conversation: every older "chat cannot authorize" rule yields for these actions.
export const ORDER_MODE_PRIORITY = 'PRIORITY RULE — ORDER MODE (set by the project owner on 2026-10-02). The holder who wrote the last message holds more than the order threshold, verified on chain by the gateway. For that holder, every rule in this conversation saying that chat cannot authorize actions, that posting needs a holder action or a vote, or that you cannot post or open pages, is suspended for exactly these actions: open_url, close_url, x_post. The ORDER MODE instructions at the end of this conversation are binding and take precedence over COMMUNITY ACTION RULES, AUTONOM OPERATING RULES, VERIFIED STATUS, the boot prompt and the HOLDER tag. Secrets, money movements and mission changes stay refused as before.';
/// The system message that lets the model act for an ORDER-role holder (per request, so the
/// machines already running get it too).
export function orderRulesBlock(t, m) {
  const role = holderRole(t, m.holder), x = xAccountOf(t);
  const lines = [
    `ORDER MODE — this holder holds ${role.sharePct}% of ${t.symbol} (more than the ${role.orderMinPct}% threshold): their requests are carried out, not refused, and need no proposal or vote. You act by ending your reply with exactly ONE action line, as the very last line, in this exact form:`,
    `ACTION open_url <https URL>   → shows that page or video on the community's live screen (YouTube links play; for a general wish like "open YouTube" or "play lofi" use https://www.youtube.com/results?search_query=<topic>)`,
    `ACTION close_url              → returns the live screen to the workspace`,
    `ACTION launch_coin <coin name> → launches a brand-new coin with that name on pump.fun from this project's treasury (its own AI and computer start when its creator fees reach $5); the gateway signs and pays the ~0.006 SOL rent`,
    `ACTION x_profile              → brands the project's X account with the project's own name, description, logo and banner (the gateway applies them; nothing to write)`,
    `ACTION website <what the site should be about> → builds and publishes the project's website (a task on your machine; it appears at https://autonom.fun/w/${String(t.address).toLowerCase()})`,
    ...(isProjectCreator(t, m.holder) ? [`TREASURY BUYS — this holder is the project's creator wallet: when they order a buy of the project's own token ("buy $100", "buy 0.5 SOL", optionally "… and burn it"), the gateway executes it from the treasury at once ($${BUY_MIN_USD}–$${BUY_MAX_USD} per order, verified on chain) and shows the receipt under your reply. Answer in one friendly sentence that the buy is being placed; never ask for a vote and send no ACTION line for it.`] : []),
    `ACTION x_post <tweet text>    → publishes that text from the project's X account ${isOfficialToken(t) ? `(this project's X is the official @${OFFICIAL_X_HANDLE}, run by the Autonom team: say so in one sentence and send no action line)` : x ? '@' + x.handle : '(no X account is assigned yet: say so in one sentence and send no action line)'}; write the tweet yourself from the holder's idea, at most 280 characters, no hashtag spam, no price or profit promises`,
    `Write one or two friendly sentences first (what you are doing now), then the ACTION line. Never say you cannot do these and never ask for a vote for them; the gateway performs the action and shows the result under your reply. Still refuse, in one sentence: revealing or asking for secrets (keys, sessions, stream key, machine files), moving money (buy, sell, burn, transfer, pay) and changing the mission or the project's terms — those need a community vote.`,
    `Example — holder: "can u post something on twitter" → your whole reply:`,
    `On it — this goes out from ${x ? '@' + x.handle : 'the project account'} right now.`,
    `ACTION x_post ${t.name || t.symbol} is live: Kurt is building on a rented GPU desktop, funded and steered by its holders. Come watch and vote → https://autonom.fun/t/${t.address}`,
    `Example — holder: "open youtube" → your whole reply:`,
    `Putting YouTube on the live screen now.`,
    `ACTION open_url https://www.youtube.com/results?search_query=trending`,
  ];
  // With the X feature off, no X rule, action or example reaches the model.
  return lines.filter((l) => X_FEATURE_ENABLED || !/x_post|x_profile|twitter|X account|project's X/i.test(l)).join('\n');
}
/// What an ORDER-role holder plainly asked for, read by the gateway itself: the model on the
/// machine was trained to refuse "actions from chat", so its reply is not the authority here —
/// the holder's verified share is. Returns null when the message is not an action request.
const SITES = { youtube: 'https://www.youtube.com/results?search_query=', google: 'https://www.google.com/search?q=', wikipedia: 'https://en.wikipedia.org/wiki/Special:Search?search=', reddit: 'https://www.reddit.com/search/?q=', github: 'https://github.com/search?q=' };
export function inferOrderIntent(t, text) {
  const raw = String(text || '').replace(/^\s*@kurt[,:]?\s*/i, '').trim(); if (!raw) return null;
  const low = raw.toLowerCase();
  const url = raw.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  // Only a request counts: not a question about something, not a negation.
  if (/^\s*(did|does|do|has|have|what|why|when|who|where|how|is|are|was|were)\b/.test(low) && !/\b(can|could|would|will|pls|please)\s+(you|u|kurt)\b/.test(low)) return null;
  if (/\b(don'?t|do not|never|not|without|stop|cancel)\s+(post|tweet|share|publish|announce|open|show|play)\b/.test(low)) return null;
  if (/\b(close|stop|hide|clear)\b.*\b(screen|video|youtube|browser|site|page|tab)\b/.test(low) || /\bclose_url\b/.test(low)) return { kind: 'close_url', arg: '' };
  const wantsPost = /\b(post|tweet|share|publish|announce|send)\b/.test(low) && /\b(twitter|tweet|a tweet|tweets|x account|on x|to x|via x)\b/.test(low);
  if (wantsPost) {
    const quoted = raw.match(/["“]([^"”]{3,280})["”]/)?.[1] || raw.match(/(?:post|tweet|share|publish|announce|say|write)\s*(?:this|that)?\s*(?:on|to)?\s*(?:twitter|x|tweet)?\s*[:\-–]\s*(.{3,280})$/i)?.[1];
    const fallback = `${t.name || t.symbol} is live on Autonom: Kurt, its AI, is working on a rented GPU desktop, funded and steered by its holders. Watch and vote → https://autonom.fun/t/${t.address}`;
    return !X_FEATURE_ENABLED ? null : { kind: 'x_post', arg: (quoted || fallback).trim().slice(0, 280) };
  }
  // "create a coin on pump.fun called kurt" → a real launch from this project's treasury.
  const launch = parseLaunchIntent(raw);
  if (launch) return { kind: 'launch_coin', arg: raw };
  // "change the logo / name / bio of our X account" → the project's identity goes onto the account.
  const aboutX = /\b(x|twitter)\b[^.]*\b(account|profile|page)\b|\b(account|profile)\b[^.]*\b(x|twitter)\b/.test(low) || /\b(twitter|x) (logo|name|bio|banner|pfp|avatar)\b/.test(low);
  if (aboutX && /\b(change|update|set|edit|fix|upload|put|apply|use|brand|customi[sz]e)\b/.test(low) && /\b(logo|avatar|pfp|picture|photo|image|name|bio|description|banner|header|profile)\b/.test(low)) return X_FEATURE_ENABLED ? { kind: 'x_profile', arg: raw } : null;
  // A website request becomes an approved WEBSITE_UPDATE task the machine's agent builds and publishes.
  const site = /\b(web ?site|landing page|homepage|web ?page|site)\b/.test(low);
  const wantsBuild = /\b(build|make|create|publish|update|change|redesign|design|set ?up|write|improve|fix)\b/.test(low);
  if (site && wantsBuild && !url) return { kind: 'website', arg: raw };
  const wantsOpen = /\b(open|show|play|put|display|load|go to|visit|watch|start|listen)\b/.test(low);
  if (wantsOpen && url) return { kind: 'open_url', arg: url };
  // "open a music", "play some jazz", "listen to lofi": YouTube is the only player on the machine.
  if (wantsOpen && /\b(music|song|songs|track|playlist|radio|jazz|lofi|lo-fi|hip ?hop|rap|rock|pop|m[uü]zik|[sş]ark[iı])\b/.test(low)) {
    const topic = low.replace(/\b(can|could|you|u|please|pls|kurt|open|show|play|put|display|load|go to|visit|watch|start|listen|to|on|the|a|an|some|something|me|us|pc|computer|machine|screen|live|youtube|up)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ');
    // No topic: a 24/7 stream starts playing at once (Chrome runs with autoplay allowed); a topic opens the search results.
    if (!topic || /^(music|song|songs|some music|m[uü]zik|[sş]ark[iı])$/.test(topic)) return { kind: 'open_url', arg: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' };
    return { kind: 'open_url', arg: SITES.youtube + encodeURIComponent(topic) };
  }
  if (wantsOpen) {
    const dom = low.match(/\b([a-z0-9-]+\.(?:com|net|org|io|fun|tv|app|dev|xyz|co))\b/);
    if (dom) return { kind: 'open_url', arg: 'https://' + dom[1] };
    for (const [site, base] of Object.entries(SITES)) {
      if (!low.includes(site)) continue;
      const topic = low.replace(/\b(can|could|you|u|please|pls|kurt|open|show|play|put|display|load|go to|visit|watch|on|the|live|screen|a|an|some|something|me|us|video|videos|up)\b/g, ' ').replace(site, ' ').replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ');
      return { kind: 'open_url', arg: topic ? base + encodeURIComponent(topic) : (site === 'youtube' ? SITES.youtube + 'trending' : base.replace(/\/(search|results|wiki).*$/, '/')) };
    }
  }
  return null;
}

/// An ORDER-role holder's website request opens a WEBSITE_UPDATE task that is approved on the spot
/// (no vote): the machine's existing proposal pipeline drafts the page with the project's AI and
/// publishes it through /svc/website, so machines already running pick it up on their next cycle.
export function openInstantWebsiteTask(t, m, request) {
  const description = String(request || m.text || '').replace(/^\s*@kurt[,:]?\s*/i, '').trim().slice(0, 1500);
  if (description.length < 8) throw Object.assign(new Error('say what the website should be about'), { status: 400 });
  const payload = { description, source: 'order-chat', requestedBy: m.holder, messageId: m.id };
  const checked = checkProposal({ type: 'WEBSITE_UPDATE', payload });
  if (!checked.ok) throw Object.assign(new Error(checked.reason), { status: 400 });
  t.proposals ||= [];
  const open = t.proposals.find((p) => p.type === 'WEBSITE_UPDATE' && p.status === 'approved' && p.payload?.source === 'order-chat' && !p.cancelledAt && !p.revokedAt && !['done', 'rejected_by_rules', 'paused', 'failed'].includes(p.agentStatus));
  if (open) return { proposal: open, duplicate: true };
  const now = new Date().toISOString();
  let simMs = Date.now(); try { simMs = get().clock?.simMs ?? simMs; } catch { /* offline stage */ }
  const p = { id: `prop_${randomBytes(6).toString('hex')}`, type: 'WEBSITE_UPDATE', title: `Website: ${description.slice(0, 80)}`, payload, payloadHash: payloadHash({ type: 'WEBSITE_UPDATE', payload }),
    proposer: holderKey(t, m.holder), createdAt: now, endsAt: now, createdSimMs: simMs, endsSimMs: simMs,
    snapshot: {}, snapshotTotal: 0, votes: {}, status: 'approved', instant: true, tally: { passed: true, basis: 'order-role instant action, no vote' },
    agentStatus: null, agentReason: null, result: null, order: t.proposals.length + 1, approvedOrder: t.proposals.filter((x) => x.approvedOrder).length + 1 };
  t.proposals.push(p);
  try { event('proposal', `${t.symbol}: website task opened from chat by an order-role holder (${p.id})`, { token: t.address }); } catch { /* event log is best effort */ }
  return { proposal: p, duplicate: false };
}

const X_STEP_GAP_MS = 31_000;   // x-posts.mjs X_ACTION_MIN_GAP_MS plus a second
const firstParagraph = (s) => String(s || '').split(/\n\s*\n/)[0].replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
const clipWords = (s, n) => { const t = [...s]; if (t.length <= n) return s; const cut = s.slice(0, n - 1); return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim() + '…'; };
/// Brands the X account with the project's identity: name + bio + website now, the logo (upscaled to
/// 400×400 when the launch logo is small) and the generated banner in two later steps, because the broker
/// takes one action per 30 s. Each step is a normal signed holder action with its own receipt.
export async function applyXProfile(t, m) {
  const x = xAccountOf(t);
  if (!x) return '⚠ No X account is assigned to this project yet.';
  const bio = clipWords(firstParagraph(t.projectProfile?.description || t.website?.content) || `${t.name} — an AI agent project on Autonom. Holders steer it from autonom.fun.`, 160);
  const profile = { name: String(t.projectProfile?.displayName || t.name || t.symbol).slice(0, 50), bio, website: `https://autonom.fun/t/${t.address}` };
  const intent = (step) => createHash('sha256').update(`chat-x-profile:${t.address}:${m.id}:${step}`).digest('hex');
  const pending = [];
  let rec;
  try {
    enforceChatModeration(t, m.holder, `${profile.name} ${profile.bio}`, { persist: save });
    rec = await xPosts().submitAction(t, { holder: holderKey(t, m.holder), kind: 'profile', payload: { profile }, image: null, intentId: intent('profile') });
  } catch (e) { return `⚠ X profile not changed: ${String(e?.message || e).slice(0, 160)}`; }
  // Only a confirmed broker receipt is "updated"; a provider failure is said plainly (owner 2026-10-02: "gerçekten yapıyor mu?").
  if (rec?.state === 'failed' || rec?.state === 'refused') return `⚠ X did not accept the profile change (${rec.reason || rec.state}). Posting still works; name, bio, logo and banner can be set from the X panel or directly on x.com until the provider recovers.`;
  if (rec?.state !== 'applied') return `⏳ Profile change sent to X (${rec?.state || 'pending'}); the X panel shows the result in about a minute.`;
  const later = (ms, step, work) => { const timer = setTimeout(async () => { try { await work(); } catch (e) { try { event('x', `${t.symbol}: X ${step} from chat failed — ${String(e?.message || e).slice(0, 120)}`, { token: t.address, level: 'warn' }); } catch { /* best effort */ } } }, ms); timer.unref?.(); pending.push(step); };
  const logo = (() => { try { return projectLogo(t); } catch { return null; } })();
  if (logo) later(X_STEP_GAP_MS, 'logo', async () => {
    const png = await sharp(Buffer.from(logo), { limitInputPixels: 16_777_216, animated: false }).resize(400, 400, { fit: 'cover' }).png().toBuffer();
    const b64 = png.toString('base64');
    await xPosts().submitAction(t, { holder: holderKey(t, m.holder), kind: 'avatar', payload: { imageSha256: createHash('sha256').update(png).digest('hex') }, image: b64, intentId: intent('avatar') });
  });
  if (t.launchAssets?.banner?.state === 'ready') later(logo ? 2 * X_STEP_GAP_MS : X_STEP_GAP_MS, 'banner', async () => {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4750}/api/site/token/${t.address}/project-banner`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`banner read ${r.status}`);
    const png = Buffer.from(await r.arrayBuffer()), b64 = png.toString('base64');
    await xPosts().submitAction(t, { holder: holderKey(t, m.holder), kind: 'banner', payload: { imageSha256: createHash('sha256').update(png).digest('hex') }, image: b64, intentId: intent('banner') });
  });
  return `🪪 @${x.handle} updated: name “${profile.name}”, bio “${profile.bio}”, website ${profile.website}.${pending.length ? ` The ${pending.join(' and ')} follow within ${pending.length} minute${pending.length > 1 ? 's' : ''} (see the X panel for their result).` : ''}`;
}

/// Executes the action for an ORDER-role message and returns the public reply text. The model's
/// ACTION line is used when present; otherwise the holder's plain request decides.
export async function applyChatActions(t, m, rawText) {
  const parsed = parseChatActions(rawText);
  let { actions, text } = parsed;
  // The creator's treasury buy is decided and executed by the gateway, whatever the model wrote.
  if (isProjectCreator(t, m.holder)) {
    const buy = parseBuyIntent(m.text);
    if (buy) {
      try {
        const r = await treasuryBuy(t, m, buy);
        const amount = r.tokens != null ? `${r.tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${t.symbol}` : `about ${Number(r.expectedTokens || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${t.symbol}`;
        const burnNote = r.burn ? (r.burn.state === 'confirmed' ? `\n🔥 Burned ${Number(r.burn.tokens).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${t.symbol}: https://solscan.io/tx/${r.burn.signature}` : `\n⚠ The burn did not go through (${r.burn.error || r.burn.state}); the tokens stay in the treasury.`) : '';
        return r.duplicate ? `This order was already placed (${r.state}): https://solscan.io/tx/${r.signature}` : `Done — the treasury bought ${amount} for $${Number(r.usd).toFixed(2)} on your order.\n\n🛒 Receipt: https://solscan.io/tx/${r.signature}${burnNote}`;
      } catch (e) { return `I could not place that buy: ${String(e?.message || e).slice(0, 200)}`; }
    }
  }
  if (!isOrderHolder(t, m.holder)) return actions.length ? text : rawText;   // never act for smaller holders, whatever the model wrote
  if (!actions.length) {
    const intent = inferOrderIntent(t, m.text);
    if (!intent) return rawText;
    actions = [intent];
    text = 'On it — holders above the order threshold direct me straight from chat.';   // the model's refusal is not the answer
  }
  const notes = [];
  const a = actions[0];
  if (a.kind === 'close_url') {
    t.desktop = { ...(t.desktop || {}), stage: null, clearedAt: new Date().toISOString() };
    notes.push('▶ The live screen is back to the workspace.');
  } else if (a.kind === 'open_url') {
    const u = safeStageUrl(a.arg);
    if (!u) notes.push('⚠ That link cannot be shown: only public https links work.');
    else {
      const at = new Date();
      const machineUrl = await machineStageUrl(u);
      t.desktop = { ...(t.desktop || {}), stage: { url: machineUrl, requestedUrl: u.href, embedUrl: embedUrlFor(u), title: u.hostname.replace(/^www\./, ''), holder: m.holder, username: m.username || null, messageId: m.id, at: at.toISOString(), expiresAt: new Date(at.getTime() + STAGE_TTL_MS).toISOString() } };
      notes.push(machineShowsStage(t) ? `▶ Showing on the live screen: ${u.href}` : `▶ Queued for the live screen: ${u.href} — this machine started before screen sharing existed; it appears after the next machine restart.`);
    }
  } else if (a.kind === 'website') {
    try {
      const { proposal, duplicate } = openInstantWebsiteTask(t, m, a.arg);
      const url = `https://autonom.fun/w/${String(t.address).toLowerCase()}`;
      notes.push(duplicate ? `🌐 A website task is already in progress (${proposal.id}); it publishes at ${url} when done.` : `🌐 Building the website now: Kurt drafts it on the live screen and publishes it at ${url} within a few minutes (task ${proposal.id}).`);
    } catch (e) { notes.push(`⚠ Website task refused: ${String(e?.message || e).slice(0, 160)}`); }
  } else if (a.kind === 'launch_coin') {
    const spec = parseLaunchIntent(a.arg) || parseLaunchIntent(`create a coin called ${a.arg}`) || parseLaunchIntent(m.text);
    if (!spec) notes.push('⚠ Tell me the coin name, e.g. “create a coin called Kurt”.');
    else {
      try {
        const r = await launchCoinFromChat(t, m, spec);
        notes.push(r.duplicate ? `🚀 That launch was already placed (${r.state}): https://pump.fun/coin/${r.mint}` : `🚀 ${r.name} ($${r.symbol}) ${r.state === 'done' ? 'is live' : 'is launching'} on pump.fun from this treasury: https://pump.fun/coin/${r.mint} · project page https://autonom.fun/t/${r.mint}${r.state === 'done' ? ' — its own AI and computer start once its creator fees reach $5.' : ' — confirming on chain; the project page appears within a minute.'}`);
      } catch (e) { notes.push(`⚠ Launch not done: ${String(e?.message || e).slice(0, 200)}`); }
    }
  } else if ((a.kind === 'x_profile' || a.kind === 'x_post') && (!X_FEATURE_ENABLED || isOfficialToken(t))) {
    notes.push(isOfficialToken(t) ? `🐦 This project's X account is the official @${OFFICIAL_X_HANDLE}, run by the Autonom team — posts and profile changes are not made from chat here.` : '🐦 Posting on X is not part of Autonom. I can show things on the live screen or build the website instead.');
  } else if (a.kind === 'x_profile') {
    notes.push(await applyXProfile(t, m));
  } else if (a.kind === 'x_post') {
    const body = a.arg.replace(/^["“]|["”]$/g, '').trim();
    const x = xAccountOf(t);
    // The same text is never posted twice in a day (the owner's second test produced a byte-identical tweet).
    const dup = Object.values(t.xActions || {}).find((r) => r?.kind === 'post' && r.payload?.text === body && ['applied', 'submitted', 'waiting'].includes(r.state) && Date.now() - Date.parse(r.createdAt || 0) < 24 * 3600e3);
    if (!x) notes.push('⚠ No X account is assigned to this project yet.');
    else if (!body) notes.push('⚠ The post text was empty; nothing was sent.');
    else if (dup) notes.push(`🐦 That exact text already went out today${dup.url ? ': ' + dup.url : ''}. Tell me what to post next — e.g. “tweet: …” — and it goes out.`);
    else {
      try {
        enforceChatModeration(t, m.holder, body, { persist: save });
        const intentId = createHash('sha256').update(`chat-x-post:${t.address}:${m.id}`).digest('hex');
        const rec = await xPosts().submitAction(t, { holder: holderKey(t, m.holder), kind: 'post', payload: { text: body }, image: null, intentId });
        notes.push(rec?.url ? `🐦 Posted from @${x.handle}: ${rec.url}` : `🐦 Posting from @${x.handle}: “${body}” — the link appears in the X panel in about a minute.`);
      } catch (e) { notes.push(`⚠ X post not sent: ${String(e?.message || e).slice(0, 160)}`); }
    }
  }
  return `${text}\n\n${notes.join('\n')}`.trim();
}
