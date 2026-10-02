// Pure, offline review only. No RPC, fetch, environment, store, wallet or signer.
// A successful review is NOT payment authorization, simulation, or settlement.
import {createHash} from 'node:crypto';
import {getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isAddress, isOffCurveAddress} from '@solana/addresses';
import {getTransactionDecoder, getTransactionEncoder} from '@solana/transactions';
import {getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder} from '@solana/transaction-messages';

const C = Object.freeze({
  amountMicros: 299_000_000,
  currencyId: '6340313846e4f91b8abc519b',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  helioProgram: 'ENicYBBNZQ91toN7ggmTxnDGZW14uv9UkumN7XBGeYJ4',
  helioFeeOwner: 'FudPMePeNqmnjMX19zEKDfGXpbp6HAdW6ZGprB5gYRTZ',
  daoFeeOwner: 'JBGUGPmKUEHCpxGGoMowQxoV4c7HyqxEnyrznVPxftqk',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  systemProgram: '11111111111111111111111111111111',
  computeProgram: 'ComputeBudget111111111111111111111111111111',
  memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  lookupProgram: 'AddressLookupTab1e1111111111111111111111111',
});

// Exact published artifacts, not a moving GitHub branch or provider-supplied IDL.
// Package schema provenance does not attest deployed program bytecode/upgrade authority.
export const HELIO_DEX_REVIEW_PROVENANCE = Object.freeze({
  helioPackage: '@heliofi/solana-adapter@4.1.2',
  helioTarball: 'https://registry.npmjs.org/@heliofi/solana-adapter/-/solana-adapter-4.1.2.tgz',
  helioIntegrity: 'sha512-0aiTZjGiR4i/bSuWvy1xOo8idyBTGsoKncMMYD2n6VU5PMCwgA/gzxSMbO0NoVHEkkMi6hA4JgYEhzMJe1g9YQ==',
  idlMember: 'package/dist/src/helioProtocol.js',
  idlSha256: '401607619145d8aaa1b3511e9676e8e0807d949659e90760d3e677d305a6b842',
  feeConfigMember: 'package/dist/src/config.js',
  feeConfigSha256: '05dfe2ab72b9d2365d6369c6bc0e686ab51a5fd5e8af3588eba5c8285a067552',
  accountDerivationMember: 'package/dist/src/getSinglePaymentTx.js',
  accountDerivationSha256: 'da24bcf487b677180b54db0d622115de633afedd4a61b2533dc40fbe49bf008c',
  instruction: 'singlePayment(amount:u64,baseFee:u64,remainingAmounts:vec<u64>); 12 accounts; no splits',
  solanaCodecs: '6.5.0',
  lookupSchema: '@solana-program/address-lookup-table@0.14.1',
  lookupSource: 'https://github.com/solana-program/address-lookup-table/tree/e180ec24af8ea018ad71ec633cf640ede77c5fba',
  lookupRustSource: 'https://github.com/solana-program/address-lookup-table/blob/ac994f0976561fc2cb4b3e42458694e686273363/program/src/state.rs',
  lookupSchemaSha256: '8bf448b9e72ca10574c4372c989d2e41402f5ee73a5f972319122121ce2a9ab8',
});

const discriminator = Buffer.from([135, 168, 94, 207, 167, 43, 144, 221]);
const MAX_U64 = (1n << 64n) - 1n;
const ownErrors = new WeakSet();
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));
const reject = (code = 'helio_static_review_rejected') => {
  const error = Object.assign(new Error('Unsigned Helio payment did not pass restricted offline review'), {code});
  ownErrors.add(error); throw error;
};
const requireThat = condition => { if (!condition) reject(); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const publicKey = value => { requireThat(typeof value === 'string' && value.length <= 44 && isAddress(value)); return value; };

function unsignedInteger(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value));
  const result = BigInt(value); requireThat(result <= MAX_U64); return result;
}

