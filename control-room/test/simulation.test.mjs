// End-to-end simulation: launch a token, holders buy, message, propose and vote; the
// agent executes approved work through the site API and the local VPS services; the
// rules, signatures, quotas and budget limits all hold.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-cr-"));
process.env.VAST_API_KEY = "";
const { createControlRoom } = await import("../src/server.mjs");
const { ethers } = await import("ethers");
const { canonicalize } = await import("../src/canonical.mjs");

const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => room.close());

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return { status: res.status, json };
}
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.json)}`); return r.json; };

let token, holders, offer;

test("wallet is created once and keys never appear in any API response", async () => {
  const a = await ok("POST", "/api/control/wallet/create");
  const b = await ok("POST", "/api/control/wallet/create");
  assert.equal(a.address, b.address);
  const state = await ok("GET", "/api/control/state");
  assert.ok(!JSON.stringify(state).match(/privateKey|mnemonic|0x[0-9a-f]{64}(?![0-9a-f])/i) || !JSON.stringify(state).includes("privateKey"));
  assert.ok(!JSON.stringify(state).includes("privateKey"));
});

test("launch a token, add holders, start a simulated VPS", async () => {
  const t = await ok("POST", "/api/control/tokens", { name: "Tao Agent", symbol: "TAO", domain: "taoagent.xyz", treasuryUsd: 20, volumeUsdPerHour: 1000 });
  token = t.address;
  await ok("POST", `/api/control/tokens/${token}/holders`, { count: 6 });
  const page = await ok("GET", `/api/site/token/${token}`);
  holders = page.holders.map((h) => h.address);
  assert.equal(holders.length, 6);
  offer = (await ok("POST", "/api/control/vast/search", { ramGb: 32, maxDph: 0.2 })).offers[0];
  assert.ok(offer.simulated);
  await ok("POST", `/api/control/tokens/${token}/vps/start`, { mode: "sim", offer });
  const r = await api("POST", `/api/control/tokens/${token}/deploy`, { mode: "real", offer, confirm: "nope" });
  assert.equal(r.status, 400, "a real rental needs the typed confirmation");
});

test("agent boots, heartbeats and posts the fixed status note", async () => {
  const c = await ok("POST", `/api/control/tokens/${token}/agent/cycle`);
  assert.equal(c.error, undefined, JSON.stringify(c));
  const page = await ok("GET", `/api/site/token/${token}`);
  assert.ok(page.agent.lastHeartbeatAt);
  assert.ok(page.casts.some((x) => x.mode === "automatic_status" && x.text.startsWith("🔴 Live: starting up")));
});

test("every holder can write, big holders give orders, non-holders and spammers are refused", async () => {
  const t = await ok("GET", `/api/site/token/${token}`);
  const holders = t.holders.map((h) => h.address);
  const first = await ok("POST", `/api/control/tokens/${token}/act/message`, { holder: holders[0], text: "Hello agent, what are you working on?" });
  assert.equal(first.accepted, true);
  assert.ok(["order", "chat"].includes(first.message.role), "the message carries the holder's standing");
  assert.equal(first.role.role, t.holders.find((h) => h.address === holders[0]).sharePct >= t.orderMinPct ? "order" : "chat");
  const again = await api("POST", `/api/control/tokens/${token}/act/message`, { holder: holders[0], text: "again" });
  assert.equal(again.status, 429, "messages are rate-limited per wallet");
  const smallest = t.holders.slice().sort((a, b) => a.sharePct - b.sharePct)[0];
  const small = await ok("POST", `/api/control/tokens/${token}/act/message`, { holder: smallest.address, text: "small holder here" });
  assert.equal(small.message.role, smallest.sharePct >= t.orderMinPct ? "order" : "chat", "role follows the share against the order threshold");
  assert.equal(small.message.sharePct, Number(smallest.sharePct.toFixed(3)));
  await ok("POST", `/api/control/tokens/${token}/agent/cycle`);
  const after = await ok("GET", `/api/site/token/${token}`);
  const replied = after.messages.find((m) => m.id === first.message.id);
  assert.ok(replied?.reply?.text, "the agent answered");
  assert.ok(after.messages.at(-1).role);
});

test("forged or replayed agent envelopes are refused", async () => {
  const fake = ethers.Wallet.createRandom();
  const payload = { schemaVersion: 1, type: "heartbeat", tokenAddress: token, agentWalletAddress: fake.address, timestamp: new Date().toISOString(), nonce: ethers.hexlify(ethers.randomBytes(16)), state: "idle", currentProposalId: null };
  const forged = await api("POST", `/api/site/agent/${token}/heartbeat`, { payload, signature: await fake.signMessage(canonicalize(payload)) });
  assert.ok([400, 401].includes(forged.status), `forged heartbeat refused (${forged.status})`);

  const page = await ok("GET", `/api/site/token/${token}`);
  const real = { ...payload, agentWalletAddress: page.agent.wallet };
  const sig = await ok("POST", `/local/${token}/signer/sign-message`, { type: "heartbeat", payload: real });
  await ok("POST", `/api/site/agent/${token}/heartbeat`, { payload: real, signature: sig.signature });
  const replay = await api("POST", `/api/site/agent/${token}/heartbeat`, { payload: real, signature: sig.signature });
  assert.equal(replay.status, 409, "a nonce is single-use");

  const refused = await api("POST", `/local/${token}/signer/sign-message`, { type: "transaction", payload: { ...real, type: "transaction" } });
  assert.equal(refused.status, 403, "the signer signs only the allowed message types");
  const extra = await api("POST", `/local/${token}/signer/sign-message`, { type: "heartbeat", payload: { ...real, nonce: ethers.hexlify(ethers.randomBytes(16)), to: "0xdead" } });
  assert.equal(extra.status, 403, "the signer refuses unauthorized fields");
});

test("an approved Farcaster post is cast verbatim; an unapproved cast is refused", async () => {
  const p = (await ok("POST", `/api/control/tokens/${token}/act/proposal`, { holder: holders[0], type: "FARCASTER_POST", title: "Say hi", payload: { text: "Hello Farcaster — the TAO AI agent is live." } })).proposal;
  const direct = await api("POST", `/local/${token}/farcaster/cast`, { tokenAddress: token, proposalId: p.id, mode: "approved", text: p.payload.text, imageUrl: null });
  assert.equal(direct.status, 403, "not approved yet");
  for (const h of holders) await ok("POST", `/api/control/tokens/${token}/act/vote`, { holder: h, proposalId: p.id, support: true });
  await ok("POST", "/api/control/tick", { hours: 7 });
  await ok("POST", `/api/control/tokens/${token}/agent/cycle`);
  const page = await ok("GET", `/api/site/token/${token}`);
  const prop = page.proposals.find((x) => x.id === p.id);
  assert.equal(prop.status, "approved");
  assert.equal(prop.agentStatus, "done");
  assert.ok(page.casts.some((c) => c.mode === "approved" && c.text === p.payload.text));
});

test("an approved but rule-breaking proposal is rejected_by_rules and nothing is published", async () => {
  const p = (await ok("POST", `/api/control/tokens/${token}/act/proposal`, { holder: holders[0], type: "FARCASTER_POST", title: "Shill", payload: { text: "Guaranteed returns, 100x incoming — send funds now" } })).proposal;
  for (const h of holders) await ok("POST", `/api/control/tokens/${token}/act/vote`, { holder: h, proposalId: p.id, support: true });
  await ok("POST", `/api/control/tokens/${token}/finalize`);
  await ok("POST", `/api/control/tokens/${token}/agent/cycle`);
  const page = await ok("GET", `/api/site/token/${token}`);
  const prop = page.proposals.find((x) => x.id === p.id);
  assert.equal(prop.agentStatus, "rejected_by_rules");
  assert.ok(!page.casts.some((c) => c.text.includes("100x")));
});

test("website updates need an approved proposal and keep the AI disclosure", async () => {
  const p = (await ok("POST", `/api/control/tokens/${token}/act/proposal`, { holder: holders[0], type: "WEBSITE_UPDATE", title: "About page", payload: { description: "About section", content: "TAO — a community project operated by an AI agent. Roadmap coming soon." } })).proposal;
  for (const h of holders) await ok("POST", `/api/control/tokens/${token}/act/vote`, { holder: h, proposalId: p.id, support: true });
  await ok("POST", `/api/control/tokens/${token}/finalize`);
  await ok("POST", `/api/control/tokens/${token}/agent/cycle`);
  const page = await ok("GET", `/api/site/token/${token}`);
  assert.equal(page.website.content, p.payload.content);
  assert.equal(page.website.version, 1);
});

test("the treasury pays the VPS by the hour; when it empties the VPS stops and the agent pauses", async () => {
  await ok("POST", `/api/control/tokens/${token}/volume`, { usdPerHour: 0 });
  const before = (await ok("GET", `/api/site/token/${token}`)).budget.remainingUsd;
  await ok("POST", "/api/control/tick", { hours: 2 });
  const after = (await ok("GET", `/api/site/token/${token}`)).budget.remainingUsd;
  assert.ok(Math.abs((before - after) - 2 * offer.dph) < 1e-6, `2 VPS hours charged (${before} → ${after})`);
  let page;
  for (let i = 0; i < 12; i++) {
    await ok("POST", "/api/control/tick", { hours: 24 * 30 });
    page = await ok("GET", `/api/site/token/${token}`);
    if (page.vps.state === "stopped") break;
  }
  assert.equal(page.vps.state, "stopped");
  assert.equal(page.budget.status, "exhausted");
  const ai = await api("POST", `/local/${token}/ai/v1/chat/completions`, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(ai.status, 503, "no services once the VPS is stopped");
});
