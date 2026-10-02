// Holder-ordered coin launches (owner 2026-10-02: "@kurt create a coin on pumpfun called kurt" → "bunu da ekle").
// An ORDER-role holder of a running project names a coin; the gateway launches it on pump.fun through the
// same pipeline the launch page uses, with the ordering project's treasury as the creator wallet (it pays the
// ~0.006 SOL rent and fees; the new coin's own creator fees go to the new coin's own treasury). The new project
// gets the recommended model, the cheapest in-stock RTX 5090 and a generated logo; it starts like any launch
// once its treasury reaches $5. Bounded: one launch per project per 30 minutes, never the same message twice.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { save, saveDurable, event } from "./store.mjs";
import * as wallets from "./wallets.mjs";
import { solanaRpc } from "./solana-billing.mjs";
import { signWire, LAMPORTS_PER_SOL } from "./solana.mjs";
import { prepare, confirm, launchesEnabled } from "./launch-pump.mjs";
import { newLaunchPackage } from "./launch-package.mjs";
import { defaultModel } from "./providers.mjs";
import { inventory } from "./inventory.mjs";

export const LAUNCH_GAP_MS = 30 * 60_000, LAUNCH_MIN_LAMPORTS = 30_000_000;   // 0.03 SOL: rent + fees + a margin
const fail = (status, message) => Object.assign(new Error(message), { status });

/// "create a coin on pumpfun called kurt", "launch a token named Kurt Coin", "make a memecoin $KURT" → {name, symbol} | null
export function parseLaunchIntent(text) {
  const raw = String(text || "").replace(/^\s*@kurt[,:]?\s*/i, "").trim(), low = raw.toLowerCase();
  if (!/\b(create|launch|make|deploy|mint|start)\b/.test(low) || !/\b(coin|token|memecoin|meme coin)\b/.test(low)) return null;
  if (/\?\s*$/.test(low) || /\b(don'?t|do not|never|should i|can i|could i|how (do|to))\b/.test(low)) return null;
  let name = null;
  const called = raw.match(/\b(?:called|named|name(?:d)?(?: is)?|titled)\s+["“']?([A-Za-z0-9][A-Za-z0-9 _.-]{0,30}?)["”']?(?=\s+(?:on|with|and|please|pls|for|now|that|which)\b|[,.!]|$)/i);
  if (called) name = called[1].trim();
  const ticker = raw.match(/\$([A-Za-z0-9]{2,10})\b/);
  if (!name && ticker) name = ticker[1];
  if (!name) return null;
  const symbol = (ticker ? ticker[1] : name).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  if (symbol.length < 2) return null;
  name = name.replace(/\s+/g, " ").slice(0, 32);
  name = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { name, symbol };
}

function logoPng(symbol) {
  const hue = createHash("sha256").update(symbol).digest()[0] * 360 / 256, initials = symbol.slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="96" fill="hsl(${hue.toFixed(0)} 55% 40%)"/><circle cx="256" cy="256" r="176" fill="hsl(${hue.toFixed(0)} 60% 30%)"/><text x="256" y="330" font-family="DejaVu Sans, Arial, sans-serif" font-size="${initials.length > 1 ? 200 : 260}" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function cheapestOffer() {
  const inv = await inventory();
  const o = (inv.offers || []).filter((x) => (x.reliability ?? 1) >= 0.98 && x.dph <= 1 && (x.upMbps || 0) >= 50).sort((a, b) => a.dph - b.dph)[0];
  if (!o) throw fail(503, "no machine in stock under $1/h right now");
  return o;
}

export async function launchCoinFromChat(t, m, { name, symbol }, { rpc = solanaRpc(), now = Date.now } = {}) {
  if (t.chain !== "solana" || t.treasury?.mode !== "wallet") throw fail(400, "coins are launched from Solana wallet projects only");
  if (!launchesEnabled()) throw fail(503, "pump.fun launches are switched off right now");
  const journal = (t.chatLaunches ||= {});
  if (journal[m.id]) return { ...journal[m.id], duplicate: true };
  const last = Object.values(journal).filter((r) => r.state !== "failed").reduce((ms, r) => Math.max(ms, Date.parse(r.createdAt || "") || 0), 0);
  if (now() - last < LAUNCH_GAP_MS) throw fail(429, `this project launched a coin ${Math.round((now() - last) / 60_000)} min ago; the next one is possible in ${Math.ceil((LAUNCH_GAP_MS - (now() - last)) / 60_000)} min`);
  const signer = wallets.solanaTreasurySigner(t.address);
  if (signer.address !== t.treasury.wallet) throw fail(500, "treasury signer does not match the project treasury");
  const lamports = await rpc.getBalance(signer.address);
  if (!(lamports >= LAUNCH_MIN_LAMPORTS)) throw fail(402, `the treasury needs at least ${LAUNCH_MIN_LAMPORTS / LAMPORTS_PER_SOL} SOL for rent and fees`);
  const [model, offer, logo] = await Promise.all([defaultModel(), cheapestOffer(), logoPng(symbol)]);
  const description = `${name} ($${symbol}) was launched from the ${t.symbol} community by Kurt, the AI agent of ${t.name} on Autonom, on a holder's order. Its creator fees fund its own AI agent and computer.`.slice(0, 400);
  const prep = await prepare({ creator: signer.address, name, symbol, description, logo: logo.toString("base64"), model, offerId: offer.id, launchPackageVersion: newLaunchPackage().version, firstBuySol: "0" }, { ip: null });
  const rec = journal[m.id] = { id: m.id, messageId: m.id, holder: m.holder, name, symbol, prepId: prep.id, mint: prep.mint, treasury: prep.treasury, model, offerId: offer.id, state: "prepared", createdAt: new Date(now()).toISOString() };
  saveDurable();
  const { wire, signature } = await signWire(prep.transaction, signer);
  Object.assign(rec, { signature, state: "sent", sentAt: new Date(now()).toISOString() }); saveDurable();   // durable before the broadcast
  try { await rpc.sendTransaction(wire, { skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" }); }
  catch (e) { rec.state = "failed"; rec.error = String(e?.message || e).slice(0, 160); save(); throw fail(502, `launch transaction not sent: ${rec.error}`); }
  let result = null;
  for (let i = 0; i < 12 && !result; i++) {
    const c = await confirm({ id: prep.id, signature }).catch((e) => ({ status: "error", error: String(e?.message || e) }));
    if (c?.status === "done") result = c;
    else if (c?.status === "failed") { rec.state = "failed"; rec.error = "launch transaction failed on chain"; save(); throw fail(502, rec.error); }
    else await new Promise((r) => setTimeout(r, 5000));
  }
  rec.state = result ? "done" : "pending"; rec.confirmedAt = result ? new Date(now()).toISOString() : null; save();
  event("launch", `${t.symbol}: holder-ordered launch of ${name} ($${symbol}) ${result ? "landed" : "sent"} — mint ${prep.mint} (${signature.slice(0, 12)}…)`, { token: t.address });
  return { ...rec, duplicate: false };
}
