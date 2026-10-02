// vast.ai stock: every rentable offer, refreshed each minute and the moment one is
// rented by us, so the picker only shows machines that are still available. Ranks are
// what the unlock threshold uses ("how expensive is this machine among all of them").
import { searchOffers, vastKeyConfigured } from "./vast.mjs";
import { env } from "./env.mjs";

// Only these GPU classes are offered to projects (owner decision 2026-09-21: RTX 5090
// only). VAST_GPU_ALLOWLIST is a comma-separated list of exact vast gpu_name values;
// "*" offers the whole stock. Single-GPU machines only — the desktop/stream runtime
// uses one card, so multi-GPU listings of the same class are hidden as well.
// The sample stock (no provider key) is never filtered, so simulations keep working.
export function allowedGpu(gpu, allow = env("VAST_GPU_ALLOWLIST", "RTX 5090")) {
  if (String(allow).trim() === "*") return true;
  const names = String(allow).split(",").map((s) => s.trim()).filter(Boolean);
  return names.some((n) => gpu === `1x ${n}`);
}

const TTL_MS = 60_000;
let cache = { at: 0, offers: [], error: null, source: null };
let inflight = null;
let nextRetryAt = 0, failures = 0;

/// The current stock (cached ≤ 60 s). `force` refreshes now.
export async function inventory({ force = false } = {}) {
  // Even a forced refresh must respect a failed-read cooldown. Keep the last
  // successful timestamp honest; an old offer still needs a fresh purchase quote.
  if (Date.now() < nextRetryAt) return cache;
  if (!force && Date.now() - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const stock = await searchOffers({ gpuName: "", ramGb: 0, maxDph: 1000, minUploadMbps: 0, minCuda: 0, limit: 2000 });   // vast returns the whole stock (~1000) under this
      const offers = vastKeyConfigured() ? stock.filter((o) => allowedGpu(o.gpu)) : stock;
      offers.sort((a, b) => a.dph - b.dph);
      cache = { at: Date.now(), offers, error: null, source: vastKeyConfigured() ? "vast" : "sample" };
      failures = 0; nextRetryAt = 0;
    } catch (e) {
      failures++;
      nextRetryAt = Date.now() + Math.max(Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)), Number(e.providerRetryAfterMs) || 0);
      cache = { ...cache, error: e.message, nextRetryAt, stale: true };
    } finally { inflight = null; }
    return cache;
  })();
  return inflight;
}

/// Drops an offer from the stock immediately (we just rented it, or it vanished).
export function markGone(offerId) {
  cache = { ...cache, offers: cache.offers.filter((o) => o.id !== offerId) };
}

/// Offer by id, from the stock (null when it is gone).
export function offerById(offerId) {
  return cache.offers.find((o) => o.id === offerId) || null;
}

/// GPU classes in stock: [{gpu, count, minDph, maxDph}], most common first.
export function gpuClasses(offers = cache.offers) {
  const m = new Map();
  for (const o of offers) {
    const g = m.get(o.gpu) || { gpu: o.gpu, count: 0, minDph: Infinity, maxDph: 0 };
    g.count++; g.minDph = Math.min(g.minDph, o.dph); g.maxDph = Math.max(g.maxDph, o.dph);
    m.set(o.gpu, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.minDph - b.minDph);
}

/// 0 for the cheapest machine in stock, 1 for the most expensive.
export function dphRank(dph, offers = cache.offers) {
  const prices = offers.map((o) => o.dph).filter((p) => p > 0);
  if (prices.length < 2) return 0.5;
  const cheaper = prices.filter((p) => p < dph).length;
  return Math.min(1, cheaper / (prices.length - 1));
}
