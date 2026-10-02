// Gateway — control room + website API + VPS endpoints, one process behind nginx.
//   /                       public channels (no operator panel)
//   /api/control/*          direct-loopback operator CLI only (Basic auth)
//   /t/:token               public live page
//   /api/site/*             website API (agent: session or signed; holders: signed)
//   /local/:token/*         simulated VPS-local services  (simulation only)
//   /boot/:token/:code      VPS bootstrap script          (single-use code)
//   /boot/agent.py          the agent runner the VPS downloads
//   /api/vps/register       boot code → session + stream key
//   /api/mediamtx/*         stream auth + events from MediaMTX (loopback only)
import { createServer } from "node:http";
import { ethers } from "ethers";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { ROOT, DATA_DIR, env } from "./env.mjs";
import * as store from "./store.mjs";
import { nonce, nowIso } from "./canonical.mjs";
import { opsAddress, createOpsWallet, signAsHolder } from "./wallets.mjs";
import { balancesOf } from "./chain.mjs";
import { vastAccount, searchOffers, listInstances } from "./vast.mjs";
import * as eco from "./economy.mjs";
import { handleAgent, handleHolder, handleHolderChat, publicToken } from "./site-api.mjs";
import { publicText, publicTree, publicOffer, publicMarket, requireInertHtml } from "./public-safety.mjs";
import { handleLocal, cachedVoiceAudio } from "./local-services.mjs";
import { createPreviewChecker } from './preview-availability.mjs';
import { markLegacyProposalUsageForReview } from './usage-budget.mjs';
import { createAgentRunner } from "./agent-sim.mjs";
import { adminOk, peekBootCode, redeemBootCode, sessionOf, issueStreamKey, streamKeyOk, issueBootCode } from "./auth.mjs";
import { listProviders, listModels, listAgentModels, defaultModel, X402_ID } from "./providers.mjs";
import * as dep from "./deploy.mjs";
import { refreshTreasury, billRunning, fundTreasuryFromOps, opsBalances, opsBridge, ensureAiPocket, chargeTreasuryOnce } from "./billing.mjs";
import * as plan from "./plan.mjs";
import { inventory, gpuClasses } from "./inventory.mjs";
import { startViewerPoll } from "./viewers.mjs";
import { createXPosts, setXPosts } from "./x-posts.mjs";
import { needsAgentReply } from './chat-policy.mjs';
import { createDexPackageAdapter, createSocialPoolAdapter, dexSocketPath } from './package-adapters.mjs';
import { brokerSocketPath, brokerCall } from './x-posts.mjs';
import { createPumpFeeSponsorClient } from './pump-fee-sponsor-client.mjs';
import * as launchpad from "./launch.mjs";
import { adoptSolanaToken } from "./launch-solana.mjs";
import * as pumpLaunch from "./launch-pump.mjs";
import { mintPool } from "./pump-mints.mjs";
import { sweepAll as sweepCreatorFees } from "./pump-fees.mjs";
import { startMarketPoll, marketOf, verifyDueGovernance } from "./market.mjs";
import { createRealtime } from "./realtime.mjs";
import { COMPANION_ASSETS } from "./companion-assets.mjs";
import { BRAND_ASSETS } from "./brand-assets.mjs";
import { projectLogo } from './project-profile.mjs';
import {previewWalletAction} from './community-signer-runtime.mjs';
import { createLaunchPackageQueue } from './launch-package-queue.mjs';
import { createSocialAccountQueue } from './social-account-queue.mjs';
import { autonomContextBlock } from './autonom-context.mjs';
import { createProjectBannerPipeline, createBannerStorage } from './project-banner-runtime.mjs';

const MAX_BODY = 1_000_000;
const TYPES = { ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".glb": "model/gltf-binary", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".md": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".py": "text/x-python; charset=utf-8" };
const PROMPT_PATH = join(ROOT, "..", "agent", "AGENT_SYSTEM_PROMPT.md");

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const finish = (err, value) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      chunks = []; if (err) reject(err); else resolve(value);
    };
    const deadline = setTimeout(() => { finish(Object.assign(new Error("request body timed out"), { status: 408 })); req.destroy(); }, 10_000);
    deadline.unref?.();
    req.on("data", (c) => { if (settled) return; size += c.length; if (size > MAX_BODY) { finish(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (settled) return;
      if (!chunks.length) return finish(null, null);
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(Object.assign(new Error("invalid JSON"), { status: 400 })); }
    });
    req.on("error", (err) => finish(err));
    req.on("aborted", () => finish(Object.assign(new Error("request aborted"), { status: 400 })));
  });
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const isLoopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const isForwardedOrBrowser = (req) => ["forwarded", "x-forwarded-for", "x-real-ip", "origin", "sec-fetch-site"].some((key) => req.headers[key] != null);

