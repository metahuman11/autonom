// The x402 rail against a local stand-in for NanoGPT: the quote is parsed, the
// treasury signs exactly the quoted amount, the replay carries a valid EIP-3009
// authorization the recipient can verify, and nothing is signed when the treasury
// cannot cover the quote.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-x402-"));
process.env.VAST_API_KEY = "";

const seen = { quotes: 0, payments: [] };
const PAY_TO = "0x4F180B7752993b785BE84EbBb15cE99c97A926A1";
const nano = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const h = req.headers;
    if (h["x-x402"] === "true") {
      seen.quotes++;
      res.writeHead(402, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        payment: { version: 1, paymentId: "pay_1", amountUsd: "0.0002", expiresAt: new Date(Date.now() + 600_000).toISOString(),
          accepted: [{ scheme: "x402-exact", protocolScheme: "exact", network: "base", amount: "1000", amountUsd: "0.0002", payTo: PAY_TO, paymentId: "pay_1" }] },
        accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.0002, payTo: PAY_TO, paymentId: "pay_1", expiresAt: Math.floor(Date.now() / 1000) + 600,
          extra: { name: "USD Coin", version: "2", chainId: 8453, tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenDecimals: 6 } }],
      }));
    }
    if (h["x-payment"]) {
      const payload = JSON.parse(Buffer.from(h["x-payment"], "base64").toString("utf8"));
      seen.payments.push(payload);
      res.writeHead(200, { "Content-Type": "application/json", "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "base" })).toString("base64") });
      return res.end(JSON.stringify({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "paid ok" }, finish_reason: "stop" }], usage: { total_tokens: 5 } }));
    }
    res.writeHead(401); res.end("{}");
  });
});
await new Promise((r) => nano.listen(0, "127.0.0.1", r));
process.env.NANOGPT_X402_BASE = `http://127.0.0.1:${nano.address().port}`;

const { createControlRoom } = await import("../src/server.mjs");
const eco = await import("../src/economy.mjs");
const store = await import("../src/store.mjs");
const { USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES } = await import("../src/chain.mjs");
const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => { room.close(); nano.close(); });

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let token, session;

test("a wallet-mode token gets its own treasury wallet and refuses simulated deposits", async () => {
  const t = (await api("POST", "/api/control/tokens", { name: "Real", symbol: "REAL", treasuryMode: "wallet" })).json;
  token = t.address;
  assert.match(t.treasury.wallet, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(t.treasury.wallet.toLowerCase(), t.agent.wallet.toLowerCase());
  assert.equal(t.budget.status, "exhausted", "no money yet");
  assert.equal((await api("POST", `/api/control/tokens/${token}/deposit`, { usd: 5 })).status, 400);
});

test("with no Base USDC the AI request is refused before anything is signed", async () => {
  // pretend the chain said: some USDG, no USDC — enough to deploy, not enough for AI
  const t = eco.tokenOf(token); t.treasury.usdgMicros = 3_000_000; t.treasury.usdcMicros = 0; t.treasury.micros = 3_000_000; store.save();
  const d = await api("POST", `/api/control/tokens/${token}/deploy`, { mode: "sim", provider: "nanogpt-x402" });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const { issueBootCode } = await import("../src/auth.mjs");
  const code = issueBootCode(eco.tokenOf(token), {}); store.save();
  session = (await api("POST", "/api/vps/register", { token, code, host: {} })).json.session;
  const r = await api("POST", `/api/site/agent/${token}/svc/ai/v1/chat/completions`, { messages: [{ role: "user", content: "hi" }] }, { Authorization: `Bearer ${session}` });
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(seen.payments.length, 0);
});

test("with Base USDC the request is quoted, signed for exactly the quote and replayed", async () => {
  const t = eco.tokenOf(token); t.treasury.usdcMicros = 500_000; t.treasury.micros = 3_500_000; store.save();
  const r = await api("POST", `/api/site/agent/${token}/svc/ai/v1/chat/completions`, { messages: [{ role: "user", content: "hi" }] }, { Authorization: `Bearer ${session}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.choices[0].message.content, "paid ok");
  assert.equal(seen.payments.length, 1);
  const p = seen.payments[0];
  assert.equal(p.scheme, "exact"); assert.equal(p.network, "base");
  const a = p.payload.authorization;
  assert.equal(a.to, PAY_TO); assert.equal(a.value, "1000");
  assert.equal(a.from.toLowerCase(), t.treasury.wallet.toLowerCase());
  const signer = ethers.verifyTypedData(USDC_DOMAIN, TRANSFER_WITH_AUTH_TYPES, { ...a, value: BigInt(a.value), validAfter: 0n, validBefore: BigInt(a.validBefore) }, p.payload.signature);
  assert.equal(signer.toLowerCase(), t.treasury.wallet.toLowerCase(), "the authorization is signed by the treasury");
  const page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.treasury.usdcUsd, 0.499, "the quoted amount left the cached balance");
  assert.ok(page.treasuryLedger[0].reason.includes("nanogpt x402"));
});
