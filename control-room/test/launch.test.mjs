// Public launching: a wallet signs a launch, the site creates the token with a real
// treasury wallet and a priced plan, the creator gets a demo stake, the channel is
// listed and locked; bad signatures, taken symbols and rapid relaunches are refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-launch-"));
process.env.VAST_API_KEY = "";
process.env.GATEWAY_OFFLINE = "1";

const { createControlRoom } = await import("../src/server.mjs");
const { canonicalize } = await import("../src/canonical.mjs");
const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => room.close());
const api = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => null) }; };
const creator = ethers.Wallet.createRandom();
const nonce = () => ethers.hexlify(ethers.randomBytes(16));
async function signedLaunch(fields, signer = creator) {
  const payload = { schemaVersion: 1, type: "launch", creator: signer.address.toLowerCase(), timestamp: new Date().toISOString(), nonce: nonce(), ...fields };
  return { payload, signature: await signer.signMessage(canonicalize(payload)) };
}

test("the public form has a catalog, a stock and a live quote", async () => {
  const m = (await api("GET", "/api/site/models")).json;
  assert.ok(m.models.length >= 5 && m.default);
  const inv = (await api("GET", "/api/site/inventory")).json;
  assert.equal(inv.count, 3);
  const q = (await api("POST", "/api/site/launch/quote", { model: "anthropic/claude-fable-5.1", offerId: 900002 })).json;
  assert.equal(q.activationUsd, 100); assert.equal(q.unlockMinUsd, 75);
});

let launched;
test("a signed launch creates a locked channel with a treasury wallet and a creator stake", async () => {
  const r = await api("POST", "/api/site/launch", await signedLaunch({ name: "Hoodoge", symbol: "hoodoge", description: "A dog agent.", model: "deepseek/deepseek-v4-pro", offerId: 900003 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  launched = r.json;
  assert.equal(launched.symbol, "HOODOGE");
  assert.match(launched.treasury.wallet, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(launched.lock.state, "locked"); assert.equal(launched.lock.activationUsd, 75);
  assert.equal(launched.creator, creator.address.toLowerCase());
  assert.equal(launched.holders, 1, "the creator holds the demo stake");
  const list = (await api("GET", "/api/site/channels")).json.channels;
  assert.ok(list.some((c) => c.address === launched.address));
  const page = (await api("GET", `/api/site/token/${launched.address}`)).json;
  assert.equal(page.treasury.mode, "wallet"); assert.equal(page.plan.modelName, "DeepSeek V4 Pro");
  assert.ok(page.website.content.startsWith("A dog agent."));
});

test("the creator can talk to their own channel with a signed message once the treasury has money", async () => {
  // chat quota is a share of the treasury: an empty treasury means no chat at all
  const eco = await import("../src/economy.mjs");
  eco.tokenOf(launched.address).treasury.micros = 50_000_000;   // as if $50 had arrived on chain
  await api("POST", "/api/control/tick", { hours: 24 });          // next epoch opens the chat pool
  const payload = { schemaVersion: 1, type: "holder_message", tokenAddress: launched.address, holder: creator.address.toLowerCase(), timestamp: new Date().toISOString(), nonce: nonce(), text: "hello agent" };
  const r = await api("POST", `/api/site/holder/${launched.address}/message`, { payload, signature: await creator.signMessage(canonicalize(payload)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test("bad signatures, taken symbols, out-of-stock machines and rapid relaunches are refused", async () => {
  const other = ethers.Wallet.createRandom();
  const forged = await signedLaunch({ name: "Fake", symbol: "FAKE", model: "deepseek/deepseek-v4-pro", offerId: 900003 }, other);
  forged.payload.creator = creator.address.toLowerCase();
  assert.equal((await api("POST", "/api/site/launch", forged)).status, 401);
  assert.equal((await api("POST", "/api/site/launch", await signedLaunch({ name: "Again", symbol: "HOODOGE", model: "deepseek/deepseek-v4-pro", offerId: 900003 }, other))).status, 409, "symbol taken");
  assert.equal((await api("POST", "/api/site/launch", await signedLaunch({ name: "Gone", symbol: "GONE", model: "deepseek/deepseek-v4-pro", offerId: 123456 }, other))).status, 409, "machine not in stock");
  assert.equal((await api("POST", "/api/site/launch", await signedLaunch({ name: "Second", symbol: "SECOND", model: "deepseek/deepseek-v4-pro", offerId: 900003 }))).status, 429, "same wallet within 10 minutes");
  assert.equal((await api("GET", "/api/site/channels")).json.channels.length, 1, "nothing half-launched");
});