/// Where the token trades, for the agent's facts: pump.fun for a pump launch, Jupiter for any other Solana mint, Pons on Robinhood.
const tradeUrlFor = (t) => t.onchain?.pumpUrl || (t.chain === "solana" ? `https://jup.ag/swap/SOL-${t.address}` : (t.onchain?.pons || "https://www.ponsfamily.com/launchpad/"));
/// The prompt with this token's boot values filled in. Unknown placeholders stay
/// visible so a misconfiguration is obvious rather than silent.
function promptFor(t) {
  const base = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, "utf8") : "";
  const s = store.get();
  const vals = {
    TOKEN_NAME: t.name, TOKEN_SYMBOL: t.symbol, TOKEN_ADDRESS: t.address, CHAIN_NAME: t.chain, CHAIN_ID: String(eco.chainIdOf?.(t.chain) ?? ""),
    AGENT_WALLET_ADDRESS: t.agent.wallet, DOMAIN: t.domain, FARCASTER_USERNAME: t.agent.farcaster.username, FARCASTER_FID: String(t.agent.farcaster.fid),
    SITE_API_BASE: `${dep.publicBase()}/api/site`, LOCAL_AI_PROXY: "http://127.0.0.1:7777/svc/ai", LOCAL_SIGNER_URL: "http://127.0.0.1:7777/signer", LOCAL_FARCASTER_URL: "http://127.0.0.1:7777/svc/farcaster",
    DEFAULT_MISSION: s.defaultMission || "Keep the project website accurate, read holder messages, and draft proposal ideas that help the community.",
    INBOX_POLL_MINUTES: "5", MAX_REPLIES_PER_CYCLE: String(s.settings.maxRepliesPerCycle), STATUS_NOTE_INTERVAL_HOURS: String(s.settings.statusNoteHours),
    LOOP_SLEEP_SECONDS: "60", TASK_SLICE_SECONDS: "600", MAX_ERROR_ATTEMPTS: "5", RETRY_BASE_SECONDS: "5", RETRY_MAX_SECONDS: "300", ERROR_COOLDOWN_SECONDS: "300",
    HTTP_TIMEOUT_SECONDS: "30", MAX_RESPONSE_BYTES: "1000000", MAX_REPLY_CHARACTERS: "1000", MAX_AI_OUTPUT_TOKENS: "600", LOW_BUDGET_AI_OUTPUT_TOKENS: "200", MAX_AI_CALLS_PER_TASK: "8",
    MAX_CPU_PERCENT: "80", MAX_RAM_MB: "8000", MAX_DISK_MB: "20000", MAX_LOG_BYTES: "5000000", LOG_RETENTION_FILES: "5",
    WORKSPACE_DIR: "/home/agent/work", STATE_DIR: "/home/agent", STATUS_LOG_PATH: "/home/agent/status.log", WEBSITE_ROOT: "/home/agent/work/site", WEB_SERVER_PORTS: "trusted static publisher on 127.0.0.1:8787; no agent-selected inbound ports",
    CURVE_ADDRESS: t.curveAddress || "—", TREASURY_ADDRESS: t.treasury.wallet || "—", CHANNEL_URL: `${dep.publicBase()}/t/${t.address}`, WEBSITE_URL: `${dep.publicBase()}/w/${eco.tokenKey(t.chain, t.address)}`,
    EXPLORER_URL: t.onchain?.explorer || `https://robin.etherscan.io/address/${t.address}`, PONS_URL: tradeUrlFor(t), AI_MODEL_NAME: t.agent.ai?.name || t.agent.ai?.model || "simulated", MACHINE: t.vps.offer?.gpu ? `${t.vps.offer.gpu} (${t.vps.offer.geo || ""})` : "a rented machine",
    AI_MODEL: t.agent.ai?.model || "simulated", AI_BIO_TEMPLATE: `${t.symbol} AI agent on Autonom. I am an AI. Governed by ${t.symbol} holders. https://${t.domain}`,
    PLATFORM_TERMS_REFERENCE: `${dep.publicBase()}/terms`, HOSTING_TERMS_REFERENCE: "https://vast.ai/terms", FARCASTER_TERMS_REFERENCE: "https://farcaster.xyz/terms",
  };
  return base.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vals ? vals[k] : m)) + "\n\n" + autonomContextBlock(t);
}

