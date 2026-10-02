// Launching on Pons against a stand-in Robinhood RPC: the site encodes launchAndBuy
// with the treasury as creator-tax recipient, the creator's wallet "sends" it, the
// receipt is read back and verified (router, sender, TokenLaunched, tax recipient),
// the channel is bound to the real token, and the market indexer turns Transfer and
// CurveBuy logs into holders, trades and candles.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";

process.env.CONTROL_ROOM_DATA_DIR = mkdtempSync(join(tmpdir(), "gateway-pons-"));
process.env.VAST_API_KEY = "";
process.env.GATEWAY_OFFLINE = "1";

const { ROUTER, FACTORY, ROUTER_IFACE, FACTORY_IFACE, CURVE_IFACE, TOKEN_IFACE } = await import("../src/pons.mjs");
const creator = ethers.Wallet.createRandom();
const TOKEN = "0x61752da5a4c354ec73646fa2135930a2e59ef94c", CURVE = "0xd8e46c5208b8473af60b3b8df2071d99ac0e8b87";
const TX = "0x" + "ab".repeat(32);
const chain = { treasury: null, taxBps: 200, head: 100, launchBlock: 90, sent: null };
const hex = (n) => "0x" + BigInt(n).toString(16);
const ERC = (fn, args) => ({ topics: null });
function transferLog(from, to, value, block, idx) {
  const { data, topics } = TOKEN_IFACE.encodeEventLog("Transfer", [from, to, value]);
  return { address: TOKEN, topics, data, blockNumber: hex(block), transactionHash: TX, logIndex: hex(idx), blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", removed: false };
}
function buyLog(buyer, recipient, quoteIn, tokensOut, fee, tax, block, idx) {
  const { data, topics } = CURVE_IFACE.encodeEventLog("CurveBuy", [buyer, recipient, quoteIn, tokensOut, fee, tax]);
  return { address: CURVE, topics, data, blockNumber: hex(block), transactionHash: TX, logIndex: hex(idx), blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", removed: false };
}
const E = ethers.parseEther;
const LOGS = () => [
  transferLog(ethers.ZeroAddress, CURVE, E("1000000000"), chain.launchBlock, 0),
  { ...(() => { const { data, topics } = FACTORY_IFACE.encodeEventLog("TokenLaunched", [TOKEN, CURVE, creator.address, ethers.ZeroAddress, 0, E("4.2")]); return { address: FACTORY, topics, data }; })(), blockNumber: hex(chain.launchBlock), transactionHash: TX, logIndex: "0x1", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", removed: false },
  transferLog(CURVE, creator.address, E("5740664"), chain.launchBlock, 2),
  buyLog(ROUTER, creator.address, E("0.01"), E("5740664"), E("0.0001"), E("0.0002"), chain.launchBlock, 3),
];
const rpc = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result })); };
    if (method === "eth_chainId") return reply("0x1237");
    if (method === "eth_blockNumber") return reply(hex(chain.head));
    if (method === "eth_getTransactionByHash") return reply(chain.sent ? { hash: TX, from: creator.address, to: ROUTER, value: hex(E("0.0105")), input: chain.sent.data, nonce: "0x0", gas: "0x1", gasPrice: "0x1", blockNumber: hex(chain.launchBlock), blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", chainId: "0x1237", type: "0x0", v: "0x0", r: "0x1", s: "0x1" } : null);
    if (method === "eth_getTransactionReceipt") return reply(chain.sent ? { transactionHash: TX, status: "0x1", from: creator.address, to: ROUTER, blockNumber: hex(chain.launchBlock), blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", cumulativeGasUsed: "0x1", gasUsed: "0x1", logs: LOGS(), logsBloom: "0x" + "00".repeat(256), type: "0x0", contractAddress: null, effectiveGasPrice: "0x1" } : null);
    if (method === "eth_getLogs") { const f = params[0]; const from = Number(f.fromBlock), to = Number(f.toBlock); return reply(LOGS().filter((l) => l.address.toLowerCase() === String(f.address).toLowerCase() && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && (!f.topics?.[0] || [].concat(f.topics[0]).includes(l.topics[0])))); }
    if (method === "eth_getBlockByNumber") return reply({ number: params[0], hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: hex(1_789_456_000 + Number(params[0]) * 2), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", transactions: [], baseFeePerGas: "0x1" });
    if (method === "eth_call") {
      const { to, data } = params[0];
      const sel = data.slice(0, 10);
      if (to.toLowerCase() === FACTORY) {
        if (sel === FACTORY_IFACE.getFunction("launchFee").selector) return reply(FACTORY_IFACE.encodeFunctionResult("launchFee", [E("0.0005")]));
        if (sel === FACTORY_IFACE.getFunction("launchEnabled").selector) return reply(FACTORY_IFACE.encodeFunctionResult("launchEnabled", [true]));
        if (sel === FACTORY_IFACE.getFunction("previewLaunchEconomics").selector) return reply(FACTORY_IFACE.encodeFunctionResult("previewLaunchEconomics", ["0x" + "a9".repeat(32)]));
        if (sel === FACTORY_IFACE.getFunction("getLaunchedToken").selector) return reply(FACTORY_IFACE.encodeFunctionResult("getLaunchedToken", [[TOKEN, CURVE, creator.address, chain.treasury || creator.address, ethers.ZeroAddress, E("4.2"), 0, 0, chain.taxBps, false, 0, 0, 0, 0, true]]));
      }
      if (to.toLowerCase() === CURVE) {
        if (sel === CURVE_IFACE.getFunction("getReserves").selector) return reply(CURVE_IFACE.encodeFunctionResult("getReserves", [E("1.51"), E("994259336")]));
        if (sel === CURVE_IFACE.getFunction("graduated").selector) return reply(CURVE_IFACE.encodeFunctionResult("graduated", [false]));
      }
      if (to.toLowerCase() === TOKEN && sel === TOKEN_IFACE.getFunction("totalSupply").selector) return reply(TOKEN_IFACE.encodeFunctionResult("totalSupply", [E("1000000000")]));
      if (to.toLowerCase() === TOKEN && sel === TOKEN_IFACE.getFunction("balanceOf").selector) { const who = TOKEN_IFACE.decodeFunctionData("balanceOf", data)[0].toLowerCase(); return reply(TOKEN_IFACE.encodeFunctionResult("balanceOf", [who === creator.address.toLowerCase() ? E("5740664") : 0n])); }
      return reply("0x");
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no mock for ${method}` } }));
  });
});
await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
process.env.ROBINHOOD_RPC = `http://127.0.0.1:${rpc.address().port}`;

const { createControlRoom } = await import("../src/server.mjs");
const room = createControlRoom({ port: 0 });
const base = await room.listen();
test.after(() => { room.close(); rpc.close(); });
const api = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => null) }; };

let prep;
test("prepare encodes launchAndBuy with the new treasury as creator-tax recipient and the first buy in value", async () => {
  const info = (await api("GET", "/api/site/launch/info")).json;
  assert.equal(info.launchFeeEth, "0.0005"); assert.equal(info.enabled, true);
  const r = await api("POST", "/api/site/launch/prepare", { creator: creator.address, name: "Ponstream", symbol: "stream", description: "Launch via Gateway.", website: "https://ponstream.live/", model: "anthropic/claude-sonnet-5", offerId: 900003, creatorTaxBps: 200, firstBuyEth: 0.01 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  prep = r.json; chain.treasury = prep.treasury;
  assert.equal(prep.tx.to.toLowerCase(), ROUTER); assert.equal(prep.tx.chainId, 4663);
  assert.equal(ethers.formatEther(prep.tx.value), "0.0105", "launch fee + first buy");
  const d = ROUTER_IFACE.decodeFunctionData("launchAndBuy", prep.tx.data);
  assert.equal(d.params.name, "Ponstream"); assert.equal(d.params.symbol, "STREAM");
  assert.equal(d.params.creatorFeeRecipient.toLowerCase(), prep.treasury.toLowerCase(), "creator tax flows to the treasury");
  assert.equal(Number(d.params.creatorTaxBps), 200); assert.equal(d.params.expectedEconomics, "0x" + "a9".repeat(32));
  assert.equal(d.pairToken, ethers.ZeroAddress); assert.equal(ethers.formatEther(d.quoteIn), "0.01"); assert.equal(d.minTokensOut, 0n); assert.equal(d.recipient.toLowerCase(), creator.address.toLowerCase());
  assert.equal(prep.plan.activationUsd > 0, true);
});

test("confirm waits while pending, then binds the channel to the mined token and indexes the market", async () => {
  let r = await api("POST", "/api/site/launch/confirm", { id: prep.id, txHash: TX });
  assert.equal(r.json.status, "pending");
  chain.sent = prep.tx;
  r = await api("POST", "/api/site/launch/confirm", { id: prep.id, txHash: TX });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.status, "done");
  const ch = r.json.channel;
  assert.equal(ch.address.toLowerCase(), TOKEN, "the channel IS the on-chain token");
  assert.equal(ch.treasury.wallet.toLowerCase(), prep.treasury.toLowerCase());
  assert.equal(ch.lock.state, "locked"); assert.equal(ch.onchain.curve, CURVE); assert.equal(ch.onchain.creatorTaxBps, 200);
  const page = (await api("GET", `/api/site/token/${TOKEN}`)).json;
  assert.equal(page.holders.length, 1, "the creator's first buy is the only holder (the curve is excluded)");
  assert.equal(page.holders[0].address, creator.address.toLowerCase());
  const m = page.market;
  assert.equal(m.tradeCount, 1); assert.equal(m.trades[0].side, "buy"); assert.equal(m.trades[0].quoteEth, 0.01);
  assert.ok(m.priceEth > 0 && m.mcapEth > 0 && m.candles["1m"].length === 1, "price from reserves, one candle from the first buy");
  assert.equal(m.creatorTaxEarnedEth, 0.0002);
  assert.equal(page.plan.modelName, "Claude Sonnet 5");
  // idempotent
  r = await api("POST", "/api/site/launch/confirm", { id: prep.id, txHash: TX });
  assert.equal(r.json.status, "done"); assert.equal(r.json.channel.address.toLowerCase(), TOKEN);
});

test("usernames, on-chain balance gating and order roles", async () => {
  const { canonicalize } = await import("../src/canonical.mjs");
  const envelope = async (signer, type, fields) => { const payload = { schemaVersion: 1, type, tokenAddress: TOKEN, holder: signer.address.toLowerCase(), timestamp: new Date().toISOString(), nonce: ethers.hexlify(ethers.randomBytes(16)), ...fields }; return { payload, signature: await signer.signMessage(canonicalize(payload)) }; };
  let r = await api("POST", `/api/site/holder/${TOKEN}/username`, await envelope(creator, "holder_username", { username: "hoodoge_dev" }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await api("POST", `/api/site/holder/${TOKEN}/message`, await envelope(creator, "holder_message", { text: "post about the launch" }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.message.role, "order", "the creator holds all of the eligible supply → orders");
  assert.equal(r.json.message.username, "hoodoge_dev");
  const nobody = ethers.Wallet.createRandom();
  r = await api("POST", `/api/site/holder/${TOKEN}/message`, await envelope(nobody, "holder_message", { text: "hi" }));
  assert.equal(r.status, 403, "the chain says this wallet holds nothing");
  const page = (await api("GET", `/api/site/token/${TOKEN}`)).json;
  assert.equal(page.holders[0].username, "hoodoge_dev"); assert.equal(page.holders[0].role, "order");
  assert.equal(page.profiles[creator.address.toLowerCase()], "hoodoge_dev");
});

test("a launch whose creator tax does not point at the treasury is refused", async () => {
  const other = ethers.Wallet.createRandom();
  const p = (await api("POST", "/api/site/launch/prepare", { creator: other.address, name: "Fake", symbol: "FAKE", model: "anthropic/claude-sonnet-5", offerId: 900003 })).json;
  chain.treasury = creator.address;   // the chain says the tax goes elsewhere
  const r = await api("POST", "/api/site/launch/confirm", { id: p.id, txHash: TX });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /another wallet|not its Gateway treasury/);
});
