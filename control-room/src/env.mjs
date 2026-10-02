// Reads .env into a private object. Values are never logged or returned by any API;
// callers get only what they ask for by name.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const values = {};
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

export function env(name, fallback = "") {
  const v = process.env[name] ?? values[name];
  return v == null || v === "" ? fallback : v;
}

export const DATA_DIR = env("CONTROL_ROOM_DATA_DIR", join(ROOT, "data"));
