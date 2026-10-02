(() => {
  const $=id=>document.getElementById(id),types=['TREASURY_BUY','TREASURY_BURN'];
  const select=$('propType');if(!select)return;
  let current=null,quote=null,quoteKey='',timer=null,sequence=0,abort=null;
  for(const [value,label]of [['TREASURY_BUY','Buy our token'],['TREASURY_BURN','Burn treasury tokens']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
  const fields=document.createElement('fieldset');fields.id='walletFields';fields.className='project-fields full';fields.hidden=true;
  fields.innerHTML='<legend>Community wallet action</legend><p class="hint full" id="walletActionNotice" role="status"></p><p class="hint full" id="walletActionTarget"></p><label class="full" id="walletAmountLabel">Purchase amount (USD)<input id="walletAmount" inputmode="decimal" autocomplete="off" placeholder="100"></label><p class="hint full" id="walletFeeSummary" role="status" aria-live="polite">Enter an amount. We check the project balance and calculate the network fee.</p><button class="btn full" id="walletFeeRefresh" type="button">Check balance & fee</button><p class="hint full" id="walletActionRisk"></p><p class="hint full">Voting must close with more than 15% of total supply voting yes and more yes than no. The amount and target cannot change after voting. Approval expires one day after voting closes.</p>';
  $('propText').parentElement.after(fields);
  function mode(){
    const active=types.includes(select.value),buy=select.value==='TREASURY_BUY';fields.hidden=!active;
    if(!active)return;
    $('projectFields').hidden=true;$('dexFields').hidden=true;$('propText').parentElement.hidden=true;$('propText').required=false;
    $('walletAmountLabel').firstChild.textContent=buy?'Purchase amount (USD)':'Exact amount to burn';
    $('walletAmount').placeholder=buy?'100':'1000000';
    $('walletActionRisk').textContent=buy?'Buys this project’s token into its treasury. Price protection is preset to 1%. The network fee is paid from the project wallet, in addition to the purchase amount. If costs exceed the approved limit, the transaction will not be sent.':'Burns only tokens held in this project’s treasury. Burning is irreversible. The network fee is calculated automatically and paid from the project wallet.';
    $('walletActionTarget').textContent=current?`${current.symbol} · ${current.chain} · ${current.address}`:'Waiting for verified project details';
    $('walletActionNotice').textContent=current?.walletActions?.readyTypes?.includes(select.value)?'After voting closes, the central VPS checks this exact action before signing. The project agent must be online.':current?.walletActions?.reason||'A reviewed signer is not yet configured for this project.';
    if(quoteKey&&quoteKey!==key())invalidate();
  }
  const key=()=>JSON.stringify([current?.address,current?.walletActions?.wallet,select.value,$('walletAmount').value.trim()]);
  const dollars=v=>(Number(v)/1e6).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
  function invalidate(){quote=null;quoteKey='';sequence++;abort?.abort();clearTimeout(timer);$('walletFeeSummary').textContent='Enter an amount. We check the project balance and calculate the network fee.';}
  async function refreshFee(){
    invalidate();const id=sequence,k=key(),amount=$('walletAmount').value.trim(),type=select.value;
    if(!amount||!types.includes(type))return;
    if(!/^(0|[1-9]\d{0,59})(\.\d{1,18})?$/.test(amount)||!/[1-9]/.test(amount)){$('walletFeeSummary').textContent='Enter a positive amount without commas.';return;}
    if(!current?.walletActions?.readyTypes?.includes(type)){$('walletFeeSummary').textContent='Automatic fee calculation is not available for this project yet.';return;}
    abort=new AbortController();const controller=abort,timeout=setTimeout(()=>controller.abort(),20000);
    $('walletFeeSummary').textContent='Checking available funds and network fee…';
    try{
      const r=await fetch(`/api/site/token/${encodeURIComponent(current.address)}/wallet-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,amount}),signal:controller.signal});
      const q=await r.json();if(id!==sequence||k!==key())return;
      if(!r.ok)throw Error(q.error||'Unable to calculate the fee. Please try again.');
      const p=q.payload;
      if(!p||p.token!==current.address||p.wallet!==current.walletActions.wallet||p.chainId!==current.walletActions.chainId||!/^\d+$/.test(p.maxNetworkFeeUsdMicros)||Date.parse(q.validUntil)<=Date.now())throw Error('Fee estimate is unavailable. Check again.');
      quote=q;quoteKey=k;
      const estimated=Number(q.estimatedFeeUsdMicros)<10000?'< $0.01':dollars(q.estimatedFeeUsdMicros);
      $('walletFeeSummary').textContent=`Estimated network fee ${estimated} · Automatic fee limit ${dollars(p.maxNetworkFeeUsdMicros)} · Maximum total ${dollars(q.maximumTotalUsdMicros)} · Available ${dollars(q.availableUsdMicros)}. Only the actual network fee is charged.`;
    }catch(e){if(id===sequence)$('walletFeeSummary').textContent=e.name==='AbortError'?'The balance check timed out. Please try again.':e.message;}
    finally{clearTimeout(timeout);}
  }
  $('walletAmount').addEventListener('input',()=>{invalidate();timer=setTimeout(refreshFee,650);});
  $('walletFeeRefresh').addEventListener('click',refreshFee);
  function payload(){
    if(!current?.walletActions?.proposals)throw Error('Wallet proposals are not enabled on this server. No request was submitted.');
    if(!quote||quoteKey!==key()||Date.parse(quote.validUntil)<=Date.now()){refreshFee();throw Error('Review the updated balance and fee summary, then submit your idea.');}
    return {...quote.payload};
  }
  select.addEventListener('change',()=>{invalidate();mode();timer=setTimeout(refreshFee,650);});
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function ballot(p){
    if(!types.includes(p.type))return '';
    const x=p.payload||{},dollars=v=>/^\d+$/.test(String(v))?(Number(v)/1e6).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}):'Unavailable';
    return `<div class="wallet-ballot"><strong>${p.type==='TREASURY_BUY'?'Buy up to '+esc(dollars(x.maxSpendUsdMicros))+' of our token':'Burn '+esc(x.amountTokens)+' tokens'}</strong><div>Chain ID ${esc(x.chainId)} · Token ${esc(x.token)}</div><div>Project treasury ${esc(x.wallet)}</div><div>Network fee limit ${esc(dollars(x.maxNetworkFeeUsdMicros))}${p.type==='TREASURY_BUY'?' · Maximum slippage '+esc(Number(x.maxSlippageBps)/100)+'%':' · Irreversible token burn'}</div><div>Expires ${esc(x.expiresAt)}</div><div>${esc(p.agentReason||(current?.walletActions?.readyTypes?.includes(p.type)?"Execution requires the closed vote, an online project agent and central VPS checks.":"No reviewed signer is active for this project."))}</div></div>`;
  }
  window.GatewayWallet={payload,ballot,render(t){current=t;mode();}};
})();
