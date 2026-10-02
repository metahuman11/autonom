// The platform's own coin (owner 2026-10-02: "8tyaSHgK…meta bu bizim official token"): marked on the
// home cards, the project page and the top navigation. Overridable without a code change via .env.
import { env } from "./env.mjs";
export const OFFICIAL_MINT = env("AUTONOM_OFFICIAL_MINT", "8tyaSHgK5HEi42qHvUwpWKE9t4NCyGxutLV8hACameta");
export const isOfficialToken = (t) => !!t && String(t.address) === OFFICIAL_MINT;
// The official coin shows Autonom's own X account (owner 2026-10-02: "sadece Twitter'ı silip @autonompf ekleyelim"),
// not a pool account; chat-driven posting is off for it (the team runs that account).
export const OFFICIAL_X_HANDLE = env("AUTONOM_OFFICIAL_X", "AutonomPF");
export const OFFICIAL_X_USER_ID = env("AUTONOM_OFFICIAL_X_ID", "2105953544184508417");
export const officialXAccount = () => ({ handle: OFFICIAL_X_HANDLE, url: `https://x.com/${OFFICIAL_X_HANDLE}`, userId: OFFICIAL_X_USER_ID, assignedAt: null, official: true, managedBy: "Autonom team" });
export const officialTokenPublic = (t) => ({ mint: OFFICIAL_MINT, symbol: t?.symbol ?? "AUTONOM", name: t?.name ?? "Autonom.fun", channel: `/t/${OFFICIAL_MINT}`, pump: `https://pump.fun/coin/${OFFICIAL_MINT}`, listed: !!t });
