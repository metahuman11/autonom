// One paid provider-account call at a time across the whole platform. The prepaid balance is the
// meter for account billing (chat and speech): two calls in flight would blur each other's cost.
let turn = Promise.resolve();
/// Resolves to a release function once it is this caller's turn. Release is idempotent; a
/// forgotten release is a deadlock for every later call, so callers wrap it in try/finally.
export function acquireAccountTurn() {
  let release; const mine = new Promise((r) => { release = r; });
  const wait = turn; turn = turn.then(() => mine);
  return wait.then(() => { let done = false; return () => { if (!done) { done = true; release(); } }; });
}