export function createControlRoom({ port = Number(env("PORT", "4747")), host = "127.0.0.1", previewChecker = createPreviewChecker(), bannerStorage = createBannerStorage(join(DATA_DIR, 'generated-banners')), launchPackageAdapter = undefined, socialAccountAdapter = undefined } = {}) {
  store.load();
  let deadlineMigrated = false;
  for (const t of Object.values(store.get().tokens)) {
    if (markLegacyProposalUsageForReview(t)) deadlineMigrated = true;
    if (eco.migrateProposalDeadlines(t)) deadlineMigrated = true;
    if (t.onchain && t.governanceVersion !== 2) { t.governanceVersion = 2; deadlineMigrated = true; }
  }
  if (deadlineMigrated) store.save();
  if (env("GATEWAY_PUBLIC_URL") && !env("GATEWAY_ADMIN_PASSWORD")) throw new Error("GATEWAY_ADMIN_PASSWORD must be set when GATEWAY_PUBLIC_URL is configured");
  let baseUrl = `http://${host}:${port}`;
  let runner = createAgentRunner({ baseUrl });
  const auto = { agents: false, clock: false, timer: null, clockTimer: null, busy: false };
  const directOffline = (req) => env("GATEWAY_OFFLINE") === "1" && isLoopback(req) && !isForwardedOrBrowser(req) && req.headers.host === new URL(baseUrl).host;
  const offlineLocal = (req, t) => t.vps.mode === "sim" && directOffline(req);
  const realtime = createRealtime({ snapshot: publicToken, subscribe: store.onChange,
    hasInbox: (token, cursor) => { const t=eco.tokenOf(token); return t.messages.some(m => m.seq > cursor && needsAgentReply(m) && !t.replies.some(r => r.messageId === m.id)); } });
  // Only trusted operator adapters can execute purchases. Public requests and
  // token metadata cannot supply adapters or provider credentials.
  const projectBanners = createProjectBannerPipeline({ tokens: () => Object.values(store.get().tokens), persist: store.saveDurable, storage: bannerStorage });
  // Root-broker adapters (DEX Screener purchase, X pool) are wired only in the
  // real runtime; tests and offline runs pass explicit adapters or null.
  const online = !env("GATEWAY_OFFLINE");
  const feeSponsor = online && existsSync(dexSocketPath()) ? createPumpFeeSponsorClient({
    feePayer: 'DCB8WtbjRJ1DWntBo9LbtniCbkiVT5aoYp4mWPmPhe54',
    call: (method, path, body) => brokerCall(method, path, body, { socketPath: dexSocketPath(), timeoutMs: 30_000 }),
  }) : null;
  // A missing broker socket means 'not connected' (the queue keeps waiting), never a
  // failing adapter that would park funded jobs in reconciliation_required.
  const dexAdapter = launchPackageAdapter !== undefined ? launchPackageAdapter : online && existsSync(dexSocketPath()) ? createDexPackageAdapter({ readBanner: (t) => projectBanners.read(t) }) : null;
  const socialAdapter = socialAccountAdapter !== undefined ? socialAccountAdapter : online && existsSync(brokerSocketPath()) ? createSocialPoolAdapter() : null;
  if (online) console.log(`[package] adapters: dex=${dexAdapter ? 'connected' : 'not_connected'} social=${socialAdapter ? 'connected' : 'not_connected'}`);
  const launchPackages = createLaunchPackageQueue({ tokens: () => Object.values(store.get().tokens), persist: store.saveDurable, adapter: dexAdapter });
  const socialAccounts = createSocialAccountQueue({ tokens: () => Object.values(store.get().tokens), persist: store.saveDurable,
    registry: () => (store.get().socialAccountRegistry ||= { accounts: {}, projects: {} }), adapter: socialAdapter });
  // Maintenance is not a website feature, even with valid admin credentials.
  const maintenanceLocal = (req) => isLoopback(req)
    && req.headers.host === new URL(baseUrl).host
    && !Object.keys(req.headers).some((key) => /^(?:forwarded$|x-forwarded-|x-real-ip$|cf-|origin$|referer$|sec-fetch-(?:site|dest|user)$)/.test(key))
    // Node's CLI fetch adds mode=cors too; real browser requests also carry site/dest.
    && (req.headers["sec-fetch-mode"] == null || req.headers["sec-fetch-mode"] === "cors");
  const adminAllowed = (req) => env("GATEWAY_ADMIN_PASSWORD") ? adminOk(req) : directOffline(req);
  const adminMutationAllowed = (req) => {
    if (["GET", "HEAD"].includes(req.method)) return true;
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return false;
    const site = req.headers["sec-fetch-site"];
    if (site != null && site !== "same-origin") return false;
    const origin = req.headers.origin;
    if (origin != null) {
      try { if (origin !== new URL(env("GATEWAY_PUBLIC_URL") || baseUrl).origin) return false; }
      catch { return false; }
    }
    return true;
  };

  async function actAsHolder(token, route, holder, fields, type) {
    const payload = { schemaVersion: 1, type, tokenAddress: eco.tokenOf(token).address, holder, timestamp: nowIso(), nonce: nonce(), ...fields };
    const signature = await signAsHolder(holder, payload);
    return await handleHolder({ method: "POST", headers: {} }, token, route, { payload, signature });
  }

  async function afterTick(toDestroy) {
    for (const { token } of toDestroy) {
      try { await dep.teardown(eco.tokenOf(token), "treasury empty"); } catch (e) { store.event("vast", `teardown failed: ${e.message}`, { token, level: "error" }); }
    }
    // Asset downloads must not hold up funding checks or VPS activation.
    void projectBanners.tick().catch(() => {});
    await Promise.allSettled([launchPackages.tick(), socialAccounts.tick(), plan.activateReady()]);
    store.save();
  }

  async function cycleAll() {
    if (auto.busy) return;
    auto.busy = true;
    try {
      for (const t of Object.values(store.get().tokens)) if (t.vps.state === "running" && t.vps.mode === "sim") await runner.cycle(t.address);
    } finally { auto.busy = false; }
  }

  async function control(req, path, body) {
    const s = store.get();
    let mm;
    if (req.method === "GET" && path === "state") {
      return {
        clock: new Date(s.clock.simMs).toISOString(), settings: s.settings, defaultMission: s.defaultMission || "", auto: { agents: auto.agents, clock: auto.clock },
        opsWallet: opsAddress(), publicUrl: dep.publicBase(), ingestHost: dep.ingestHost(),
        tokens: Object.values(s.tokens).map((t) => publicToken(t.address)), events: s.events.slice(0, 80),
      };
    }
    if (req.method === "POST" && path === "reset") { store.reset(); return { ok: true }; }
    if (req.method === "POST" && path === "tick") {
      const toDestroy = eco.tick(Number(body?.hours) || 1);
      store.save();
      await afterTick(toDestroy);
      return { ok: true, clock: new Date(store.get().clock.simMs).toISOString(), destroyed: toDestroy.length };
    }
    if (req.method === "POST" && path === "settings") {
      for (const [k, v] of Object.entries(body || {})) if (k in s.settings && Number.isFinite(Number(v))) s.settings[k] = Number(v);
      if (typeof body?.defaultMission === "string") s.defaultMission = body.defaultMission.slice(0, 1000);
      store.save();
      return { ok: true, settings: s.settings };
    }
    if (req.method === "POST" && path === "auto") {
      auto.agents = !!body?.agents; auto.clock = !!body?.clock;
      clearInterval(auto.timer); clearInterval(auto.clockTimer);
      if (auto.agents) auto.timer = setInterval(() => cycleAll().catch(() => {}), Math.max(2, Number(body?.agentSeconds) || 6) * 1000);
      if (auto.clock) auto.clockTimer = setInterval(async () => { const d = eco.tick(1); store.save(); await afterTick(d); }, Math.max(2, Number(body?.clockSeconds) || 10) * 1000);
      return { ok: true, auto: { agents: auto.agents, clock: auto.clock } };
    }
    if (req.method === "GET" && path === "wallet") return { address: opsAddress() };
    if (req.method === "POST" && path === "wallet/create") { const a = createOpsWallet(); store.event("wallet", `operations wallet ready: ${a}`); store.save(); return { address: a }; }
    if (req.method === "GET" && path === "wallet/balances") {
      const a = opsAddress();
      if (!a) throw fail(400, "create the wallet first");
      return { address: a, balances: await balancesOf(a), ops: await opsBalances() };
    }
    if (req.method === "POST" && path === "wallet/bridge") {
      const t = eco.tokenOf(String(body?.token || ""));
      if (t.treasury.mode !== "wallet") throw fail(400, "the recipient token has no treasury wallet");
      if (body?.confirm !== "BRIDGE") throw fail(400, 'type "BRIDGE" to confirm moving real funds from operations');
      const amountWei = ethers.parseEther(String(body?.amountEth || 0));
      if (!(amountWei > 0n)) throw fail(400, "amountEth must be positive");
      return await opsBridge({ originChainId: Number(body?.originChainId || 1), amountWei, destinationChainId: Number(body?.destinationChainId || 4663), destinationCurrency: body?.destinationCurrency || "0x0000000000000000000000000000000000000000", recipient: t.treasury.wallet });
    }
    if (req.method === "GET" && path === "vast/account") return await vastAccount();
    if (req.method === "POST" && path === "vast/search") return { offers: await searchOffers(body || {}) };
    if (req.method === "GET" && path === "vast/instances") return { instances: await listInstances() };
    // Live stock: every rentable machine, refreshed each minute and when one is rented.
    if (req.method === "GET" && path.startsWith("vast/inventory")) { const inv = await inventory({ force: path.endsWith("?force=1") }); return { refreshedAt: new Date(inv.at).toISOString(), source: inv.source, error: inv.error, count: inv.offers.length, gpus: gpuClasses(inv.offers), offers: inv.offers }; }
    if (req.method === "GET" && path === "providers") return { providers: listProviders() };
    // The picker: which model to rent from NanoGPT, with its price per million tokens.
    if (req.method === "GET" && path === "models") return { provider: X402_ID, default: await defaultModel(), models: await listAgentModels() };
    if ((mm = path.match(/^providers\/([a-z0-9-]+)\/models$/)) && req.method === "GET") return { models: await listModels(mm[1]) };

    if (req.method === "POST" && path === "tokens") { const t = eco.createToken(body || {}); store.save(); return publicToken(t.address); }
    // Operator: adopt an existing Solana mint as a project (Solana treasury, plan, launch package v3). Until the own router launch exists.
    if (req.method === "POST" && path === "tokens/solana") return adoptSolanaToken(body || {});
    if ((mm = path.match(/^tokens\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/(.+)$/))) {
      const [, token, action] = mm;
      const t = eco.tokenOf(token);
      let out;
      switch (`${req.method} ${action}`) {
        case "GET page": return publicToken(token);
        case "POST refresh": await refreshTreasury(t); out = { ok: true, treasury: { ...t.treasury, ledger: undefined } }; break;
        case "POST pocket": out = { ok: true, usdcMicros: await ensureAiPocket(t, Number(body?.needMicros) || 0) }; break;
        case "POST fund": {
          if (t.treasury.mode !== "wallet") throw fail(400, "this token has a simulated treasury");
          const micros = Math.round(Number(body?.usd) * 1e6);
          if (!(micros > 0)) throw fail(400, "usd must be positive");
          if (body?.confirm !== "FUND") throw fail(400, 'type "FUND" to confirm a real USDC transfer from operations');
          out = { ok: true, tx: await fundTreasuryFromOps(t, micros) };
          await refreshTreasury(t).catch(() => {});
          break;
        }
        case "POST bill": out = { ok: true, result: t.treasury.mode === "wallet" ? await (await import("./billing.mjs")).chargeVpsHour(t) : { paid: false, reason: "simulated treasury" } }; break;
        case "GET prompt": return { prompt: promptFor(t) };
        case "POST holders": out = { added: eco.addHolders(token, body?.count) }; break;
        case "POST holders/add": out = eco.addHolderAddress(token, body?.address, body?.sharePct); break;
        case "POST sell": out = { sold: eco.sellHolder(token, body.holder, Number(body.fraction ?? 1)) }; break;
        case "POST deposit": eco.depositTreasury(t, Number(body?.usd) || 0); out = { ok: true }; break;
        case "POST volume": t.volumeUsdPerHour = Math.max(0, Number(body?.usdPerHour) || 0); out = { ok: true }; break;
        case "POST finalize": await verifyDueGovernance(t); eco.finalizeDue(t, { force: true }); out = { ok: true }; break;
        case "POST act/message": out = await actAsHolder(token, "message", body.holder, { text: body.text }, "holder_message"); break;
        case "POST act/proposal": out = await actAsHolder(token, "proposal", body.holder, { proposalType: body.type, title: body.title, proposalPayload: body.payload || {} }, "holder_proposal"); break;
        case "POST act/vote": out = await actAsHolder(token, "vote", body.holder, { proposalId: body.proposalId, support: !!body.support }, "holder_vote"); break;
        case "POST agent/cycle": out = await runner.cycle(token); break;
        // The plan: model + machine, priced; the token starts by itself at the threshold.
        case "POST plan": out = await plan.setPlan(t, body || {}); break;
        case "POST plan/resume": plan.resume(t); out = plan.lockStatus(t); break;
        case "POST plan/check": out = { started: await plan.activateReady(), lock: plan.lockStatus(t) }; break;
        case "POST deploy": {
          if (body?.model && (body?.offerId != null || body?.offer)) await plan.setPlan(t, body);
          out = await dep.deploy(token, { ...(body || {}), offer: body?.offer || t.plan?.offer || null });
          if (out.ok && t.plan) t.lock = { ...(t.lock || {}), state: "unlocked", unlockedAt: new Date().toISOString(), note: "started from the control room" };
          break;
        }
        case "POST vps/start": out = await dep.deploy(token, { mode: "sim", provider: body?.provider || "simulated", model: body?.model, offer: body?.offer }); break;
        case "POST vps/stop": await dep.teardown(t, "stopped from the control room"); plan.pause(t); out = { ok: true }; break;
        case "POST vps/poll": await dep.poll(); out = { ok: true, vps: t.vps }; break;
        // A boot code for a machine you bring yourself (tests, a non-vast host). Plaintext once.
        case "POST vps/bootcode": {
          const code = issueBootCode(t, { manual: true });
          // A simulated boot for demo projects only; a funded project refuses it, which is not an error of this route.
          if (t.vps.state !== "running") dep.deploy(token, { mode: "sim", provider: body?.provider || t.agent.ai?.provider || "simulated", model: body?.model || t.agent.ai?.model }).catch((e) => store.event("vps", `${t.symbol}: no simulated boot for a manual boot code — ${String(e.message || e).slice(0, 120)}`, { token: t.address, level: "warn" }));
          out = { code, bootUrl: `${dep.publicBase()}/boot/${t.address}/${code}`, command: dep.bootCommandFor(t.address, code) };
          break;
        }
        default: throw fail(404, `no control route ${req.method} ${action}`);
      }
      store.save();
      return out;
    }
    throw fail(404, `no control route ${req.method} ${path}`);
  }

  // ── VPS-facing ─────────────────────────────────────────────────────────────

  function bootScript(t, code) {
    const src = readFileSync(join(ROOT, "boot", "bootstrap.sh"), "utf8");
    const runtime = readFileSync(join(ROOT, "boot", "runtime", "runtime-setup.sh"), "utf8");
    const desktop = readFileSync(join(ROOT, "boot", "native-desktop.py"), "utf8");
    return src.replace("__GATEWAY_RUNTIME_SETUP__", () => runtime).replace("__GATEWAY_NATIVE_DESKTOP__", () => desktop).replace(/__GATEWAY__/g, dep.publicBase()).replace(/__INGEST__/g, dep.ingestHost()).replace(/__TOKEN__/g, eco.tokenKey(t.chain, t.address)).replace(/__CODE__/g, code);
  }

  // Boot progress from the machine: an unused boot code (before registration) or the
  // session (after) proves it is ours. Only a note in the VPS log; nothing is granted.
  function vpsProgress(req, body) {
    const t = eco.tokenOf(String(body?.token || ""));
    const ok = sessionOf(req, t) || peekBootCode(t, String(body?.code || ""));
    if (!ok) throw fail(403, "not this token's machine");
    const step = publicText(body?.step || "").slice(0, 80), detail = publicText(body?.detail || "").replace(/\s+/g, " ").trim().slice(0, 600);
    dep.noteProgress(t, step, detail);
    store.save();
    return { ok: true };
  }

  async function vpsRegister(body) {
    const t = eco.tokenOf(String(body?.token || ""));
    const session = redeemBootCode(t, String(body?.code || ""));
    if (!session) throw fail(403, "boot code is invalid, expired or already used");
    const streamKey = issueStreamKey(t);
    dep.markRegistered(t, body?.host || {});
    t.vps.workbenchEnabled = env("GATEWAY_WORKBENCH_ENABLED", "0") === "1";
    delete t.vps.runtimeCapabilities;
    const s = store.get();
    store.save();
    return {
      session, streamKey,
      config: {
        gateway: dep.publicBase(), token: t.address, name: t.name, symbol: t.symbol, chain: t.chain, domain: t.domain,
        farcaster: { username: t.agent.farcaster.username, fid: t.agent.farcaster.fid }, ai: t.agent.ai || { provider: "simulated", model: "simulated" },
        defaultMission: s.defaultMission || "Keep the project website accurate, read holder messages, and draft proposal ideas that help the community.",
        statusNoteHours: s.settings.statusNoteHours, maxRepliesPerCycle: s.settings.maxRepliesPerCycle, loopSleepSeconds: 60,
        workbench: { enabled: t.vps.workbenchEnabled, root: "/home/agent/work", maxCallsPerTask: 12, maxToolCallsPerTurn: 4, publication: "temporary-preview" },
        stream: { width: s.settings.streamWidth, height: s.settings.streamHeight, fps: s.settings.streamFps, kbps: s.settings.streamKbps },
        facts: { token: t.address, chain: `${t.chain} (chain id ${eco.chainIdOf?.(t.chain) ?? ""})`, curve: t.curveAddress, treasury: t.treasury.wallet || null, channel: `${dep.publicBase()}/t/${t.address}`, website: `${dep.publicBase()}/w/${eco.tokenKey(t.chain, t.address)}`, explorer: t.onchain?.explorer || `https://robin.etherscan.io/address/${t.address}`, trade: tradeUrlFor(t), model: t.agent.ai?.name || t.agent.ai?.model, machine: t.vps.offer?.gpu || null, creatorTaxPct: t.onchain ? t.onchain.creatorTaxBps / 100 : null, orderMinPct: s.settings.orderMinBps / 100 },
      },
      prompt: promptFor(t),
    };
  }

  function mediamtx(req, path, body) {
    if (!isLoopback(req) || isForwardedOrBrowser(req) || req.headers.host !== new URL(baseUrl).host) throw fail(403, "direct loopback hooks only");
    if (path === "auth") {
      const m = String(body?.path || "").match(/^live\/(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (String(body?.action) === "publish") {
        if (!m) throw fail(401, "unknown stream path");
        const t = store.get().tokens[m[1]];
        if (!t || !streamKeyOk(t, String(body?.password || ""))) throw fail(401, "bad stream key");
        return { ok: true };
      }
      if (["read", "playback"].includes(String(body?.action))) return { ok: true };
      throw fail(401, "denied");
    }
    if (path === "event") {
      const m = String(body?.path || "").match(/^live\/(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
      const t = m && store.get().tokens[m[1]];
      if (t) { dep.markStream(t, body?.event === "ready"); store.save(); }
      return { ok: true };
    }
    throw fail(404, "unknown mediamtx route");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    const p = url.pathname;
    try {
      // Reject before reading bodies or checking credentials. No web login challenge.
      if ((p === "/api/control" || p.startsWith("/api/control/")) && !maintenanceLocal(req)) return send(res, 404, { error: "not found" });
      let mm;
      const bootFiles = ["agent.py", "privacy.py", "workbench.py", "publisher.py", "relay.py", "supervisor.py", "desktop-kurt.py", "native-speech.py"];
      if (bootFiles.some((f) => p === `/boot/${f}`)) return text(res, 200, readFileSync(join(ROOT, "boot", p.slice(6)), "utf8"), TYPES[".py"]);
      if ((mm = p.match(/^\/boot\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/([0-9a-f]{48})$/))) {
        const t = eco.tokenOf(mm[1]);
        if (!peekBootCode(t, mm[2])) return text(res, 403, 'echo "gateway: boot code invalid or already used"; exit 0\n');
        return text(res, 200, bootScript(t, mm[2]));
      }
      if ((mm = p.match(/^\/t\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/))) return text(res, 200, readFileSync(join(ROOT, "public", "token.html"), "utf8"), TYPES[".html"]);
      if (req.method === "GET" && (mm = p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/events$/))) {
        eco.tokenOf(mm[1]);
        return realtime.stream(req, res, mm[1]);
      }

      if (p.startsWith("/api/") || p.startsWith("/local/")) {
        const body = req.method === "GET" ? null : await readBody(req);
        if (req.method === 'GET' && (mm = p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/voice\/([a-zA-Z0-9_-]{1,128})$/))) {
          // Playback reads an already generated, validated clip only. A missing
          // cache entry must never call the provider or spend a holder's budget.
          if (url.search) throw fail(400, 'speech playback does not accept parameters');
          const audio = cachedVoiceAudio(eco.tokenOf(mm[1]), mm[2]);
          if (!audio) return send(res, 404, { error: 'speech audio is not cached; no generation was started' });
          res.writeHead(200, { 'Content-Type': audio.type, 'Content-Length': audio.bytes.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' });
          return res.end(audio.bytes);
        }
        if (req.method === "GET" && (mm = p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/deliveries\/(delivery-[a-f0-9]{24})$/))) {
          const t = eco.tokenOf(mm[1]), artifact = (t.artifacts || []).find(a => a.id === mm[2]);
          if (!artifact) return send(res, 404, { error: "delivery not found" });
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${artifact.id}.${artifact.kind === "website" ? "html.txt" : "md"}"`, "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
          return res.end(publicText(artifact.content));
        }
        if (p.startsWith("/api/control/")) {
          if (!adminAllowed(req)) return send(res, 401, { error: "login required" }, { "WWW-Authenticate": 'Basic realm="Gateway"' });
          if (!adminMutationAllowed(req)) throw fail(403, "same-origin JSON admin request required");
          return send(res, 200, await control(req, p.slice("/api/control/".length), body));
        }
        if (p === "/api/vps/register" && req.method === "POST") return send(res, 200, await vpsRegister(body));
        if (p === "/api/vps/progress" && req.method === "POST") return send(res, 200, vpsProgress(req, body));
        if ((mm = p.match(/^\/api\/mediamtx\/(auth|event)$/)) && req.method === "POST") return send(res, 200, mediamtx(req, mm[1], body));
        if ((mm = p.match(/^\/api\/site\/agent\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/svc\/(.+)$/))) {
          const t = eco.tokenOf(mm[1]);
          if (!sessionOf(req, t)) return send(res, 401, { error: "session required" });
          return send(res, 200, await handleLocal(req, mm[1], mm[2], body));
        }
        if ((mm = p.match(/^\/api\/site\/agent\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/(.+)$/))) {
          const t = eco.tokenOf(mm[1]);
          if (req.method === "GET" && !sessionOf(req, t) && !offlineLocal(req, t)) throw fail(401, "agent session required");
          if (req.method === "GET" && mm[2] === "inbox" && url.searchParams.has("wait")) {
            // Long polling is agent-session-only, never opened by a public SSE reader.
            if (!sessionOf(req, t)) throw fail(401, "agent session required");
            const wait = url.searchParams.get("wait"), cursor = url.searchParams.get("cursor") || "0";
            if (!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(wait) || !/^\d{1,12}$/.test(cursor)) throw fail(400, "invalid inbox wait");
            const abort = new AbortController();
            const cancel = () => abort.abort();
            res.once("close", cancel);
            // Keyed like the store: EVM lowercased, a Solana mint verbatim (lowercasing a base58 mint made every long poll 404 — met.fun 2026-09-22).
            try { await realtime.waitInbox(eco.tokenKey(t.chain, t.address), Number(cursor), Number(wait) * 1000, abort.signal); }
            finally { res.off("close", cancel); }
            if (res.destroyed) return;
            if (!sessionOf(req, t)) throw fail(401, "agent session expired");
          }
          return send(res, 200, await handleAgent(req, mm[1], mm[2], url.searchParams, body));
        }
        if ((mm = p.match(/^\/api\/site\/holder\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/(chat-session|chat-message|chat-status|chat-logout)$/))) {
          const result = await handleHolderChat(req, mm[1], mm[2], body, new URL(env("GATEWAY_PUBLIC_URL") || baseUrl).origin);
          return send(res, 200, result.json, result.cookie ? { "Set-Cookie": result.cookie } : {});
        }
        if ((mm = p.match(/^\/api\/site\/holder\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/(.+)$/))) return send(res, 200, await handleHolder(req, mm[1], mm[2], body));
        if(req.method==='GET'&&(mm=p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/project-logo$/))){
          const proposalId=url.searchParams.get('proposalId');
          if(proposalId&&!/^prop_[a-zA-Z0-9_]{1,80}$/.test(proposalId))return text(res,400,'invalid logo reference');
          const bytes=projectLogo(eco.tokenOf(mm[1]),proposalId);
          if(!bytes)return text(res,404,'No logo selected');
          res.writeHead(200,{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'no-store'});return res.end(bytes);
        }
        if(req.method==='GET'&&(mm=p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/project-banner$/))){
          const bytes=await projectBanners.read(eco.tokenOf(mm[1]));
          if(!bytes)return text(res,404,'This project banner is not ready');
          res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'no-store'});return res.end(bytes);
        }
        if(req.method==='POST'&&(mm=p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/wallet-preview$/))) return send(res,200,await previewWalletAction(eco.tokenOf(mm[1]),body));
        if ((mm = p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/))) return send(res, 200, publicToken(mm[1]));

        // Public launchpad: channels, the catalog and stock behind the launch form, the launch itself.
        if (p === "/api/site/channels" && req.method === "GET") return send(res, 200, { channels: publicTree(launchpad.channels()) });
        if (p === "/api/site/models" && req.method === "GET") return send(res, 200, { default: await defaultModel(), models: await listAgentModels() });
        if (p === "/api/site/inventory" && req.method === "GET") { const inv = await inventory(); return send(res, 200, { refreshedAt: new Date(inv.at).toISOString(), count: inv.offers.length, gpus: publicTree(gpuClasses(inv.offers)), offers: inv.offers.map(publicOffer) }); }
        if (p === "/api/site/launch/quote" && req.method === "POST") { const q = await launchpad.quote(body || {}); return send(res, 200, { activationUsd: q.activationUsd, dailyUsd: q.dailyUsd, modelName: q.modelName, machine: q.machine, dph: q.dph, stepUsd: q.stepUsd, launchPackage: q.launchPackage, runtimeActivationUsd: q.runtimeActivationUsd, unlockMinUsd: q.launchPackage ? q.launchPackage.activationMicros / 1e6 : store.get().settings.unlockMinUsd, unlockMaxUsd: q.launchPackage ? q.launchPackage.activationMicros / 1e6 : store.get().settings.unlockMaxUsd }); }
        if (p === "/api/site/launch" && req.method === "POST") { if (!env("PUBLIC_SIM_LAUNCH") && !env("GATEWAY_OFFLINE")) return send(res, 410, { error: "launch on Pons: use /api/site/launch/prepare and /confirm" }); return send(res, 200, await launchpad.launch(body || {})); }
        // Real launches on Pons: the site encodes the call, the creator's wallet sends it, the receipt binds the channel.
        if (p === "/api/site/launch/info" && req.method === "GET") return send(res, 200, { ...(await launchpad.info()), pump: pumpLaunch.launchesEnabled() });
        // pump.fun launches: the launcher's wallet pays, the project treasury is the creator.
        if (p === "/api/site/launch/pump/info" && req.method === "GET") return send(res, 200, pumpLaunch.info());
        if (p === "/api/site/launch/pump/prepare" && req.method === "POST") return send(res, 200, await pumpLaunch.prepare(body || {}, { ip: String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "") }));
        if (p === "/api/site/launch/pump/confirm" && req.method === "POST") { const result = await pumpLaunch.confirm(body || {}); if (result.status === "done") void projectBanners.tick().catch(() => {}); return send(res, 200, result); }
        if (p === "/api/site/launches/pump" && req.method === "GET") return send(res, 200, { suffix: pumpLaunch.info().suffix, launches: pumpLaunch.registry() });
        if (p === "/api/site/launch/prepare" && req.method === "POST") return send(res, 200, await launchpad.prepare(body || {}));
        if (p === "/api/site/launch/confirm" && req.method === "POST") {
          const result=await launchpad.confirm(body || {});
          if(result.status==='done')void projectBanners.tick().catch(()=>{});
          return send(res,200,result);
        }
        if ((mm = p.match(/^\/api\/site\/token\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/market$/))) { const t = eco.tokenOf(mm[1]); return send(res, 200, t.onchain ? publicMarket(marketOf(t)) : { error: "not an on-chain token" }); }
        if ((mm = p.match(/^\/local\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/(.+)$/))) {
          // This route exists only for the offline simulator. Never expose its
          // signer/AI service to public traffic or a real funded VPS instance.
          const t = eco.tokenOf(mm[1]);
          if (!offlineLocal(req, t)) throw fail(403, "legacy local services are disabled outside the offline simulator");
          return send(res, 200, await handleLocal(req, mm[1], mm[2], body));
        }
        return send(res, 404, { error: "not found" });
      }

      // The token's own website, as the agent deployed it (HTML or plain text).
      if ((mm = p.match(/^\/w\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\/?$/))) {
        const t = eco.tokenOf(mm[1]); const w = { ...(t.website || {}) };
        if (w.hosting === "agent-vps" && /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(w.url || "")) {
          if (!await previewChecker(t) || t.website?.url !== w.url || t.website?.releaseHash !== w.releaseHash) return text(res, 503,
            'This temporary website preview is currently unavailable. The agent may be stopped or the preview connection may have expired. Return to the project page to check its status. No new purchase or payment was made.');
          res.writeHead(302, { Location: w.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          return res.end();
        }
        if (w.html) requireInertHtml(w.content);
        const safeContent = publicText(w.content);
        const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        const inner = w.html ? safeContent : `<main style="max-width:760px;margin:40px auto;padding:0 20px;font-family:Inter,system-ui,sans-serif;line-height:1.6;white-space:pre-wrap">${escapeHtml(safeContent)}</main>`;
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(t.name)} ($${escapeHtml(t.symbol)})</title><style>body{margin:0;background:#0b0d0c;color:#f2f2f2}a{color:#d7ff4a}</style></head><body>${inner}<footer style="text-align:center;padding:20px;font:12px Inter,system-ui,sans-serif;color:#8b928c">Built and maintained by an AI agent · <a href="/t/${t.address}">watch it live</a> · v${w.version || 0}</footer></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        return res.end(html);
      }
      // Explicit public files only: retired panel assets/backups cannot be served.
      const PUBLIC_PAGES = { "/": "channels.html", "/launch": "launch.html", "/channels.html": "channels.html", "/launch.html": "launch.html", "/token.html": "token.html", "/live-token.js": "live-token.js", "/chat-session.js": "chat-session.js", "/gateway.css": "gateway.css", "/project-community.js":"project-community.js", "/project-community.css":"project-community.css", "/social-budget.js":"social-budget.js", "/social-budget.css":"social-budget.css", "/dex-payments.js":"dex-payments.js", "/voice-playback.js":"voice-playback.js", "/wallet-mobile.js":"wallet-mobile.js", ...COMPANION_ASSETS };
      // Version-pinned official chart bundle; never expose the vendor directory generically.
      PUBLIC_PAGES['/launch-progress.js'] = 'launch-progress.js';
      PUBLIC_PAGES['/launch-progress.css'] = 'launch-progress.css';
      PUBLIC_PAGES['/community-actions.js'] = 'community-actions.js';
      PUBLIC_PAGES['/agent-playbook.html'] = 'agent-playbook.html';
      PUBLIC_PAGES['/terms'] = 'legal.html'; PUBLIC_PAGES['/privacy'] = 'legal.html'; PUBLIC_PAGES['/legal.html'] = 'legal.html';
      PUBLIC_PAGES['/vendor/lightweight-charts/4.2.1/lightweight-charts.standalone.production.js'] = 'vendor/lightweight-charts/4.2.1/lightweight-charts.standalone.production.js';
      PUBLIC_PAGES['/vendor/lightweight-charts/4.2.1/LICENSE'] = 'vendor/lightweight-charts/4.2.1/LICENSE';
      PUBLIC_PAGES['/vendor/lightweight-charts/4.2.1/NOTICE'] = 'vendor/lightweight-charts/4.2.1/NOTICE';
      Object.assign(PUBLIC_PAGES, BRAND_ASSETS);
      const rel = Object.hasOwn(PUBLIC_PAGES, p) ? PUBLIC_PAGES[p] : null;
      if (!rel) return text(res, 404, "not found");
      const file = join(ROOT, "public", rel);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || (/\/(LICENSE|NOTICE)$/.test(p) ? "text/plain; charset=utf-8" : "application/octet-stream"), "Cache-Control": /\/(vendor|assets|brand)\//.test(p) ? "public, max-age=86400" : "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(readFileSync(file));
    } catch (e) {
      send(res, e.status || 500, { error: publicText(e.message || String(e)), code: e.code || null });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  let poller = null;
  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, host, () => {
      const actual = server.address().port;
      baseUrl = `http://${host}:${actual}`;
      runner = createAgentRunner({ baseUrl });
      poller = dep.startPoller();
      let governanceBusy=false;
      const governance = setInterval(async () => {
        if (governanceBusy) return;
        governanceBusy=true;
        try {
        let changed = false;
        for (const t of Object.values(store.get().tokens)) {
          if (!t.proposals.some(p => p.status === "voting" && !p.cancelledAt && !p.revokedAt && p.endsAt && Date.parse(p.endsAt) <= Date.now())) continue;
          await verifyDueGovernance(t); eco.finalizeDue(t); changed = true;
        }
        if (changed) store.save();
        } catch { /* fail closed and retry verification on the next poll */ }
        finally {governanceBusy=false;}
      }, 5_000);
      governance.unref?.();
      server.once("close", () => clearInterval(governance));
      if (!env("GATEWAY_OFFLINE")) startViewerPoll();
      // Vote-approved X posts via the root broker socket; absent socket = not connected.
      if (!env("GATEWAY_OFFLINE")) { const stopX = setXPosts(createXPosts({ charge: chargeTreasuryOnce })).start(); server.once("close", stopX); }
      if (!env("GATEWAY_OFFLINE") || env("ROBINHOOD_RPC")) startMarketPoll();
      if (!env("GATEWAY_OFFLINE") && pumpLaunch.launchesEnabled()) {
        const stopPool = mintPool().start(); server.once("close", stopPool);
        let sweeping = false;
        const sweeper = setInterval(async () => { if (sweeping) return; sweeping = true; try { await sweepCreatorFees({ sponsor: feeSponsor }); store.save(); } catch (e) { console.error("[pump-fees]", e.message); } finally { sweeping = false; } }, 60_000);
        sweeper.unref?.(); server.once("close", () => clearInterval(sweeper));
        // Launches the browser never confirmed are finished (or retired) from the server side.
        let reconciling = false;
        const reconciler = setInterval(async () => { if (reconciling) return; reconciling = true; try { const r = await pumpLaunch.reconcile(); if (r.some((x) => x.status !== "pending")) store.save(); } catch (e) { console.error("[pump-launch]", e.message); } finally { reconciling = false; } }, 60_000);
        reconciler.unref?.(); server.once("close", () => clearInterval(reconciler));
      }
      let billingBusy = false;
      const activate = () => Promise.allSettled([launchPackages.tick(), socialAccounts.tick(), projectBanners.tick(), plan.activateReady()]);
      void projectBanners.tick().catch(()=>{});
      void Promise.allSettled([launchPackages.tick(), socialAccounts.tick()]);
      const billing = setInterval(async () => {
        if (billingBusy) return;
        billingBusy = true;
        try {
          await billRunning();
          // Activation owns its per-project and global concurrency limits. Do
          // not hold the next batch behind one slow provider request.
          void activate();
          store.save();
        } catch (e) { console.error("[billing]", e.message); }
        finally { billingBusy = false; }
      }, 60_000);
      billing.unref?.();
      // Money should be noticed in seconds, not minutes: locked channels re-read their
      // treasury every 10 s and start the moment the threshold is met.
      let fastBusy = false;
      const fast = setInterval(async () => {
        if (fastBusy || env("GATEWAY_OFFLINE")) return; fastBusy = true;
        try {
          const s = store.get();
          const waiting = Object.values(s.tokens).filter((t) => t.treasury.mode === "wallet" && t.plan && t.lock?.state === "locked" && t.vps.state !== "running");
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(3, waiting.length) }, async () => {
            while (cursor < waiting.length) {
              const t = waiting[cursor++];
              await refreshTreasury(t).catch(() => {});
              // Persist balances even if no rental starts; the page should not
              // wait for an unrelated market update to show a received deposit.
              store.save();
              void activate();
            }
          }));
        } catch (e) { console.error("[fast]", e.message); } finally { fastBusy = false; }
      }, 10_000);
      fast.unref?.();
      server.once("close", () => { clearInterval(billing); clearInterval(fast); });
      resolve(baseUrl);
    })),
    close: () => { realtime.close(); clearInterval(auto.timer); clearInterval(auto.clockTimer); clearInterval(poller); return new Promise((r) => server.close(r)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const room = createControlRoom();
  room.listen().then((url) => console.log(`Gateway: ${url} (public ${dep.publicBase()})`));
}
