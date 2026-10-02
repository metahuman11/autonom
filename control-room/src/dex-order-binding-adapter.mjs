// Local consistency boundary, NOT authenticated marketplace discovery or payment authority.
// No app/store/env/wallet imports. DEX order creation still requires the supported
// authenticated marketplace flow; no undocumented provider endpoint is invented here.
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {isAddress} from '@solana/addresses';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = () => { throw Object.assign(new Error('DEX project, listing or asset binding is invalid'), {code:'dex_binding_invalid'}); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export function dexTarget(chain, address) {
  if (!text(chain, 32) || !/^[a-z][a-z0-9-]+$/.test(chain)) fail();
  if (chain === 'solana') { if (!isAddress(address)) fail(); return address; }
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail();
  return address.toLowerCase();
}
function linksOf(links) {
  if (!Array.isArray(links) || links.length > 12) fail();
  const normalized = links.map(link => {
    if (!plain(link) || Object.keys(link).some(k => !['type','label','url'].includes(k)) || !text(link.url, 2048)) fail();
    let url; try { url = new URL(link.url); } catch { fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) fail();
    const result = {url:url.href};
    for (const field of ['type','label']) if (link[field] != null) { if (!text(link[field], 80)) fail(); result[field] = link[field]; }
    return result;
  }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (new Set(normalized.map(x => x.url)).size !== normalized.length) fail();
  return normalized;
}
export async function inspectDexRaster(bytes, {banner = false} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.length > 2_000_000) fail();
  try {
    const image = sharp(bytes, {limitInputPixels:4_194_304, animated:false});
    const meta = await image.metadata();
    if (!['png','jpeg','webp'].includes(meta.format) || (meta.pages ?? 1) !== 1 ||
        !Number.isInteger(meta.width) || !Number.isInteger(meta.height) ||
        meta.width < 1 || meta.height < 1 || meta.width > 2048 || meta.height > 2048 ||
        (banner && (meta.format !== 'png' || meta.width !== 600 || meta.height !== 200))) fail();
    const pixels = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer();
    return freeze({sha256:hash(bytes), pixelSha256:hash(Buffer.concat([Buffer.from(`${meta.width}x${meta.height}:rgba:`), pixels])),
      width:meta.width, height:meta.height, byteLength:bytes.length});
  } catch { fail(); }
}
const contentOf = input => {
  if (!plain(input) || !text(input.description, 1000)) fail();
  return {chain:input.chain, tokenAddress:dexTarget(input.chain, input.tokenAddress), description:input.description, links:linksOf(input.links)};
};
export async function createDexListingBinding({chain, tokenAddress, description, links, bannerPng, logoImage} = {}) {
  const content = contentOf({chain,tokenAddress,description,links});
  const [banner,logo] = await Promise.all([inspectDexRaster(bannerPng,{banner:true}), inspectDexRaster(logoImage)]);
  const binding = {schemaVersion:1, ...content, banner, logo};
  return freeze({...binding, listingSha256:hash(JSON.stringify(binding))});
}
export function validateDexListingBinding(value) {
  if (!plain(value) || value.schemaVersion !== 1 || !digest(value.listingSha256) ||
      Object.keys(value).some(k => !['schemaVersion','chain','tokenAddress','description','links','banner','logo','listingSha256'].includes(k))) fail();
  const content = contentOf(value), assets = {};
  for (const role of ['banner','logo']) {
    const asset = value[role];
    if (!plain(asset) || Object.keys(asset).length !== 5 || !digest(asset.sha256) || !digest(asset.pixelSha256) ||
        !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1 ||
        asset.width > 2048 || asset.height > 2048 || !Number.isInteger(asset.byteLength) || asset.byteLength < 20 || asset.byteLength > 2_000_000 ||
        (role === 'banner' && (asset.width !== 600 || asset.height !== 200))) fail();
    assets[role] = {sha256:asset.sha256,pixelSha256:asset.pixelSha256,width:asset.width,height:asset.height,byteLength:asset.byteLength};
  }
  const snapshot = {schemaVersion:1,...content,...assets};
  if (hash(JSON.stringify(snapshot)) !== value.listingSha256) fail();
  return freeze({...snapshot,listingSha256:value.listingSha256});
}
export function dexProfileContentMatches(binding, profile) {
  try { return JSON.stringify(contentOf({chain:profile.chainId,tokenAddress:profile.tokenAddress,description:profile.description,links:profile.links})) ===
    JSON.stringify(contentOf(validateDexListingBinding(binding))); } catch { return false; }
}
/** The evidence must be captured by a trusted private marketplace operator/runner.
 * Matching hashes authenticate neither that operator nor the provider. Do not
 * expose this as an agent/holder route or treat its output as payment permission.
 * The returned order shape fits createHelioDexCheckoutClient.verifyOrder.
 */
export function bindDexMarketplaceOrder({listingBinding, evidence} = {}) {
  const binding = validateDexListingBinding(listingBinding);
  if (!plain(evidence) || evidence.source !== 'dexscreener-marketplace' ||
      !text(evidence.orderId,128) || !/^[a-zA-Z0-9_-]+$/.test(evidence.orderId) ||
      typeof evidence.orderNumber !== 'string' || !/^[1-9][0-9]{0,19}$/.test(evidence.orderNumber) ||
      typeof evidence.paylinkId !== 'string' || !/^[a-f0-9]{24}$/.test(evidence.paylinkId) ||
      evidence.chain !== binding.chain || dexTarget(evidence.chain,evidence.tokenAddress) !== binding.tokenAddress ||
      evidence.listingSha256 !== binding.listingSha256 || evidence.bannerSha256 !== binding.banner.sha256 ||
      evidence.logoSha256 !== binding.logo.sha256 || evidence.amountMicros !== 299_000_000 || evidence.paymentChain !== 'solana') fail();
  const order = {id:evidence.orderId,orderNumber:evidence.orderNumber,paylinkId:evidence.paylinkId,
    targetChain:binding.chain,targetTokenAddress:binding.tokenAddress,paymentChain:'solana',amountMicros:299_000_000,
    bindingEvidence:{source:'dexscreener-marketplace',orderId:evidence.orderId,orderNumber:evidence.orderNumber,
      paylinkId:evidence.paylinkId,tokenChain:binding.chain,tokenAddress:binding.tokenAddress}};
  return freeze({order,listingSha256:binding.listingSha256,bindingConsistent:true,authenticationVerified:false,
    signingAllowed:false,paymentVerified:false,publicationVerified:false});
}
