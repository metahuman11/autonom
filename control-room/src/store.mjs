// One JSON state file, written atomically (temp file + rename) after every change.
// Holds no private keys: those live in wallets.mjs's separate 0600 secrets file.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./env.mjs";

const STATE_PATH = join(DATA_DIR, "state.json");

export const DEFAULT_SETTINGS = Object.freeze({
  feeBps: 100,               // trade fee charged on the bonding curve
  treasuryShareBps: 5000,    // share of the fee that reaches the token treasury
  aiCostPerCallUsd: 0.01,    // simulated price of one AI request
  chatShareBps: 2000,        // share of the treasury opened as holder chat quota each epoch
  epochHours: 24,
  lowBudgetUsd: 5,           // below this (or under 24h runway) the agent conserves
  proposalMinBps: 100,       // 1% of eligible supply needed to open a proposal
  orderMinBps: 100,          // holders at or above this share give ORDERS; below it they chat
  votingHours: 6,
  quorumBps: 1000,           // 10% of snapshot supply must vote
  passBps: 5000,             // more than half of the votes cast
  statusNoteHours: 3,
  maxRepliesPerCycle: 5,
  aiPocketFloorUsd: 1,       // refill the Base USDC pocket from Robinhood ETH below this
  aiPocketTargetUsd: 3,      // ...up to this
  unlockMinUsd: 75,          // treasury needed to start with the cheapest model + machine
  unlockMaxUsd: 100,         // ...with the most expensive of both
  streamWidth: 3840,         // the VPS desktop and stream: 4K by default, NVENC on the GPU
  streamHeight: 2160,
  streamFps: 24,
  streamKbps: 12000,
});

function fresh() {
  return {
    version: 1,
    clock: { simMs: Date.parse("2026-09-15T00:00:00Z") },
    settings: { ...DEFAULT_SETTINGS },
    tokens: {},          // keyed by token address
    agents: {},          // simulated VPS-side durable state, keyed by token address
    replay: {},          // nonces and idempotency keys seen by the site, per token
    events: [],          // control-room activity feed
    profiles: {},        // wallet → { username, setAt }, one username per wallet across all channels
  };
}

let state = null;
const changeListeners = new Set();
// No state/secrets are carried in notifications. Subscribers read their own safe DTO.
export function onChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function load() {
  mkdirSync(DATA_DIR, { recursive: true });
  state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : fresh();
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  state.profiles ||= {};
  return state;
}

export function get() {
  return state || load();
}

export function save() {
  // Once an intent exists, later ordinary saves must not weaken its durability.
  const hasFinancialHistory=Object.values(state?.tokens || {}).some(t=>
    Object.keys(t.communityActionReservations || {}).length>0 ||
    (t.vps?.attempts?.length || 0)>0 || t.vps?.pendingCreate != null || t.vps?.instanceId != null);
  persistState(hasFinancialHistory);
}

// Treasury signing checkpoints must reach the filesystem before a signature or
// network dispatch. A rename alone is atomic but not a power-loss durability guarantee.
export function saveDurable() {
  persistState(true);
}

function persistState(durable) {
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  if (durable) {
    const fd=openSync(tmp,'r');
    try {fsyncSync(fd);} finally {closeSync(fd);}
  }
  renameSync(tmp, STATE_PATH);
  if (durable) {
    const fd=openSync(DATA_DIR,'r');
    try {fsyncSync(fd);} finally {closeSync(fd);}
  }
  for (const listener of [...changeListeners]) { try { listener(); } catch { /* transport failure must not undo a saved action */ } }
}

export function reset() {
  state = fresh();
  save();
  return state;
}

export function event(kind, message, extra = {}) {
  const s = get();
  s.events.unshift({ at: new Date().toISOString(), simAt: new Date(s.clock.simMs).toISOString(), kind, message, ...extra });
  if (s.events.length > 500) s.events.length = 500;
}