function base64(value, minBytes, maxBytes) {
  requireThat(typeof value === 'string' && value.length <= Math.ceil(maxBytes / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  const bytes = Buffer.from(value, 'base64');
  requireThat(bytes.length >= minBytes && bytes.length <= maxBytes && bytes.toString('base64') === value);
  return bytes;
}

function snapshotIntent(intent, preparation) {
  requireThat(exact(intent, ['orderId', 'orderNumber', 'paylinkId', 'targetChain', 'targetTokenAddress', 'paymentChain',
    'paymentCluster', 'amountMicros', 'payerPublicKey', 'recipientPublicKey', 'baseFeeRaw', 'expectedMemo', 'feeLimits', 'finalizedSlot']));
  requireThat(boundedString(intent.orderId, 128) && /^[a-zA-Z0-9_-]+$/.test(intent.orderId) &&
    typeof intent.orderNumber === 'string' && /^[1-9][0-9]{0,19}$/.test(intent.orderNumber) &&
    typeof intent.paylinkId === 'string' && /^[a-f0-9]{24}$/.test(intent.paylinkId) &&
    typeof intent.targetChain === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(intent.targetChain) &&
    intent.paymentChain === 'solana' && intent.paymentCluster === 'mainnet-beta' && intent.amountMicros === C.amountMicros &&
    Number.isSafeInteger(intent.finalizedSlot) && intent.finalizedSlot > 0);
  const target = intent.targetChain === 'solana' ? publicKey(intent.targetTokenAddress) : intent.targetTokenAddress;
  requireThat(intent.targetChain === 'solana' || (typeof target === 'string' && /^0x[0-9a-f]{40}$/.test(target)));
  const payer = publicKey(intent.payerPublicKey), recipient = publicKey(intent.recipientPublicKey);
  requireThat(!isOffCurveAddress(payer) && payer !== recipient && !Object.values(C).includes(payer) && !Object.values(C).includes(recipient));
  requireThat(boundedString(intent.expectedMemo, 128));
  const memo = Buffer.from(intent.expectedMemo, 'utf8');
  requireThat(memo.length <= 128 && new TextDecoder('utf-8', {fatal: true}).decode(memo) === intent.expectedMemo);
  const fee = intent.feeLimits;
  requireThat(exact(fee, ['maxComputeUnitLimit', 'maxComputeUnitPriceMicroLamports', 'maxPriorityFeeLamports']) &&
    Number.isSafeInteger(fee.maxComputeUnitLimit) && fee.maxComputeUnitLimit >= 1 && fee.maxComputeUnitLimit <= 1_400_000);
  const maxPrice = unsignedInteger(fee.maxComputeUnitPriceMicroLamports), maxPriorityFee = unsignedInteger(fee.maxPriorityFeeLamports);
  // Hard additional ceiling: this narrow payment profile never accepts >0.001
  // SOL priority fee, even if a caller accidentally supplies a larger budget.
  requireThat(maxPriorityFee <= 1_000_000n);
  requireThat(plain(preparation) && preparation.id === intent.orderId && preparation.orderNumber === intent.orderNumber &&
    preparation.paylinkId === intent.paylinkId && preparation.targetChain === intent.targetChain &&
    preparation.targetTokenAddress === target && preparation.paymentChain === 'solana' &&
    preparation.amountMicros === C.amountMicros && preparation.payerPublicKey === payer &&
    preparation.currencyId === C.currencyId && preparation.currency === 'USDC' && preparation.mint === C.mint &&
    preparation.state === 'unsigned_prepared' && preparation.paymentVerified === false && preparation.fulfillmentVerified === false &&
    plain(preparation.prepared));
  return Object.freeze({orderId: intent.orderId, orderNumber: intent.orderNumber, paylinkId: intent.paylinkId,
    targetChain: intent.targetChain, targetTokenAddress: target, payer, recipient, baseFee: unsignedInteger(intent.baseFeeRaw),
    memo, maxUnits: fee.maxComputeUnitLimit, maxPrice, maxPriorityFee, finalizedSlot: intent.finalizedSlot});
}

// Source: pinned ALT Rust state.rs and generated TS account schema above. RPC
// provenance is the trusted caller's responsibility; a string cannot prove it.
// Never pass Helio's addressLookupTableAccounts here as independent evidence.
function lookupSnapshots(snapshots, finalizedSlot) {
  requireThat(Array.isArray(snapshots) && snapshots.length <= 4);
  const result = new Map();
  for (const snapshot of snapshots) {
    requireThat(exact(snapshot, ['address', 'source', 'commitment', 'contextSlot', 'owner', 'executable', 'dataBase64']) &&
      snapshot.source === 'trusted-finalized-rpc' && snapshot.commitment === 'finalized' &&
      snapshot.contextSlot === finalizedSlot && snapshot.owner === C.lookupProgram && snapshot.executable === false);
    const address = publicKey(snapshot.address);
    requireThat(!result.has(address));
    const bytes = base64(snapshot.dataBase64, 88, 56 + 256 * 32);
    requireThat((bytes.length - 56) % 32 === 0 && bytes.readUInt32LE(0) === 1 && bytes.readBigUInt64LE(4) === MAX_U64 &&
      bytes.readBigUInt64LE(12) < BigInt(finalizedSlot));
    const count = (bytes.length - 56) / 32;
    requireThat(bytes[20] <= count && (bytes[21] === 0 || bytes[21] === 1) &&
      bytes.subarray(bytes[21] === 0 ? 22 : 54, 56).every(b => b === 0));
    const addresses = [];
    for (let offset = 56; offset < bytes.length; offset += 32) addresses.push(getAddressDecoder().decode(bytes.subarray(offset, offset + 32)));
    result.set(address, {addresses, digest: sha256(bytes)});
  }
  return result;
}

function decodeAndResolve(bytes, tables, expectedPayer) {
  // This restricted profile requires exactly one all-zero signature slot.
  // Explicitly reject other wire versions before asking the generic SDK decoder.
  requireThat(bytes[0] === 1 && bytes.subarray(1, 65).every(b => b === 0) && (bytes[65] < 128 || bytes[65] === 128));
  const transaction = getTransactionDecoder().decode(bytes);
  requireThat(equal(getTransactionEncoder().encode(transaction), bytes) &&
    Object.keys(transaction.signatures).length === 1 && Object.keys(transaction.signatures)[0] === expectedPayer &&
    Object.values(transaction.signatures).every(signature => signature === null));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  requireThat(equal(getCompiledTransactionMessageEncoder().encode(message), transaction.messageBytes) &&
    (message.version === 'legacy' || message.version === 0));
  const h = message.header, staticAccounts = message.staticAccounts;
  requireThat(h.numSignerAccounts === 1 && h.numReadonlySignerAccounts === 0 &&
    h.numReadonlyNonSignerAccounts >= 0 && h.numReadonlyNonSignerAccounts < staticAccounts.length &&
    staticAccounts.length <= 32 && staticAccounts[0] === expectedPayer);
  const accounts = staticAccounts.map((address, index) => ({address, signer: index === 0,
    writable: index < staticAccounts.length - h.numReadonlyNonSignerAccounts}));
  const lookups = message.addressTableLookups || [];
  requireThat(lookups.length <= 4 && (message.version !== 'legacy' || lookups.length === 0) && tables.size === lookups.length);
  const writable = [], readonly = [], seenTables = new Set();
  for (const lookup of lookups) {
    requireThat(!seenTables.has(lookup.lookupTableAddress)); seenTables.add(lookup.lookupTableAddress);
    const table = tables.get(lookup.lookupTableAddress);
    if (!table) reject('helio_independent_lookup_required');
    const writes = lookup.writableIndexes || [], reads = lookup.readonlyIndexes || [];
    requireThat(writes.length + reads.length > 0 && new Set([...writes, ...reads]).size === writes.length + reads.length);
    for (const [indexes, destination, isWritable] of [[writes, writable, true], [reads, readonly, false]]) {
      for (const index of indexes) {
        requireThat(Number.isInteger(index) && index >= 0 && index < table.addresses.length);
        destination.push({address: table.addresses[index], signer: false, writable: isWritable});
      }
    }
  }
  accounts.push(...writable, ...readonly);
  requireThat(accounts.length <= 32 && new Set(accounts.map(x => x.address)).size === accounts.length &&
    message.instructions.length >= 2 && message.instructions.length <= 4);
  for (const instruction of message.instructions) {
    requireThat(Number.isInteger(instruction.programAddressIndex) && instruction.programAddressIndex >= 0 &&
      instruction.programAddressIndex < staticAccounts.length && !accounts[instruction.programAddressIndex].writable &&
      !accounts[instruction.programAddressIndex].signer &&
      (instruction.accountIndices || []).every(index => Number.isInteger(index) && index >= 0 && index < accounts.length));
  }
  return {transaction, message, accounts, lookupCount: lookups.length};
}

async function associatedAccount(owner) {
  const encode = getAddressEncoder();
  return (await getProgramDerivedAddress({programAddress: C.associatedTokenProgram,
    seeds: [encode.encode(owner), encode.encode(C.tokenProgram), encode.encode(C.mint)]}))[0];
}

async function review({preparation, trustedIntent, finalizedLookupTables = []} = {}) {
  const intent = snapshotIntent(trustedIntent, preparation);
  const bytes = base64(preparation.prepared.serializedTransaction, 100, 1232);
  const tables = lookupSnapshots(finalizedLookupTables, intent.finalizedSlot);
  const {transaction, message, accounts, lookupCount} = decodeAndResolve(bytes, tables, intent.payer);
  const [payerAta, recipientAta, helioAta, daoAta] = await Promise.all(
    [intent.payer, intent.recipient, C.helioFeeOwner, C.daoFeeOwner].map(associatedAccount));
  const expectedAccounts = [intent.payer, payerAta, recipientAta, helioAta, daoAta, intent.recipient,
    C.helioFeeOwner, C.daoFeeOwner, C.mint, C.tokenProgram, C.associatedTokenProgram, C.systemProgram];
  requireThat(new Set(expectedAccounts).size === expectedAccounts.length);
  let payments = 0, memos = 0, unitLimit, unitPrice;
  const used = new Set();
  for (const instruction of message.instructions) {
    const program = accounts[instruction.programAddressIndex].address;
    const indices = instruction.accountIndices || [], data = Buffer.from(instruction.data || []);
    used.add(instruction.programAddressIndex); for (const index of indices) used.add(index);
    if (program === C.helioProgram) {
      requireThat(++payments === 1 && indices.length === 12 && data.length === 28 && equal(data.subarray(0, 8), discriminator) &&
        data.readBigUInt64LE(8) === BigInt(C.amountMicros) && data.readBigUInt64LE(16) === intent.baseFee && data.readUInt32LE(24) === 0);
      indices.forEach((index, position) => requireThat(accounts[index].address === expectedAccounts[position] &&
        accounts[index].signer === (position === 0) && accounts[index].writable === (position <= 4)));
    } else if (program === C.memoProgram) {
      requireThat(++memos === 1 && indices.length === 0 && equal(data, intent.memo));
    } else if (program === C.computeProgram) {
      requireThat(indices.length === 0);
      if (data[0] === 2) {
        requireThat(unitLimit === undefined && data.length === 5); unitLimit = data.readUInt32LE(1);
        requireThat(unitLimit > 0 && unitLimit <= intent.maxUnits);
      } else if (data[0] === 3) {
        requireThat(unitPrice === undefined && data.length === 9); unitPrice = data.readBigUInt64LE(1);
        requireThat(unitPrice <= intent.maxPrice);
      } else reject();
    } else reject();
  }
  requireThat(payments === 1 && memos === 1 && used.size === accounts.length);
  // Without an explicit limit use the network maximum as a conservative upper
  // bound, not a claim about how many CUs this program will actually consume.
  const units = unitLimit ?? 1_400_000;
  requireThat(units <= intent.maxUnits);
  const priorityFeeBound = ((unitPrice ?? 0n) * BigInt(units) + 999_999n) / 1_000_000n;
  requireThat(priorityFeeBound <= intent.maxPriorityFee);
  return Object.freeze({
    state: 'static_review_passed', signingAllowed: false, paymentVerified: false, fulfillmentVerified: false,
    orderId: intent.orderId, orderNumber: intent.orderNumber, paylinkId: intent.paylinkId,
    targetChain: intent.targetChain, targetTokenAddress: intent.targetTokenAddress, paymentChain: 'solana', paymentCluster: 'mainnet-beta',
    amountMicros: C.amountMicros, mint: C.mint, payerPublicKey: intent.payer, recipientPublicKey: intent.recipient,
    transactionSha256: sha256(bytes), messageSha256: sha256(transaction.messageBytes),
    version: message.version, instructionCount: message.instructions.length, lookupTableCount: lookupCount,
    lookupSnapshotSha256: Object.freeze([...tables].map(([address, value]) => Object.freeze({address, sha256: value.digest}))),
    baseFeeRaw: intent.baseFee.toString(), computeUnitLimitUpperBound: units,
    priorityFeeLamportsUpperBound: priorityFeeBound.toString(), finalizedLookupContextSlot: intent.finalizedSlot,
    requiredExternalChecks: Object.freeze([
      'authenticated_order_token_merchant_and_memo_binding', 'approved_real_customer_details_and_listing_assets',
      'independent_rpc_mainnet_genesis_and_fresh_lookup_provenance',
      'deployed_program_bytecode_upgrade_authority_and_base_fee_semantics',
      'fresh_independent_account_owners_balances_delegates_and_freeze_state',
      'fresh_blockhash_fee_quote_and_simulation_with_exact_source_debit_limits',
      'explicit_payment_authorization_funding_and_durable_attempt_lock',
      'finalized_receipt_exact_order_reconciliation_and_dex_publication',
    ]),
  });
}

/**
 * Review ONLY the exact unsigned output of createHelioDexCheckoutClient.
 * trustedIntent is constructed by authenticated server-side order discovery
 * and policy, never holder/AI input. recipientPublicKey and expectedMemo must
 * come from a separately correlated approved checkout record, never inferred
 * from the transaction under review. baseFeeRaw is the exact approved u64,
 * NOT a dollar estimate; deployed fee semantics still require verification.
 *
 * finalizedLookupTables contains independent, same-context finalized RPC
 * account snapshots, never the provider's opaque addressLookupTableAccounts.
 * paymentCluster is fixed to mainnet-beta; independently verify RPC genesis.
 * No RPC is performed here. contextSlot is evidence, not freshness assurance.
 *
 * Preserve preparation.transactionToken privately outside this function.
 * A future signer must re-check the returned hashes against identical bytes,
 * resolve every requiredExternalCheck, and independently enforce source-debit
 * and fee caps. This function never returns a signing permission/capability.
 */
export async function reviewHelioDexUnsigned(input) {
  try { return await review(input); }
  catch (error) { if (ownErrors.has(error)) throw error; reject(); }
}
