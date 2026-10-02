// The launch plan and its lock: the threshold slides between the min and max settings
// with how expensive the chosen model and machine are; the token starts by itself when
// the treasury reaches it, locks again when the VPS stops for lack of money, and a
// manual stop pauses the automatic start until it is resumed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-plan-"));
process.env.VAST_API_KEY = "";          // sample stock: 900001 $0.052, 900002 $0.071, 900003 $0.039
process.env.GATEWAY_OFFLINE = "1";      // fallback model catalog: DeepSeek V4 Pro cheapest, Claude Fable 5.1 dearest

const { createControlRoom } = await import("../src/server.mjs");
const eco = await import("../src/economy.mjs");
const store = await import("../src/store.mjs");
const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => room.close());
const api = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => null) }; };

let token;
test("the stock lists every machine and the threshold prices the plan between min and max", async () => {
  const inv = (await api("GET", "/api/control/vast/inventory")).json;
  assert.equal(inv.count, 3); assert.equal(inv.offers[0].dph, 0.039, "cheapest first");
  token = (await api("POST", "/api/control/tokens", { name: "Plan", symbol: "PLN", treasuryUsd: 10 })).json.address;
  const cheap = (await api("POST", `/api/control/tokens/${token}/plan`, { model: "deepseek/deepseek-v4-pro", offerId: 900003 })).json;
  assert.equal(cheap.activationUsd, 75, "cheapest model + cheapest machine = the floor");
  assert.equal(cheap.state, "locked");
  const dear = (await api("POST", `/api/control/tokens/${token}/plan`, { model: "anthropic/claude-fable-5.1", offerId: 900002 })).json;
  assert.equal(dear.activationUsd, 100, "dearest model + dearest machine = the ceiling");
  const mid = (await api("POST", `/api/control/tokens/${token}/plan`, { model: "anthropic/claude-fable-5.1", offerId: 900003 })).json;
  assert.equal(mid.activationUsd, 88, "dearest model, cheapest machine = halfway");
  assert.equal((await api("POST", `/api/control/tokens/${token}/plan`, { model: "anthropic/claude-fable-5.1", offerId: 123 })).status, 409, "a machine not in stock is refused");
  assert.equal((await api("POST", `/api/control/tokens/${token}/plan`, { model: "nope/model", offerId: 900003 })).status, 400);
});

test("nothing starts below the threshold; at the threshold the VPS and agent start by themselves", async () => {
  await api("POST", `/api/control/tokens/${token}/plan`, { model: "deepseek/deepseek-v4-pro", offerId: 900003 });
  let r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, []); assert.equal(r.lock.state, "locked"); assert.equal(r.lock.missingUsd, 65);
  await api("POST", `/api/control/tokens/${token}/deposit`, { usd: 64.99 });
  r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, [], "one cent short stays locked");
  await api("POST", `/api/control/tokens/${token}/deposit`, { usd: 0.01 });
  r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, [token]); assert.equal(r.lock.state, "unlocked");
  const t = eco.tokenOf(token);
  assert.equal(t.vps.state, "running"); assert.equal(t.vps.mode, "sim"); assert.equal(t.vps.offer.id, 900003);
  assert.equal(t.agent.ai.model, "deepseek/deepseek-v4-pro");
  const page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.lock.state, "unlocked"); assert.equal(page.plan.activationUsd, 75);
});

test("when the money runs out the VPS stops and the token locks again until the threshold", async () => {
  const t = eco.tokenOf(token);
  t.treasury.micros = 0; eco.stopVps(t, "treasury empty"); store.save();
  let r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.equal(r.lock.state, "locked"); assert.deepEqual(r.started, []);
  await api("POST", `/api/control/tokens/${token}/deposit`, { usd: 20 });
  r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, [], "$20 is not $75");
  await api("POST", `/api/control/tokens/${token}/deposit`, { usd: 60 });
  r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, [token]); assert.equal(eco.tokenOf(token).vps.state, "running");
});

test("a manual stop pauses the automatic start; resume re-arms it", async () => {
  await api("POST", `/api/control/tokens/${token}/vps/stop`);
  let r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.equal(r.lock.state, "paused"); assert.deepEqual(r.started, []);
  assert.equal(eco.tokenOf(token).vps.state, "stopped");
  await api("POST", `/api/control/tokens/${token}/plan/resume`);
  r = (await api("POST", `/api/control/tokens/${token}/plan/check`)).json;
  assert.deepEqual(r.started, [token], "the treasury is still above the threshold");
});

test("a specific wallet can be added as a demo holder, and spend/runway figures are reported", async () => {
  const addr = "0x000000000000000000000000000000000000dEaD";
  const r = (await api("POST", `/api/control/tokens/${token}/holders/add`, { address: addr, sharePct: 2 })).json;
  assert.equal(r.holder, addr.toLowerCase());
  const page = (await api("GET", `/api/site/token/${token}`)).json;
  const h = page.holders.find((x) => x.address === addr.toLowerCase());
  assert.ok(h && h.balance === 20_000_000, "holds 2% of the total supply (moved off the curve)");
  const sp = page.spend;
  assert.ok(sp.total.vpsUsd >= 0 && sp.treasuryUsd > 0);
  assert.ok(sp.remaining.vpsHours > 0, "hours the treasury still buys on the plan's machine");
  assert.ok(sp.remaining.aiTokensM > 0 && sp.perMillionTokensUsd > 0, "tokens the treasury still buys on the plan's model");
});
