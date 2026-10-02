(() => {
  const $=id=>document.getElementById(id),types=['DEX_UPDATE','DEX_BOOST'];let token=null,clock=null;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list=value=>Array.isArray(value)?value.filter(x=>x&&typeof x==='object'):[];
  const capabilityCopy=c=>({
    account_not_connected:'Purchasing is not connected. You can propose a listing update for a vote.',
    provider_unverified:'Paid boosts are not available through this project yet. A vote cannot place an order.'
  })[c?.status]||c?.reason||'Purchase availability has not been confirmed.';
  const preparationCopy=r=>({
    awaiting_account:'Request saved. Purchasing is not connected; no order was placed.',
    support_unverified:'Request saved. Boost purchasing is not available; no order was placed.',
    expired:'Approval expired. This request cannot proceed without a new approval.',
    revoked:'Approval was withdrawn. This request cannot proceed.',
    approval_changed:'The request no longer matches the approved details. Review is needed before payment.',
    payment_review_required:'An existing payment needs review. Do not pay again.'
  })[r.state]||r.reason||'Request saved for review. No purchase has been confirmed.';
  function units(n,decimals,min=0){
    if(!Number.isSafeInteger(n)||n<0)return null;
    const base=10n**BigInt(decimals),value=BigInt(n),fraction=String(value%base).padStart(decimals,'0').replace(/0+$/,'').padEnd(min,'0');
    return String(value/base)+(fraction?'.'+fraction:'');
  }
  const money=n=>{const value=units(n,6,2);return value===null?'Not quoted':'$'+value;};
  const identity=t=>t&&typeof t.chain==='string'&&/^[a-z][a-z0-9-]{1,31}$/.test(t.chain)&&typeof t.address==='string'&&
    (t.chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[0-9a-fA-F]{40}$/).test(t.address)?t.chain+':'+(t.chain==='solana'?t.address:t.address.toLowerCase()):null;
  function deadline(){
    const elapsed=clock&&performance.now()-clock.received;
    if(!clock||!Number.isFinite(elapsed)||elapsed<0||elapsed>15*60_000)throw new Error('Refresh the project to load the current server time before submitting. Your draft is preserved.');
    // Device wall clocks can be wrong or adjusted while this page is open.
    // The server revalidates this signed expiry against its own voting window.
    return new Date(clock.time+Math.floor(elapsed)+clock.votingHours*3_600_000+7*86_400_000-60_000).toISOString();
  }
  function amount(value,decimals,max) {
    const s=String(value).trim().replace(',','.');
    if(!new RegExp('^(?:0|[1-9]\\d{0,6})(?:\\.\\d{1,'+decimals+'})?$').test(s))throw new Error('Enter a valid positive spending limit');
    const [whole,fraction='']=s.split('.'),n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));
    if(n<=0n||n>BigInt(max))throw new Error('Spending limit is out of range');return Number(n);
  }
  function mode(){
    const type=$('propType').value,on=types.includes(type),update=type==='DEX_UPDATE';
    $('dexFields').hidden=!on;$('dexUpdateFields').hidden=!update;$('dexBoostFields').hidden=type!=='DEX_BOOST';
    for(const id of ['dexMaxCost','dexMaxFee']){$(id).required=on;$(id).disabled=!on;}
    for(const id of ['dexDescription','dexIcon','dexBanner']){$(id).required=update;$(id).disabled=!update;}
    for(const id of ['dexWebsite','dexX'])$(id).disabled=!update;
    $('dexBoostCount').required=type==='DEX_BOOST';$('dexBoostCount').disabled=type!=='DEX_BOOST';
    if(on){$('propText').parentElement.hidden=true;$('propText').required=false;}
    const c=list(token?.dexPayments?.capabilities).find(c=>c.type===type);
    $('dexProposalNotice').textContent=capabilityCopy(c);
  }
  $('propType').addEventListener('change',mode);
  $('editProjectProfile').addEventListener('click',mode);
  for(const [id,type]of [['suggestDexUpdate','DEX_UPDATE'],['suggestDexBoost','DEX_BOOST']])$(id).addEventListener('click',()=>{
    $('propType').value=type;$('propType').dispatchEvent(new Event('change'));
    $('propTitle').value=type==='DEX_UPDATE'?'Update our DEX Screener profile':'Buy DEX Screener Boosts';
    $('dexMaxCost').focus();
  });
  function payload(){
    if(!token)throw new Error('Wait for the project to load');
    if(!types.includes($('propType').value))throw new Error('Choose a DEX proposal type');
    const x={provider:'padre',chain:token.chain,tokenAddress:token.address,
      maxCostMicros:amount($('dexMaxCost').value,6,1_000_000_000_000),
      maxNetworkFeeMicros:amount($('dexMaxFee').value,6,100_000_000),
      expiresAt:deadline()};
    if($('propType').value==='DEX_UPDATE')Object.assign(x,{description:$('dexDescription').value.trim(),iconImageUrl:$('dexIcon').value.trim(),headerImageUrl:$('dexBanner').value.trim(),
      links:[['Website','dexWebsite'],['X','dexX']].filter(([,id])=>$(id).value.trim()).map(([label,id])=>({label,url:$(id).value.trim()}))});
    else {const value=$('dexBoostCount').value;if(!/^[1-9]\d{0,5}$/.test(value))throw new Error('Enter the exact number of Boosts requested');x.boosts=Number(value);}
    return x;
  }
  // Refresh deadline evidence without touching form controls or rebuilding history.
  // The live feed calls this even when a clock-only snapshot skips DOM rendering.
  function syncClock(t){
    const key=identity(t);
    if(!key||(token&&key!==identity(token)))return false;
    const d=t.dexPayments;
    const time=typeof d?.serverTime==='string'?Date.parse(d.serverTime):NaN,votingHours=d?.votingHours;
    if(!Number.isFinite(time)||new Date(time).toISOString()!==d.serverTime||!Number.isFinite(votingHours)||votingHours<=0||votingHours>168||typeof performance==='undefined')clock=null;
    else if(!clock||clock.time!==time||clock.votingHours!==votingHours)clock={time,votingHours,received:performance.now()};
    token={chain:t.chain,address:t.address,dexPayments:d};
    return true;
  }
  function render(t){
    if(!syncClock(t))return;
    const d=token.dexPayments;
    for(const [type,id]of [['DEX_UPDATE','dexUpdateStatus'],['DEX_BOOST','dexBoostStatus']]){
      const c=list(d?.capabilities).find(c=>c.type===type);
      $(id).textContent=capabilityCopy(c);
    }
    $('dexAccounting').textContent='Purchase balance: '+(d?.availableMicros==null?'not connected':money(d.availableMicros))+
      ' · Confirmed spending: '+money(d?.confirmedSpendMicros??0)+' · Reserved: '+money(d?.reservedMicros??0)+'. Preparing a request does not reserve funds.';
    const labels={awaiting_account:'Purchasing not connected',support_unverified:'Purchasing not available',expired:'Approval expired',revoked:'Approval withdrawn',approval_changed:'Approved details changed',payment_review_required:'Payment needs review'};
    const prepared=list(d?.preparations).slice(-12).reverse().map(r=>`<div class="item"><b>${esc(r.type==='DEX_UPDATE'?'Listing update':'Paid boost')}</b> · ${esc(labels[r.state]||'Request saved')}<p class="hint">${esc(preparationCopy(r))}</p></div>`).join('');
    const paid=list(d?.records).slice(-12).reverse().map(r=>`<div class="item"><b>${esc(r.type==='DEX_UPDATE'?'Dex Update':'Dex Boost')}</b> · ${esc(String(r.state||'Awaiting verification').replaceAll('_',' '))}<p class="hint">${esc(r.reason||'Awaiting verification')}</p>${r.paymentSignature?`<span class="mono" style="overflow-wrap:anywhere">${esc(r.paymentSignature)}</span>`:''}</div>`).join('');
    $('dexHistory').innerHTML=prepared+paid||'<p class="hint">No extra requests or purchases yet. A vote is not a payment receipt.</p>';
    mode(); // Does not clear the user’s draft during live updates.
  }
  function ballot(p){
    if(!types.includes(p.type))return '';
    const x=p.payload||{};
    const fee=x.provider==='padre'?money(x.maxNetworkFeeMicros)+' USD':(units(x.maxNetworkFeeLamports,9)??'Not quoted')+' SOL';
    const route=x.provider==='padre'?'Optional DEX Screener request':'Legacy Bags purchase request';
    const details=p.type==='DEX_UPDATE'?`<p>${esc(x.description)}</p><p>Logo: ${esc(x.iconImageUrl)}<br>Banner: ${esc(x.headerImageUrl)}</p><p>${list(x.links).map(l=>esc(l.label)+': '+esc(l.url)).join('<br>')}</p>`:`<p>Exact Boost quantity: ${esc(x.boosts)}</p>`;
    return `<div class="profile-ballot" style="overflow-wrap:anywhere"><p>${esc(route)}</p><p><b>Maximum purchase: ${esc(money(x.maxCostMicros))}</b> · Network fee limit: ${esc(fee)}</p><p>Target: ${esc(x.chain)} · ${esc(x.tokenAddress)}</p>${details}<p>Expires: ${esc(x.expiresAt)} · One purchase only · No automatic renewal or bridging</p><p>Provider support and final costs must be verified. Approval alone does not place an order. Paid placement does not guarantee ranking or returns.</p></div>`;
  }
  window.GatewayDex={payload,render,syncClock,ballot,amount};mode();
})();
