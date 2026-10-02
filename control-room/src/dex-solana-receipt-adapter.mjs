// Independent, read-only receipt observation for an ALREADY reviewed/submitted
// transaction. Never signs, broadcasts, creates an order, or releases a reserve.
// https://solana.com/docs/rpc/http/getgenesishash
// https://solana.com/docs/rpc/http/getsignaturestatuses
// https://solana.com/docs/rpc/http/gettransaction
import {createHash} from 'node:crypto';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/transactions';
import {getCompiledTransactionMessageDecoder} from '@solana/transaction-messages';
import {isAddress} from '@solana/addresses';
import {createDexEvidenceTransport} from './dex-evidence-http-adapter.mjs';
import {dexTarget} from './dex-order-binding-adapter.mjs';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEE_OWNERS = ['FudPMePeNqmnjMX19zEKDfGXpbp6HAdW6ZGprB5gYRTZ','JBGUGPmKUEHCpxGGoMowQxoV4c7HyqxEnyrznVPxftqk'];
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = () => { throw Object.assign(new Error('Finalized DEX receipt does not match the reviewed transaction'),{code:'dex_receipt_mismatch'}); };
const integer = x => Number.isSafeInteger(x) && x >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) fail();
  let n = 0n; for (const c of value) n = n*58n+BigInt(alphabet.indexOf(c));
  const bytes = []; while (n) { bytes.unshift(Number(n&255n)); n >>= 8n; }
  for (const c of value) { if (c !== '1') break; bytes.unshift(0); }
  if (bytes.length !== 64 || !bytes.some(x => x !== 0)) fail(); return Buffer.from(bytes);
}
function intentOf(review, maxNativeDebitLamports) {
  if (!review || review.state !== 'static_review_passed' || review.signingAllowed !== false || review.paymentVerified !== false ||
      review.paymentChain !== 'solana' || review.paymentCluster !== 'mainnet-beta' || review.amountMicros !== 299_000_000 ||
      review.mint !== MINT || typeof review.orderId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(review.orderId) ||
      !/^[a-f0-9]{24}$/.test(review.paylinkId) || !/^[a-f0-9]{64}$/.test(review.messageSha256) ||
      !isAddress(review.payerPublicKey) || !isAddress(review.recipientPublicKey) || review.payerPublicKey === review.recipientPublicKey ||
      !integer(review.finalizedLookupContextSlot) || review.finalizedLookupContextSlot < 1 ||
      !integer(maxNativeDebitLamports) || maxNativeDebitLamports < 1 || maxNativeDebitLamports > 10_000_000) fail();
  return Object.freeze({orderId:review.orderId,paylinkId:review.paylinkId,targetChain:review.targetChain,
    targetTokenAddress:dexTarget(review.targetChain,review.targetTokenAddress),payer:review.payerPublicKey,
    recipient:review.recipientPublicKey,messageSha256:review.messageSha256,minSlot:review.finalizedLookupContextSlot,maxNativeDebitLamports});
}
function tokenBalances(rows, accountCount, owners) {
  if (!Array.isArray(rows) || rows.length > 32) fail();
  const result = new Map();
  for (const row of rows) {
    if (!row || !integer(row.accountIndex) || row.accountIndex >= accountCount || result.has(row.accountIndex) ||
        row.mint !== MINT || row.programId !== TOKEN || !owners.includes(row.owner) || row.uiTokenAmount?.decimals !== 6 ||
        typeof row.uiTokenAmount.amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(row.uiTokenAmount.amount)) fail();
    const amount = BigInt(row.uiTokenAmount.amount); if (amount > (1n<<64n)-1n) fail();
    result.set(row.accountIndex,{owner:row.owner,amount});
  }
  return result;
}
export function createDexSolanaReceiptAdapter({fetchImpl,rpcUrl,timeoutMs} = {}) {
  // RPC choice is an operator configuration, not an agent/holder input. This
  // module requires explicit HTTPS and pins the returned mainnet genesis hash.
  let endpoint; try { endpoint = new URL(rpcUrl); } catch { fail(); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) fail();
  const request = createDexEvidenceTransport({fetchImpl,timeoutMs});
  let requestId = 0;
  const rpc = async (method,params) => {
    const id = ++requestId, response = await request(endpoint.href,{rpcBody:{jsonrpc:'2.0',id,method,params}});
    if (!response || response.jsonrpc !== '2.0' || response.id !== id || response.error || !Object.hasOwn(response,'result')) fail();
    return response.result;
  };
  return Object.freeze({
    /** trustedReview is the persisted result of reviewHelioDexUnsigned, supplied
     * by protected operator code, never accepted from public JSON. A matching
     * receipt does not resolve merchant/program review or source bridge accounting.
     */
    async observe({trustedReview,signature,maxNativeDebitLamports} = {}) {
      const intent = intentOf(trustedReview,maxNativeDebitLamports), expectedSignature = signatureBytes(signature);
      if (await rpc('getGenesisHash',[]) !== GENESIS) fail();
      const statuses = await rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);
      if (!statuses || !integer(statuses.context?.slot) || !Array.isArray(statuses.value) || statuses.value.length !== 1) fail();
      const status = statuses.value[0];
      const pending = Object.freeze({state:'not_finalized',receiptVerified:false,paymentVerified:false,publicationVerified:false,orderId:intent.orderId});
      if (status === null) return pending;
      if (!status || !integer(status.slot) || status.slot < intent.minSlot || status.slot > statuses.context.slot) fail();
      if (status.err !== null) return Object.freeze({...pending,state:'transaction_failed'});
      if (status.confirmationStatus !== 'finalized') return pending;
      const tx = await rpc('getTransaction',[signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
      if (tx === null) return pending;
      if (!tx || tx.slot !== status.slot || tx.meta?.err !== null || !integer(tx.blockTime) || tx.blockTime < 1 ||
          !Array.isArray(tx.transaction) || tx.transaction.length !== 2 || tx.transaction[1] !== 'base64' ||
          typeof tx.transaction[0] !== 'string' || tx.transaction[0].length > 1644) fail();
      const bytes = Buffer.from(tx.transaction[0],'base64');
      if (bytes.toString('base64') !== tx.transaction[0] || bytes.length < 100 || bytes.length > 1232 || bytes[0] !== 1 ||
          !bytes.subarray(1,65).equals(expectedSignature)) fail();
      let decoded,message;
      try { decoded = getTransactionDecoder().decode(bytes); message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes); }
      catch { fail(); }
      if (!Buffer.from(getTransactionEncoder().encode(decoded)).equals(bytes) || sha(decoded.messageBytes) !== intent.messageSha256 ||
          message.staticAccounts[0] !== intent.payer || message.header.numSignerAccounts !== 1 ||
          !['legacy',0].includes(message.version) || tx.version !== message.version) fail();
      const loaded = tx.meta.loadedAddresses || {writable:[],readonly:[]};
      if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly) ||
          [...loaded.writable,...loaded.readonly].some(x => !isAddress(x))) fail();
      const accountCount = message.staticAccounts.length + loaded.writable.length + loaded.readonly.length;
      const pre = tx.meta.preBalances, post = tx.meta.postBalances;
      if (accountCount > 32 || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== accountCount || post.length !== accountCount ||
          !integer(pre[0]) || !integer(post[0]) || !integer(tx.meta.fee) || tx.meta.fee < 1) fail();
      const nativeDebit = pre[0]-post[0];
      if (nativeDebit < tx.meta.fee || nativeDebit > intent.maxNativeDebitLamports) fail();
      const owners = [intent.payer,intent.recipient,...FEE_OWNERS];
      const before = tokenBalances(tx.meta.preTokenBalances,accountCount,owners), after = tokenBalances(tx.meta.postTokenBalances,accountCount,owners);
      // Missing balance metadata is unknown. This first version deliberately
      // rejects token-account creation/closure rather than inventing zero balances.
      if (before.size !== after.size || before.size < 2) fail();
      const changes = new Map(owners.map(owner => [owner,0n]));
      for (const [index,old] of before) {
        const current = after.get(index); if (!current || current.owner !== old.owner) fail();
        changes.set(old.owner,changes.get(old.owner)+current.amount-old.amount);
      }
      const debit = -changes.get(intent.payer), credit = changes.get(intent.recipient);
      if ([...changes.values()].reduce((a,b) => a+b,0n) !== 0n || debit < 299_000_000n || debit > 300_000_000n ||
          credit <= 0n || credit > debit || FEE_OWNERS.some(owner => changes.get(owner) < 0n)) fail();
      return Object.freeze({state:'finalized_receipt_observed',receiptVerified:true,paymentVerified:false,publicationVerified:false,
        sourceBalanceReconciled:false,orderId:intent.orderId,paylinkId:intent.paylinkId,targetChain:intent.targetChain,
        targetTokenAddress:intent.targetTokenAddress,paymentReference:signature,slot:tx.slot,
        paidAt:new Date(tx.blockTime*1000).toISOString(),messageSha256:intent.messageSha256,
        observedPayerDebitMicros:Number(debit),observedMerchantCreditMicros:Number(credit),nativeDebitLamports:nativeDebit,
        networkFeeLamports:tx.meta.fee,requiredChecks:Object.freeze(['authenticated_order_merchant_and_fee_semantics',
          'source_treasury_post_debit_reconciliation','exact_listing_publication'])});
    },
  });
}
