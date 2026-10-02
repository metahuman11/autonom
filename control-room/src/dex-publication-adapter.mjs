// Official read-only APIs checked 2026-09-20:
// https://docs.dexscreener.com/api/reference
// The latest/recent feeds are incomplete history. Absence is UNKNOWN, never
// permission to create/retry an order. Public orders do not expose our order ID.
import {createDexEvidenceTransport} from './dex-evidence-http-adapter.mjs';
import {validateDexListingBinding,dexTarget,dexProfileContentMatches,inspectDexRaster} from './dex-order-binding-adapter.mjs';
const API = 'https://api.dexscreener.com';
const fail = () => { throw Object.assign(new Error('DEX public evidence has an unsupported shape'),{code:'dex_public_evidence_invalid'}); };
const assetUrl = value => {
  let url; try { url = new URL(value); } catch { fail(); }
  if (url.origin !== 'https://cdn.dexscreener.com' || url.username || url.password || url.hash ||
      !/^\/cms\/images\/[a-zA-Z0-9_-]{1,128}$/.test(url.pathname)) fail();
  return url.href;
};
const list = value => { const result = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
  if (!result || result.length > 1000 || result.some(x => !x || typeof x !== 'object' || Array.isArray(x))) fail(); return result; };
export function createDexPublicationAdapter(options = {}) {
  const request = createDexEvidenceTransport(options);
  return Object.freeze({
    async observe({listingBinding} = {}) {
      const binding = validateDexListingBinding(listingBinding);
      const path = `${encodeURIComponent(binding.chain)}/${encodeURIComponent(binding.tokenAddress)}`;
      const [rawOrders,latest,recent] = await Promise.all([
        request(`${API}/orders/v1/${path}`),request(`${API}/token-profiles/latest/v1`),request(`${API}/token-profiles/recent-updates/v1`)]);
      // Public API documentation describes an array; current public responses
      // may wrap it in {orders,boosts}. No other response shape is accepted.
      const orderRows = Array.isArray(rawOrders) ? rawOrders : rawOrders?.orders;
      if (!Array.isArray(orderRows) || orderRows.length > 1000) fail();
      const orders = orderRows.map(row => {
        if (!row || typeof row !== 'object' ||
            !['tokenProfile','communityTakeover','tokenAd','trendingBarAd'].includes(row.type) ||
            !['processing','cancelled','on-hold','approved','rejected'].includes(row.status) ||
            !Number.isSafeInteger(row.paymentTimestamp) || row.paymentTimestamp < 0 ||
            (row.chainId !== undefined && row.chainId !== binding.chain) ||
            (row.tokenAddress !== undefined && dexTarget(binding.chain,row.tokenAddress) !== binding.tokenAddress)) fail();
        return Object.freeze({type:row.type,status:row.status,paymentTimestamp:row.paymentTimestamp});
      });
      const profiles = [...list(latest),...list(recent)].filter(row => {
        try { return row.chainId === binding.chain && dexTarget(row.chainId,row.tokenAddress) === binding.tokenAddress; } catch { return false; }
      });
      let publicationVerified = false;
      // Limit asset reads even if an upstream feed contains repeated entries.
      const seen = new Set();
      for (const profile of profiles.slice(0,8)) {
        if (!dexProfileContentMatches(binding,profile)) continue;
        const header = assetUrl(profile.header), icon = assetUrl(profile.icon), key = header+'|'+icon;
        if (seen.has(key)) continue; seen.add(key);
        const [headerBytes,iconBytes] = await Promise.all([request(header,{image:true}),request(icon,{image:true})]);
        const [banner,logo] = await Promise.all([inspectDexRaster(headerBytes),inspectDexRaster(iconBytes)]);
        // Pixel equality allows lossless recompression, never a merely similar
        // image or a pre-existing unrelated profile. Lossy/resized assets fail closed.
        if (banner.width === 600 && banner.height === 200 && banner.pixelSha256 === binding.banner.pixelSha256 &&
            logo.width === binding.logo.width && logo.height === binding.logo.height && logo.pixelSha256 === binding.logo.pixelSha256) {
          publicationVerified = true; break;
        }
      }
      return Object.freeze({chain:binding.chain,tokenAddress:binding.tokenAddress,listingSha256:binding.listingSha256,
        state:publicationVerified ? 'exact_listing_observed' : profiles.length ? 'listing_not_matched' : 'not_observed_in_recent_feeds',
        publicationVerified,paymentVerified:false,orderIdentityVerified:false,duplicateOrderSafe:false,
        orders:Object.freeze(orders),requiredChecks:Object.freeze(['authenticated_marketplace_order_identity','independent_finalized_payment_receipt','source_treasury_reconciliation'])});
    },
  });
}
