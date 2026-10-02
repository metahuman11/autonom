// Read-only planning. No wallet, payment, storage or provider calls.
(() => {
  const $ = id => document.getElementById(id);
  const MICRO = 1_000_000n, MAX_MICROS = 1_000_000n * MICRO;
  let reference = null;
  const usd = value => {
    const raw = String(value).trim().replace(',', '.');
    if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(raw)) throw new Error('Enter a non-negative dollar amount with up to 6 decimal places.');
    const [whole, fraction = ''] = raw.split('.');
    const n = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
    if (n > MAX_MICROS) throw new Error('Each amount must be $1,000,000 or less.');
    return n;
  };
  const count = value => {
    if (!/^\d{1,7}$/.test(String(value).trim())) throw new Error('Enter a whole number of planned posts.');
    const n = BigInt(String(value).trim());
    if (n > 1_000_000n) throw new Error('Plan at most 1,000,000 posts in this example.');
    return n;
  };
  const dollars = micros => {
    const whole = micros / MICRO, fraction = String(micros % MICRO).padStart(6, '0');
    const decimal = fraction.slice(2) === '0000' ? fraction.slice(0, 2) : fraction.replace(/0+$/, '');
    return '$' + whole.toLocaleString('en-US') + '.' + decimal;
  };
  const optionalUsd = value => String(value ?? '').trim() === '' ? null : usd(value);
  function calculate({setup, budget, premium, posts}, rate) {
    if (!Number.isSafeInteger(rate) || rate <= 0 || rate > 1_000_000) throw new Error('Reference pricing is unavailable.');
    const setupMicros = optionalUsd(setup), budgetMicros = usd(budget), premiumMicros = optionalUsd(premium);
    const plannedPosts = String(posts ?? '').trim() === '' ? null : count(posts);
    const estimatedUsageMicros = plannedPosts === null ? null : plannedPosts * BigInt(rate);
    return {setupMicros, budgetMicros, premiumMicros, plannedPosts, estimatedUsageMicros,
      knownFundingMicros: setupMicros === null || premiumMicros === null ? null : setupMicros + budgetMicros + premiumMicros,
      capacity: budgetMicros / BigInt(rate),
      remainingMicros: estimatedUsageMicros === null ? null : budgetMicros > estimatedUsageMicros ? budgetMicros - estimatedUsageMicros : 0n,
      shortfallMicros: estimatedUsageMicros === null ? null : estimatedUsageMicros > budgetMicros ? estimatedUsageMicros - budgetMicros : 0n};
  }
  function update() {
    if (!reference) return;
    try {
      const r = calculate({setup: $('socialSetup').value, budget: $('socialBudgetAmount').value,
        premium: $('socialPremium').value, posts: $('socialPlannedPosts').value}, reference.postMicros);
      $('socialUsageTotal').textContent = dollars(r.budgetMicros);
      $('socialPostCapacity').textContent = r.capacity.toLocaleString('en-US');
      $('socialStartupTotal').textContent = r.knownFundingMicros === null ? 'Not confirmed' : dollars(r.knownFundingMicros);
      if (r.plannedPosts === null) {
        $('socialProjection').textContent = 'Enter a planned post count to calculate usage. Account and Premium costs stay unknown until you enter their quotes.';
      } else {
        const usage = `${r.plannedPosts.toLocaleString('en-US')} planned posts → ${dollars(r.estimatedUsageMicros)} at the advertised API rate`;
        $('socialProjection').textContent = usage + (r.shortfallMicros ? ` · ${dollars(r.shortfallMicros)} over this usage budget. Reduce the plan or budget for the difference.` : ` · ${dollars(r.remainingMicros)} of the planning budget remains, before other costs.`);
      }
      $('socialBudgetError').hidden = true; $('socialBudgetError').textContent = '';
    } catch (error) {
      for (const id of ['socialUsageTotal','socialPostCapacity','socialStartupTotal']) $(id).textContent = '—';
      $('socialProjection').textContent = 'Correct the example amounts to see a cost estimate.';
      $('socialBudgetError').hidden = false; $('socialBudgetError').textContent = error.message;
    }
  }
  function renderLive(t) {
    const c = t?.socialCosts || {}, connected = c.status === 'connected';
    const summary = $('socialSummary'), badge = $('socialBadge'), head = $('socialActualHead'), note = $('socialActualNote');
    const micros = v => dollars(BigInt(Number.isSafeInteger(v) && v >= 0 ? v : 0));
    const live = connected || (c.publishedPosts || 0) > 0;
    summary.textContent = connected ? `@${c.handle} · connected` : 'Not connected';
    badge.textContent = connected ? 'Connected' : 'Not connected'; badge.className = connected ? 'badge lime' : 'badge dim';
    head.textContent = live ? `Actual X usage: ${Number(c.publishedPosts || 0).toLocaleString('en-US')} post${c.publishedPosts === 1 ? '' : 's'} · ${micros(c.spentMicros)} total` : 'Actual X usage: no posts yet';
    note.textContent = live ? `${micros(c.unsettledMicros)} booked and awaiting settlement · ${micros(c.settledMicros)} settled treasury → operations. Measured per post from the provider balance.` : 'No X account is assigned to this project yet. Posts made, booked and settled amounts appear here from the live ledger.';
  }
  function render(t) {
    renderLive(t);
    reference = t?.socialCosts?.reference || null;
    if (!reference) {
      for (const id of ['socialUsageTotal','socialPostCapacity','socialStartupTotal']) $(id).textContent = '—';
      $('socialProjection').textContent = 'Reference pricing is unavailable. No money has been allocated.';
      $('socialPriceNote').textContent = '';return;
    }
    const rate = Number.isSafeInteger(reference.postMicros) && reference.postMicros > 0 && reference.postMicros <= 1_000_000 ? dollars(BigInt(reference.postMicros)) : 'an unavailable rate';
    $('socialPriceNote').textContent = `${reference.provider || 'The provider'} documents ${rate} per post (post + verification read) · checked ${reference.checkedOn}. This is a published rate, not a live payment quote or proof that posting works. Dollar figures use USDC at $1; conversion costs are excluded.`;
    // Live token updates do not reset a visitor's temporary calculation.
    update();
  }
  for (const id of ['socialSetup','socialBudgetAmount','socialPremium','socialPlannedPosts']) $(id).addEventListener('input', update);
  window.GatewaySocialBudget = {render, calculate};
})();
