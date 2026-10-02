// The real-VPS contract without vast.ai: a boot code is issued, the (fake) machine
// downloads its bootstrap, redeems the code for a session, drives the agent API with
// that session, and MediaMTX asks the gateway who may publish.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-vps-"));
process.env.VAST_API_KEY = "";
process.env.GATEWAY_OFFLINE = "1";
process.env.GATEWAY_PUBLIC_URL = "";
const { createControlRoom } = await import("../src/server.mjs");
const { issueBootCode } = await import("../src/auth.mjs");
const eco = await import("../src/economy.mjs");
const store = await import("../src/store.mjs");

const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => room.close());

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, json: ct.includes("json") ? await res.json() : null, text: ct.includes("json") ? null : await res.text() };
};

let token, code, session, streamKey;

test("deploy (sim) records the chosen AI and a boot code opens the bootstrap once", async () => {
  const t = (await api("POST", "/api/control/tokens", { name: "Boot Test", symbol: "BOOT", treasuryUsd: 20, volumeUsdPerHour: 500 })).json;
  token = t.address;
  const d = await api("POST", `/api/control/tokens/${token}/deploy`, { mode: "sim", provider: "nanogpt-x402", model: "anthropic/claude-haiku-4.5" });
  assert.equal(d.status, 200);
  assert.equal(d.json.vps.phase, "ready");
  code = issueBootCode(eco.tokenOf(token), { instanceId: 1 });
  store.save();
  const script = await api("GET", `/boot/${token}/${code}`);
  assert.equal(script.status, 200);
  assert.match(script.text, new RegExp(`TOKEN="${token.toLowerCase()}"`));
  assert.match(script.text, /api\/vps\/register/);
  assert.ok(!script.text.includes("privateKey"));
  const bad = await api("GET", `/boot/${token}/${"0".repeat(48)}`);
  assert.equal(bad.status, 403);
  const py = await api("GET", "/boot/agent.py");
  assert.match(py.text, /GATEWAY AGENT/);
});

test("registering redeems the code exactly once and hands out a session + stream key", async () => {
  const r = await api("POST", "/api/vps/register", { token, code, host: { hostname: "fake-vps", gpu: "RTX 5070 Ti" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ({ session, streamKey } = r.json);
  assert.match(session, /^[0-9a-f]{64}$/);
  assert.equal(r.json.config.token, token);
  assert.match(r.json.prompt, /Gateway Autonomous Agent System Prompt/);
  assert.ok(!r.json.prompt.includes("{{TOKEN_ADDRESS}}"), "placeholders are filled");
  const again = await api("POST", "/api/vps/register", { token, code, host: {} });
  assert.equal(again.status, 403, "a boot code is single-use");
  const page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.vps.phase, "ready");
  assert.equal(page.vps.host.hostname, "fake-vps");
});

test("the session drives the agent API and the AI proxy; a wrong session does not", async () => {
  const auth = { Authorization: `Bearer ${session}` };
  const hb = await api("POST", `/api/site/agent/${token}/heartbeat`, { state: "working", currentProposalId: null }, auth);
  assert.equal(hb.status, 200, JSON.stringify(hb.json));
  const bad = await api("POST", `/api/site/agent/${token}/heartbeat`, { state: "working", currentProposalId: null }, { Authorization: `Bearer ${"f".repeat(64)}` });
  assert.ok([400, 401].includes(bad.status));
  const ai = await api("POST", `/api/site/agent/${token}/svc/ai/v1/chat/completions`, { messages: [{ role: "user", content: "MISSION_STEP: say hi" }] }, auth);
  assert.equal(ai.status, 200, JSON.stringify(ai.json));
  assert.match(ai.json.choices[0].message.content, /Mission step/);
  const noAuth = await api("POST", `/api/site/agent/${token}/svc/ai/v1/chat/completions`, { messages: [] });
  assert.equal(noAuth.status, 401);
  const log = await api("POST", `/api/site/agent/${token}/status-log`, { level: "info", event: "boot", message: "hello from the vps", proposalId: null }, { ...auth, "Idempotency-Key": "k1" });
  assert.equal(log.status, 200);
  const page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.agent.state, "working");
  assert.ok(page.statusLog.some((l) => l.message === "hello from the vps"));
});

test("MediaMTX publish needs the stream key; ready/notready flips the live flag", async () => {
  const path = `live/${token.toLowerCase()}`;
  const wrong = await api("POST", "/api/mediamtx/auth", { action: "publish", path, user: "agent", password: "nope" });
  assert.equal(wrong.status, 401);
  const right = await api("POST", "/api/mediamtx/auth", { action: "publish", path, user: "agent", password: streamKey });
  assert.equal(right.status, 200);
  const read = await api("POST", "/api/mediamtx/auth", { action: "read", path });
  assert.equal(read.status, 200);
  await api("POST", "/api/mediamtx/event", { path, event: "ready" });
  let page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.vps.streamLive, true);
  assert.equal(page.vps.phase, "live");
  await api("POST", "/api/mediamtx/event", { path, event: "notready" });
  page = (await api("GET", `/api/site/token/${token}`)).json;
  assert.equal(page.vps.streamLive, false);
});

test("the public live page is served without login; the dashboard is not when a password is set", async () => {
  const pub = await api("GET", `/t/${token}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /hls\.min\.js/);
  process.env.GATEWAY_ADMIN_PASSWORD = "secret-pw";
  const locked = await api("GET", "/api/control/state");
  assert.equal(locked.status, 401);
  const open = await api("GET", "/api/control/state", null, { Authorization: `Basic ${Buffer.from("admin:secret-pw").toString("base64")}` });
  assert.equal(open.status, 200);
  const stillPublic = await api("GET", `/api/site/token/${token}`);
  assert.equal(stillPublic.status, 200);
  delete process.env.GATEWAY_ADMIN_PASSWORD;
});
