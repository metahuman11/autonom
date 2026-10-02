// Trusted server-side transport, deliberately disconnected from routes, stores,
// environment variables, wallets and signing. No operation creates an order or
// submits a payment. An unsigned preparation is not payment or fulfillment.
// Official contract checked 2026-09-17:
// https://docs.hel.io/docs/headless-payments
// https://docs.hel.io/reference/transaction/headless/prepare
// https://docs.hel.io/docs/agent-payments/x402 (public Pay Link lookup)
const API = 'https://api.hel.io';
const ORIGIN = 'https://marketplace.dexscreener.com';
const MAX_RESPONSE_BYTES = 131_072;
const USDC_ID = '6340313846e4f91b8abc519b';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AMOUNT = 299_000_000;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const inspect = Symbol.for('nodejs.util.inspect.custom');
const localErrors = new WeakSet();
const fail = (code, message, status = 502) => {
  const error = Object.assign(new Error(message), {code, status}); localErrors.add(error); return error;
};
const invalid = message => fail('helio_invalid_input', message, 400);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));
const text = (x, max = 256) => typeof x === 'string' && x.length > 0 && x.length <= max && x === x.trim() && !/[\u0000-\u001f\u007f]/.test(x);

function publicKeyBytes(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw invalid('A valid Solana public key is required');
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes = [];
  while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of value) { if (c !== '1') break; bytes.unshift(0); }
  if (bytes.length !== 32) throw invalid('A valid Solana public key is required');
  return Buffer.from(bytes);
}

function tokenAddress(chain, address) {
  if (chain === 'solana') { publicKeyBytes(address); return address; }
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw invalid('Invalid target token address');
  return address.toLowerCase();
}

function orderSnapshot(order) {
  if (!exact(order, ['id', 'orderNumber', 'paylinkId', 'targetChain', 'targetTokenAddress', 'paymentChain', 'amountMicros', 'bindingEvidence']) ||
      !text(order.id, 128) || !/^[a-zA-Z0-9_-]+$/.test(order.id) ||
      typeof order.orderNumber !== 'string' || !/^[1-9][0-9]{0,19}$/.test(order.orderNumber) ||
      typeof order.paylinkId !== 'string' || !/^[a-f0-9]{24}$/.test(order.paylinkId) ||
      typeof order.targetChain !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(order.targetChain) ||
      order.paymentChain !== 'solana' || order.amountMicros !== AMOUNT) throw invalid('Invalid trusted Enhanced Token Info order');
  const target = tokenAddress(order.targetChain, order.targetTokenAddress);
  const evidence = order.bindingEvidence;
  if (!exact(evidence, ['source', 'orderId', 'orderNumber', 'paylinkId', 'tokenChain', 'tokenAddress']) ||
      evidence.source !== 'dexscreener-marketplace' || evidence.orderId !== order.id ||
      evidence.orderNumber !== order.orderNumber || evidence.paylinkId !== order.paylinkId ||
      evidence.tokenChain !== order.targetChain || tokenAddress(evidence.tokenChain, evidence.tokenAddress) !== target)
    throw invalid('Trusted order-to-token binding evidence is required');
  // These consistency checks cannot authenticate evidence supplied by a holder
  // or model. Only trusted order discovery may construct this object.
  return Object.freeze({id: order.id, orderNumber: order.orderNumber, paylinkId: order.paylinkId,
    targetChain: order.targetChain, targetTokenAddress: target, paymentChain: 'solana', amountMicros: AMOUNT});
}

function customerSnapshot(details) {
  const fields = ['fullName', 'email', 'country', 'deliveryAddress', 'state', 'city', 'street', 'streetNumber', 'areaCode', 'phoneNumber', 'additionalJSON'];
  if (!exact(details, fields)) throw invalid('Structured customer details are required');
  for (const field of ['fullName', 'email', 'country', 'deliveryAddress']) {
    if (!text(details[field], field === 'deliveryAddress' ? 1024 : 254)) throw invalid('Required customer details are missing');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email) || !/^[A-Z]{2}$/.test(details.country)) throw invalid('Invalid customer email or country');
  const result = {};
  for (const field of fields) {
    if (details[field] === undefined) continue;
    if (!text(details[field], field === 'additionalJSON' ? 4096 : field === 'deliveryAddress' ? 1024 : 254)) throw invalid('Invalid customer details');
    result[field] = details[field];
  }
  if (result.additionalJSON !== undefined) {
    let extra;
    try { extra = JSON.parse(result.additionalJSON); } catch { throw invalid('Customer metadata must be a JSON object string'); }
    if (!plain(extra)) throw invalid('Customer metadata must be a JSON object string');
    result.additionalJSON = JSON.stringify(extra);
  }
  return Object.freeze(result);
}

