// Read-only balances for the operations wallet. No signing, no sending.
import { ethers } from "ethers";
import { env } from "./env.mjs";

export const CHAINS = [
  { key: "base", name: "Base", id: 8453, rpc: "https://base-rpc.publicnode.com", native: "ETH", stable: { sym: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", dec: 6 } },
  { key: "ethereum", name: "Ethereum", id: 1, rpc: "https://ethereum-rpc.publicnode.com", native: "ETH", stable: { sym: "USDC", addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", dec: 6 } },
  { key: "arbitrum", name: "Arbitrum", id: 42161, rpc: "https://arbitrum-one-rpc.publicnode.com", native: "ETH", stable: { sym: "USDC", addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", dec: 6 } },
  { key: "optimism", name: "Optimism", id: 10, rpc: "https://optimism-rpc.publicnode.com", native: "ETH", stable: { sym: "USDC", addr: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", dec: 6 } },
  { key: "polygon", name: "Polygon", id: 137, rpc: "https://polygon-bor-rpc.publicnode.com", native: "POL", stable: { sym: "USDC", addr: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", dec: 6 } },
  { key: "bsc", name: "BNB Chain", id: 56, rpc: "https://bsc-rpc.publicnode.com", native: "BNB", stable: { sym: "USDT", addr: "0x55d398326f99059fF775485246999027B3197955", dec: 18 } },
  { key: "robinhood", name: "Robinhood Chain", id: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", native: "ETH", stable: { sym: "USDG", addr: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", dec: 6 } },
];

const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

export async function balancesOf(address) {
  const who = ethers.getAddress(address);
  return await Promise.all(CHAINS.map(async (c) => {
    const p = new ethers.JsonRpcProvider(c.rpc, c.id, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const [native, stableRaw] = await withTimeout(Promise.all([
        p.getBalance(who),
        p.call({ to: c.stable.addr, data: ERC20.encodeFunctionData("balanceOf", [who]) }),
      ]), 10_000);
      return {
        chain: c.key, name: c.name,
        native: { sym: c.native, amount: ethers.formatEther(native) },
        stable: { sym: c.stable.sym, amount: ethers.formatUnits(BigInt(stableRaw), c.stable.dec) },
      };
    } catch (e) {
      return { chain: c.key, name: c.name, error: String(e?.shortMessage || e?.message || e).slice(0, 80) };
    } finally {
      p.destroy();
    }
  }));
}

// ── Base USDC: the treasury currency ─────────────────────────────────────────
export const BASE = CHAINS.find((c) => c.key === "base");
export const USDC_BASE = ethers.getAddress(BASE.stable.addr);
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
];
export const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: BASE.id, verifyingContract: USDC_BASE };
export const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
let baseProvider = null;
/// Base RPC for reads AND the pocket's own transaction submissions. BASE_RPC_URL overrides;
/// the default is Base's official public endpoint (a third-party public node answered a real
/// eth_sendRawTransaction from the server with HTTP 403 on 2026-09-23 while accepting reads).
export const BASE_RPC_URL = () => env("BASE_RPC_URL", "https://mainnet.base.org");
export function baseRpc() {
  return (baseProvider ||= new ethers.JsonRpcProvider(BASE_RPC_URL(), BASE.id, { staticNetwork: true, batchMaxCount: 1 }));
}
/// USDC balance in micro-dollars (6 decimals = micros, no conversion needed).
export async function usdcMicros(address) {
  const raw = await baseRpc().call({ to: USDC_BASE, data: new ethers.Interface(USDC_ABI).encodeFunctionData("balanceOf", [ethers.getAddress(address)]) });
  return Number(BigInt(raw));
}
export async function baseEth(address) {
  return Number(ethers.formatEther(await baseRpc().getBalance(ethers.getAddress(address))));
}
/// Submits a treasury-signed transferWithAuthorization with the ops wallet paying gas.
export async function submitAuthorizedTransfer(signer, auth, signature) {
  const { v, r, s } = ethers.Signature.from(signature);
  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, signer);
  const tx = await usdc.transferWithAuthorization(auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error("USDC transfer reverted");
  return rc.hash;
}
/// USDC transfer from a signer that pays its own gas (a Base pocket paying NanoGPT's direct rail).
/// The transaction is signed locally first so its hash is known — and can be journaled — BEFORE it
/// is broadcast; every failure says what is known: `broadcast:false` (never left this process),
/// `reverted:true` (landed, moved nothing), or `broadcast:true` with the hash (may still land).
/// `impl` is injected by tests; the default uses ethers.
export function defaultUsdcTransferImpl(signer) {
  return {
    async prepare(to, micros) {
      const data = new ethers.Interface(USDC_ABI).encodeFunctionData("transfer", [ethers.getAddress(to), BigInt(micros)]);
      const populated = await signer.populateTransaction({ to: USDC_BASE, data });
      const raw = await signer.signTransaction(populated);
      return { raw, hash: ethers.keccak256(raw), nonce: Number(populated.nonce) };
    },
    async broadcast(raw) { return signer.provider.broadcastTransaction(raw); },
  };
}
export async function sendUsdc(signer, to, micros, { confirmations = 1, impl = null, onSigned = null } = {}) {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error("USDC amount must be a positive integer of micros");
  const io = impl || defaultUsdcTransferImpl(signer);
  let prepared;
  try { prepared = await io.prepare(to, micros); }
  catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { broadcast: false }); }
  if (onSigned) await onSigned({ hash: prepared.hash, nonce: prepared.nonce });
  let sent;
  try { sent = await io.broadcast(prepared.raw); }
  catch (e) {
    // The node may have accepted the transaction and lost its answer: never "nothing moved".
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { broadcast: true, hash: prepared.hash });
  }
  let rc;
  try { rc = await sent.wait(confirmations); }
  catch (e) {
    const reverted = e?.code === "CALL_EXCEPTION" || e?.receipt?.status === 0;   // ethers v6 throws on a reverted receipt
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { broadcast: true, hash: prepared.hash, ...(reverted ? { reverted: true } : {}) });
  }
  if (!rc || rc.status !== 1) throw Object.assign(new Error("USDC transfer reverted"), { broadcast: true, reverted: true, hash: prepared.hash });
  return { hash: rc.hash || prepared.hash, gasWei: (rc.gasUsed ?? 0n) * (rc.gasPrice ?? rc.effectiveGasPrice ?? 0n) };
}
/// Confirmed transaction count of an address on Base (the next nonce it can use).
export async function baseNonce(address) { return Number(await baseRpc().getTransactionCount(ethers.getAddress(address), "latest")); }
/// The Base receipt of a hash: { status: 1|0 } or null when not (yet) mined.
export async function baseReceipt(hash) {
  const rc = await baseRpc().getTransactionReceipt(hash);
  return rc ? { status: rc.status, hash: rc.hash, blockNumber: rc.blockNumber } : null;
}
/// Plain USDC transfer from the ops wallet (funding a treasury from operations).
export async function sendUsdcFromOps(signer, to, micros) {
  const usdc = new ethers.Contract(USDC_BASE, USDC_ABI, signer);
  const tx = await usdc.transfer(ethers.getAddress(to), BigInt(micros));
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error("USDC transfer reverted");
  return rc.hash;
}
