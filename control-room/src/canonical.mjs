// Canonical JSON (RFC 8785 style: object keys sorted by UTF-16 code units, no
// whitespace, integers only) and the EIP-191 helpers every signed envelope uses.
// The agent prompt requires the signer and the site to agree byte for byte.
import { ethers } from "ethers";

export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported type in canonical JSON: ${typeof value}`);
}

export const payloadHash = (payload) => ethers.keccak256(ethers.toUtf8Bytes(canonicalize(payload)));

/// Recovers the signer of an EIP-191 personal_sign over the canonical payload.
export function recoverSigner(payload, signature) {
  return ethers.getAddress(ethers.verifyMessage(canonicalize(payload), signature));
}

export const nonce = () => ethers.hexlify(ethers.randomBytes(16));
export const nowIso = () => new Date().toISOString();