function canonicalCurrency(currency) {
  return plain(currency) && currency.id === USDC_ID && currency.symbol === 'USDC' && currency.decimals === 6 &&
    currency.mintAddress === USDC_MINT && currency.blockchain?.symbol === 'SOL' && currency.blockchain?.engine?.type === 'SOL';
}

function verifyPaylink(order, link) {
  if (!plain(link) || link.id !== order.paylinkId || link.name !== `#${order.orderNumber} - Enhanced Token Info` ||
      link.price !== String(AMOUNT) || link.dynamic !== false || link.disabled !== false || link.inactive !== false ||
      link.deleted === true || link.maxTransactions !== 1 || !canonicalCurrency(link.currency) || !canonicalCurrency(link.pricingCurrency))
    throw fail('helio_order_mismatch', 'Pay Link does not match the active fixed-price order');
  const f = link.features;
  if (!plain(f) || f.canChangePrice !== false || f.canChangeQuantity !== false || f.requireMaxTransactions !== true ||
      f.isSubscription !== false || f.isEscrowed === true || f.splitRevenue === true || f.nftDropEnabled === true ||
      Object.entries(f).some(([k, v]) => k.startsWith('require') && (typeof v !== 'boolean' || (v !== false &&
        !['requireCountry', 'requireEmail', 'requireDeliveryAddress', 'requireFullName', 'requirePhoneNumber', 'requireMaxTransactions'].includes(k)))))
    throw fail('helio_unsupported_checkout', 'Pay Link requires an unsupported checkout flow');
  return {order, requiresPhoneNumber: f.requirePhoneNumber === true};
}

function boundedBase64(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw fail('helio_invalid_response', 'Helio returned an invalid unsigned transaction');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64') !== value)
    throw fail('helio_invalid_response', 'Helio returned an invalid unsigned transaction');
  return bytes;
}

function preparedResult(order, payerPublicKey, reply) {
  if (!plain(reply) || !text(reply.transactionToken, 8192) || !text(reply.transactionMessage, 16384) ||
      !Array.isArray(reply.addressLookupTableAccounts) || reply.addressLookupTableAccounts.length > 16)
    throw fail('helio_invalid_response', 'Helio returned an incomplete unsigned preparation');
  const bytes = boundedBase64(reply.serializedTransaction, 100, 1232);
  // Solana's packet limit makes >= 128 signature slots impossible. Check the
  // entire signature region, without claiming to inspect instruction semantics.
  const signatures = bytes[0];
  if (signatures < 1 || signatures > 16 || 1 + signatures * 64 + 4 >= bytes.length ||
      bytes.subarray(1, 1 + signatures * 64).some(b => b !== 0))
    throw fail('helio_invalid_response', 'Helio preparation must contain only unsigned signature slots');
  if ((reply.minimalUnitAmount !== undefined && String(reply.minimalUnitAmount) !== String(AMOUNT)) ||
      (reply.decimalAmount !== undefined && ![299, '299', '299.000000'].includes(reply.decimalAmount)) ||
      (reply.blockchainSymbol !== undefined && reply.blockchainSymbol !== 'SOL') ||
      (reply.currencyHelioId !== undefined && reply.currencyHelioId !== USDC_ID))
    throw fail('helio_order_mismatch', 'Prepared payment metadata does not match the verified order');
  // Table content is opaque provider data, bounded here and independently
  // decoded/resolved by the trusted transaction inspector before any signing.
  for (const table of reply.addressLookupTableAccounts) {
    if (!(text(table, 32768) || plain(table))) throw fail('helio_invalid_response', 'Invalid lookup table data');
  }
  const prepared = Object.freeze({serializedTransaction: reply.serializedTransaction, transactionMessage: reply.transactionMessage,
    addressLookupTableAccounts: JSON.parse(JSON.stringify(reply.addressLookupTableAccounts))});
  const result = {...order, payerPublicKey, currencyId: USDC_ID, currency: 'USDC', mint: USDC_MINT,
    state: 'unsigned_prepared', paymentVerified: false, fulfillmentVerified: false, prepared};
  // An explicit trusted consumer can access result.transactionToken. Ordinary
  // serialization, object spread and console inspection omit the capability.
  // Never return the private result directly from an HTTP/agent route.
  Object.defineProperty(result, 'transactionToken', {value: reply.transactionToken, enumerable: false});
  Object.defineProperty(result, inspect, {value: () => ({...result, prepared: '[unsigned preparation]', transactionToken: '[REDACTED]'})});
  return Object.freeze(result);
}

