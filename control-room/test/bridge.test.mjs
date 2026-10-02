// The AI pocket refill against a local stand-in for Relay: a short pocket triggers an
// EXACT_OUTPUT quote, the quote is verified, the treasury sends exactly the quoted
// deposit, the status is polled to success, and a second refill is refused while one
// is in flight. Nothing leaves when the treasury cannot afford it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-bridge-"));
process.env.VAST_API_KEY = "";
process.env.GATEWAY_OFFLINE = "1";

const seen = { quotes: [], statusCalls: 0 };
let statusAnswer = "success";
const DEPOSIT_TO = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const relay = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/quote/v2") {
      const b = JSON.parse(body);
      seen.quotes.push(b);
      const micro = b.tradeType === "EXACT_OUTPUT" ? Number(b.amount) : 2_450_000;
      const inWei = b.tradeType === "EXACT_OUTPUT" ? String(Math.round(micro / 2_450_000 * 1e15)) : b.amount;
      const rid = "0x" + "ab".repeat(32);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        details: {
          currencyIn: { currency: { chainId: b.originChainId, address: b.originCurrency, symbol: "ETH" }, amount: inWei, amountFormatted: (Number(inWei) / 1e18).toFixed(6), amountUsd: String(Number(inWei) / 1e18 * 2489) },
          currencyOut: { currency: { chainId: b.destinationChainId, address: b.destinationCurrency, symbol: "USDC" }, amount: String(micro), amountFormatted: (micro / 1e6).toFixed(6), amountUsd: String(micro / 1e6 * 0.9996) },
          recipient: b.recipient, timeEstimate: 2,
        },
        fees: { gas: { amountUsd: "0.008" }, relayer: { amountUsd: "0.028" } },
        steps: [{ id: "deposit", kind: "transaction", requestId: rid, items: [{ status: "incomplete", data: { from: b.user, to: DEPOSIT_TO, data: "0x", value: inWei, chainId: b.originChainId }, check: { endpoint: `/intents/status/v3?requestId=${rid}`, method: "GET" } }] }],
      }));
    }
    if (url.pathname === "/intents/status/v3") { seen.statusCalls++; res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ status: statusAnswer, txHashes: ["0xout"], inTxHashes: ["0xin"] })); }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
process.env.RELAY_API_BASE = `http://127.0.0.1:${relay.address().port}`;

const { createControlRoom } = await import("../src/server.mjs");
const eco = await import("../src/economy.mjs");
const store = await import("../src/store.mjs");
const wallets = await import("../src/wallets.mjs");
const billing = await import("../src/billing.mjs");
const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => { room.close(); relay.close(); });
const api = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => null) }; };

// A treasury "signer" that records what it is asked to send instead of touching a chain.
const sent = [];
wallets.opsSigner.treasury = () => ({ sendTransaction: async (tx) => { sent.push(tx); return { hash: "0x" + "cd".repeat(32), wait: async () => ({ status: 1, hash: "0x" + "cd".repeat(32) }) }; } });

let token;
test("a short AI pocket is refilled with exactly the quoted deposit and the pocket is credited", async () => {
  token = (await api("POST", "/api/control/tokens", { name: "Bridge", symbol: "BRG", treasuryMode: "wallet" })).json.address;
  const t = eco.tokenOf(token);
  Object.assign(t.treasury, { robinhoodEth: 0.01, ethUsd: 2489, usdcMicros: 200_000 }); store.save();
  const before = t.treasury.robinhoodEth;
  const now = await billing.ensureAiPocket(t, 0);
  assert.equal(seen.quotes.at(-1).tradeType, "EXACT_OUTPUT");
  assert.equal(Number(seen.quotes.at(-1).amount), 3_000_000 - 200_000, "quotes the amount that brings the pocket to its target");
  assert.equal(seen.quotes.at(-1).recipient.toLowerCase(), t.treasury.wallet.toLowerCase());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.toLowerCase(), DEPOSIT_TO);
  assert.equal(String(sent[0].value), seen.quotes.at(-1) && String(Math.round(2_800_000 / 2_450_000 * 1e15)));
  assert.equal(t.treasury.bridge.status, "success");
  assert.ok(seen.statusCalls >= 1);
  assert.equal(now, 200_000, "offline: the cached pocket is what the chain read would refresh");
  assert.ok(t.treasury.ledger.some((l) => l.reason.startsWith("AI pocket refilled")));
  assert.equal(t.treasury.robinhoodEth, before, "the test signer moved nothing");
});

test("no refill when the treasury cannot afford it, and none while one is pending", async () => {
  const t = eco.tokenOf(token);
  Object.assign(t.treasury, { robinhoodEth: 0.0001, usdcMicros: 0 }); store.save();
  await assert.rejects(billing.ensureAiPocket(t, 0), /refilling the AI pocket needs/);
  assert.equal(sent.length, 1, "nothing was sent");
  Object.assign(t.treasury, { robinhoodEth: 0.05, bridge: { status: "pending", startedAt: new Date().toISOString(), requestId: "0x11" } }); store.save();
  await assert.rejects(billing.ensureAiPocket(t, 0), /already in flight/);
  assert.equal(sent.length, 1);
});

test("a failed settlement is recorded and does not credit the pocket", async () => {
  const t = eco.tokenOf(token);
  statusAnswer = "failure";
  Object.assign(t.treasury, { robinhoodEth: 0.05, usdcMicros: 0, bridge: null }); store.save();
  await assert.rejects(billing.ensureAiPocket(t, 0), /Relay bridge failure/);
  assert.equal(t.treasury.bridge.status, "failure");
  assert.ok(t.treasury.ledger.some((l) => l.reason.startsWith("bridge failure")));
});

test("the VPS hour is charged in Robinhood ETH at the live price", async () => {
  await api("POST", "/api/control/wallet/create");
  const t = eco.tokenOf(token);
  Object.assign(t.treasury, { robinhoodEth: 0.01, ethUsd: 2489, usdcMicros: 0 });
  Object.assign(t.vps, { hourlyMicros: 120_000, state: "running", mode: "real" }); store.save();
  const before = sent.length;
  const r = await billing.chargeVpsHour(t);
  assert.equal(r.paid, true); assert.equal(r.chain, "robinhood");
  const wei = sent[before].value;
  assert.ok(Math.abs(Number(wei) / 1e18 * 2489 - 0.12) < 0.0001, `charged about $0.12 in ETH (${wei})`);
  assert.equal(sent[before].to.toLowerCase(), wallets.opsAddress().toLowerCase());
});