/**
 * Explicit transport injection is required; constructing this client never
 * enables live integration. The caller must enforce approval, durable attempt
 * locking and reconciliation. No request is retried, including failed prepares.
 *
 * order: {id, orderNumber, paylinkId, targetChain, targetTokenAddress,
 *   paymentChain:'solana', amountMicros:299000000,
 *   bindingEvidence:{source:'dexscreener-marketplace', orderId, orderNumber,
 *     paylinkId, tokenChain, tokenAddress}}
 * All order/evidence fields come from trusted server-side order discovery.
 * prepareUnsigned requires injected customerDetails and payerPublicKey; it
 * always fetches and re-verifies the Pay Link immediately before its one POST.
 *
 * Offline next stage (explicit import; not automatically enabled here):
 * reviewHelioDexUnsigned({preparation: result, trustedIntent,
 *   finalizedLookupTables}) from ./helio-dex-validator.mjs accepts this exact
 * private result. Supply independent trusted merchant/memo/fee policy and
 * finalized ALT snapshots; never recycle result.prepared provider ALT data.
 * That review always returns signingAllowed:false and unresolved external
 * checks. Neither this transport nor that review is a queue payOrder adapter.
 */
export function createHelioDexCheckoutClient({fetchImpl, timeoutMs = 10_000} = {}) {
  if (typeof fetchImpl !== 'function') throw invalid('An explicit trusted HTTP transport is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw invalid('Invalid HTTP timeout');
  async function request(path, body) {
    const controller = new AbortController();
    let reader;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(fail('helio_request_uncertain', 'Helio request timed out; do not automatically repeat preparation'));
      controller.signal.addEventListener('abort', abortListener, {once: true});
    });
    const operation = (async () => {
      const response = await fetchImpl(API + path, {method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        credentials: 'omit', headers: {Accept: 'application/json', Origin: ORIGIN, ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
      if (controller.signal.aborted) throw fail('helio_request_uncertain', 'Helio request timed out; do not automatically repeat preparation');
      if (!response.ok || response.redirected) throw fail('helio_provider_rejected', 'Helio request was not accepted');
      const length = response.headers.get('content-length');
      if ((length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''))
        throw fail('helio_invalid_response', 'Helio returned an invalid response');
      if (!response.body || typeof response.body.getReader !== 'function') throw fail('helio_invalid_response', 'Helio returned an invalid response');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw fail('helio_invalid_response', 'Helio response exceeded its size limit');
        chunks.push(value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
      catch { throw fail('helio_invalid_response', 'Helio returned invalid JSON'); }
    })();
    try { return await Promise.race([operation, aborted]); }
    catch (error) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      // No provider body, thrown transport message, customer data or token is
      // copied into errors. Only errors made by this module are surfaced.
      if (localErrors.has(error)) throw error;
      throw fail('helio_request_uncertain', 'Helio request failed; do not automatically repeat preparation');
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abortListener); }
  }
  const fetchVerified = async order => verifyPaylink(order, await request(`/v1/paylink/${order.paylinkId}/public?platform=HELIO`));
  return Object.freeze({
    async verifyOrder(order) {
      const snapshot = orderSnapshot(order);
      await fetchVerified(snapshot);
      return Object.freeze({...snapshot, currency: 'USDC', currencyId: USDC_ID, mint: USDC_MINT, state: 'order_verified', paymentVerified: false, fulfillmentVerified: false});
    },
    async prepareUnsigned({order, payerPublicKey, customerDetails} = {}) {
      const snapshot = orderSnapshot(order);
      publicKeyBytes(payerPublicKey);
      const customer = customerSnapshot(customerDetails);
      const verified = await fetchVerified(snapshot);
      if (verified.requiresPhoneNumber && !customer.phoneNumber) throw invalid('Customer phone number is required by this checkout');
      const reply = await request('/v1/transaction/headless/prepare', {paymentRequestId: snapshot.paylinkId,
        senderPublicKey: payerPublicKey, currencyId: USDC_ID, quantity: 1, customerDetails: customer});
      return preparedResult(snapshot, payerPublicKey, reply);
    },
  });
}
