// Community presentation. Sending and wallet authentication stay in the host page.
(() => {
  const $=id=>document.getElementById(id),chat=document.querySelector('aside.chat');if(!chat)return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short=value=>String(value||'').slice(0,6)+'…'+String(value||'').slice(-4);
  const title=chat.querySelector('.conversation-heading'),tabs=chat.querySelector('.tabs');
  title.querySelector('.chat-expand').addEventListener('click',e=>{const expanded=chat.classList.toggle('chat-expanded');document.querySelector('.stage').classList.toggle('chat-focus',expanded);e.currentTarget.setAttribute('aria-pressed',String(expanded));e.currentTarget.setAttribute('aria-label',expanded?'Restore chat size':'Expand chat');});
  chat.querySelector('.chat-idea-entry button').addEventListener('click',e=>window.GatewayRoomDialogs?.idea(e.currentTarget));
  tabs.addEventListener('click',event=>{if(event.target.closest('[data-tab]'))window.GatewayChatMotion?.animate($('msgs'),[{opacity:.65,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:180});});
  const draft=prefix=>{const input=$('msgText');if(input.disabled){if(!$('sendMessage').disabled){$('chatnote').textContent='Connect a holder wallet to join the conversation.';$('chatnote').hidden=false;}return;}input.value=prefix+input.value.replace(/^@\S+\s*/,'');input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));};
  // The host binds every existing tab-row button before deferred enhancement.
  // Ask is a composer shortcut, not a data-tab; preserve the current conversation tab.
  const ask=tabs.querySelector('.chat-ask');ask.onclick=null;
  ask.addEventListener('click',()=>draft('@Kurt '));
  // Compatibility controls stay disabled; chat cannot authorize work or spending.
  $('taskPermissions').hidden=true;chat.querySelector('.research-control').hidden=true;
  for(const id of ['allowWrite','allowPublish','researchMode']){$(id).checked=false;$(id).disabled=true;}
  const box=$('msgs');
  const usage=$('usageAllowance');
  chat.addEventListener('keydown',event=>{if(event.key==='Escape'&&usage.open){usage.open=false;usage.querySelector('summary').focus();event.preventDefault();}});
  document.addEventListener('pointerdown',event=>{if(usage.open&&!usage.contains(event.target))usage.open=false;});
  box.addEventListener('click',event=>{const b=event.target.closest('[data-chat-reply]');if(b)draft('@'+b.dataset.chatReply+' ');if(event.target.closest('[data-chat-idea]'))window.GatewayRoomDialogs?.idea(event.target.closest('button'));});
  const sync=()=>box.classList.toggle('chat-empty',!box.querySelector('.msg'));new MutationObserver(sync).observe(box,{childList:true});sync();
  $('msgText').addEventListener('input',()=>{
    const form=$('msgForm'),status=$('chatSendStatus');
    if(form.dataset.sendState==='error'){
      delete form.dataset.sendState;status.textContent='';delete status.dataset.state;
      const button=$('sendMessage'),connected=button.dataset.connected==='true';delete button.dataset.retry;button.textContent=connected?'Send':'Connect to send';button.setAttribute('aria-label',connected?'Send message':'Connect wallet to send message');
    }
  });
  const valid=n=>Number.isSafeInteger(n)&&n>=0;
  const dollars=n=>!valid(n)?'—':n===0?'$0.00':n<100?'<$0.0001':'$'+(n/1e6).toFixed(n<10_000?4:2);
  const tokens=n=>Number.isFinite(n)&&n>=0?Math.floor(n).toLocaleString('en-US'):null;
  const projectReasons={
    ai_model_incompatible:'The selected LightOnOCR 2 model reads document images and cannot run agent chat. The selected model has not been changed.',
    vps_usage_review_required:'AI requests are paused while funds are reserved for server usage that needs review.',
    runtime_liabilities_unverified:'AI requests are paused while the operator checks outstanding project costs.',
    runtime_balance_unverified:'The project balance must be verified before another AI request.',
    runtime_funding_required:'The project has too little unreserved budget for AI after covering server costs and existing commitments.'
  };
  function projectReason(error) {
    if(Object.hasOwn(projectReasons,error?.code))return error.code;
    if(Object.hasOwn(projectReasons,error?.reason))return error.reason;
    // The existing chat session client retains status/message but not API codes.
    const text=String(error?.message||'');
    if(/The selected LightOnOCR 2 model reads document images and cannot run agent chat/i.test(text))return 'ai_model_incompatible';
    if(/AI (?:responses|requests).*paused.*server usage.*review/i.test(text))return 'vps_usage_review_required';
    if(/AI (?:responses|requests).*paused.*checks? (?:existing payment commitments|outstanding project costs)/i.test(text))return 'runtime_liabilities_unverified';
    if(/project balance could not be verified/i.test(text))return 'runtime_balance_unverified';
    if(/AI is paused: confirmed funds must cover this request and the reserved VPS hours|AI responses are paused because project funds are reserved/i.test(text))return 'runtime_funding_required';
    return null;
  }
  function projectAi(t={},q) {
    const a=t.budget?.aiAvailability||q?.aiAvailability;
    if(a&&['ready','budget_paused','review_required'].includes(a.status))return a;
    return null;
  }
  function allowance(q,t={}) {
    const a=projectAi(t,q),known=!!q&&valid(q.totalMicros)&&valid(q.remainingMicros);
    const renewal=known&&Number.isFinite(Date.parse(q.renewsAt))?'Allowance renews · '+new Date(q.renewsAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC':'';
    const rows=known?[['Period allowance',dollars(q.totalMicros)],['Allowance remaining',dollars(q.remainingMicros)],['Used',dollars(q.usedMicros)],['Reserved for requests',dollars(q.reservedMicros)]]:[];
    if(known&&tokens(q.tokensLeft)!==null)rows.push(['Period tokens remaining (estimate)',tokens(q.tokensLeft)]);
    if(a){
      rows.unshift(['Project AI budget available',dollars(a.availableMicros)]);
      if(valid(a.vpsReserveMicros))rows.push(['Reserved for server usage',dollars(a.vpsReserveMicros)]);
      if(valid(a.heldMicros))rows.push(['Committed project funds',dollars(a.heldMicros)]);
    }
    if(t.budget?.aiModelCompatibility?.supported===false&&t.budget.aiModelCompatibility.code==='ai_model_incompatible'){
      return {state:'project_model_incompatible',scope:'project',label:'AI model incompatible',rows,notice:projectReasons.ai_model_incompatible+' Community chat is still available.',renewal,projectStatus:'model_incompatible'};
    }
    if(a&&a.status!=='ready'){
      const checking=a.reason==='runtime_balance_unverified';
      const label=checking?'Checking AI budget':a.status==='review_required'?'Project AI needs a check':'Project AI paused';
      const notice=(projectReasons[a.reason]||'Project AI requests are temporarily paused.')+(known?' Your period allowance is unchanged.':'')+' Community chat is still available.';
      return {state:checking?'project_checking':a.status==='review_required'?'project_review':'project_paused',scope:'project',label,rows,notice,renewal,projectStatus:a.status};
    }
    if(!known){
      if(a)return {state:'project_ready',scope:'project',label:valid(a.availableMicros)?dollars(a.availableMicros)+' available':'Checking…',rows,notice:'This is the shared budget available for AI. Connect a holder wallet to see your allowance. Community chat is still available.',renewal:'',projectStatus:a.status};
      return {state:'unknown',scope:'wallet',label:'Checking…',rows:[],notice:'Your AI allowance is not available yet. Community chat is still available.',renewal:''};
    }
    const spendable=valid(q.spendableMicros)?Math.min(q.spendableMicros,q.remainingMicros,valid(a?.availableMicros)?a.availableMicros:q.spendableMicros):null;
    const spendableTokens=spendable!==null&&tokens(q.spendableTokens)!==null?Math.floor(Math.min(q.spendableTokens,valid(q.tokensLeft)?q.tokensLeft:q.spendableTokens)*(q.spendableMicros>0?spendable/q.spendableMicros:0)):null;
    let state='available',label=spendable===null?'Checking usable allowance':spendableTokens!==null?'≈ '+tokens(spendableTokens)+' tokens available':dollars(spendable)+' available';
    let notice='AI requests use the smaller of your remaining allowance and the unreserved project budget. Token amounts are estimates. Community messages are free.';
    if(spendable!==null)rows.unshift(['Your AI budget available now',dollars(spendable)]);
    if(q.totalMicros===0){state='unallocated';label='Not allocated';notice='No AI allowance has been allocated to this wallet for the current period. Allocation uses period holdings, which can differ from your current token balance. Community chat remains available.';}
    else if(q.remainingMicros===0&&q.reservedMicros>0){state='reserved';label='AI allowance reserved';notice=q.uncertainMicros>0?'An AI payment is awaiting confirmation. Its allowance stays reserved to prevent a second charge.':'Your allowance is reserved for an AI request in progress. Community chat remains available.';}
    else if(q.remainingMicros===0&&q.usedMicros>0){state='exhausted';label='AI allowance used up';notice='You have used the AI allowance available for this period. Community chat remains available.';}
    else if(q.remainingMicros===0){state='unavailable';label='AI allowance unavailable';notice='No AI allowance is currently available for this wallet. Community chat remains available.';}
    else if(spendable===0){state='limited';label='No AI budget available';notice='Your period allowance remains, but no project-backed amount is available for this wallet right now. Community chat remains available.';}
    else if(q.exhausted===true){state='limited';label=(spendable===null?dollars(q.remainingMicros):dollars(spendable))+' left · below request cost';notice='Your remaining allowance cannot cover the next AI request. Community chat remains available.';}
    if(a?.reviewRequired===true&&a.status==='ready')notice+=' Server usage is awaiting review; its reserve is already excluded from the available amount.';
    if(t.treasury?.mode==='sim')notice='Simulation only — these are not real payments. '+notice;
    return {state,scope:'wallet',label,notice,renewal,rows,projectStatus:a?.status||null};
  }
  function sendError(error,q,t={}) {
    const text=String(error?.message||'Could not send your message.');
    if(error?.code===4001||error?.code==='ACTION_REJECTED')return 'Approval cancelled. Your draft is here when you are ready.';
    if(['TimeoutError','AbortError'].includes(error?.name))return 'Connection timed out. Your draft is saved here; retry to check the send.';
    const reason=projectReason(error);
    if(reason)return 'Not sent: '+projectReasons[reason]+' Your draft is still here. Community chat is available without @Kurt.';
    if(/AI share|AI allowance|quota|tokens left|allowance.*wallet/i.test(text)){
      const a=projectAi(t,q);
      if(a&&a.status!=='ready')return 'Not sent: '+(projectReasons[a.reason]||'Project AI requests are temporarily paused.')+' Your draft is still here. Community chat is available without @Kurt.';
      const state=allowance(q,t).state;
      if(state==='unallocated')return 'Not sent: this wallet has no AI allowance this period. You can send a community message without @Kurt.';
      if(state==='reserved')return 'Not sent: your AI allowance is reserved for a pending request. Your draft is still here.';
      if(state==='exhausted')return 'Not sent: your AI allowance is used up. You can send a community message without @Kurt.';
      if(state==='limited'||state==='available')return 'Not sent: this AI request exceeds your remaining allowance. Your draft is still here.';
      return 'Not sent: AI allowance is currently unavailable. Your draft is still here.';
    }
    return 'Not sent: '+text.slice(0,240)+(text.length>240?'…':'');
  }
  function canRetry(error) {
    if(error?.code===4001||error?.code==='ACTION_REJECTED'||projectReason(error))return false;
    if([400,401,403,404,409,422].includes(error?.status))return false;
    return !/AI share|AI allowance|quota|tokens left|allowance.*wallet|connect.*wallet/i.test(String(error?.message||''));
  }
  window.GatewayConversation={allowance,projectAi,sendError,canRetry,messages(items,t,me){
    if(!items.length)return '<div class="chat-welcome"><svg class="chat-empty-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8 6h16a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H13l-7 4v-5a4 4 0 0 1-2-3V10a4 4 0 0 1 4-4Z" stroke="currentColor" stroke-width="1.3"/><path d="M10 13h12M10 18h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><strong>No messages yet</strong><p>Start a conversation with your community.</p></div>';
    const holders=new Map((t.holders||[]).map(h=>[h.address,h]));
    const shareOf=m=>{const h=holders.get(m.holder),raw=h?h.sharePct:m.sharePct,pct=raw==null?NaN:Number(raw);return Number.isFinite(pct)?`${pct>0&&pct<0.01?'<0.01':pct.toFixed(2)}% of token supply`:'';};
    return items.map((m,index)=>{
      const name=t.profiles?.[m.holder]||m.username||short(m.holder),created=new Date(m.createdAt),validTime=Number.isFinite(created.getTime()),time=validTime?created.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'',share=shareOf(m);
      const pending=m.audience==='agent'&&!m.reply?(m.chatState==='failed'?'Kurt could not reply':m.chatState==='working'?'Kurt is thinking…':'Question saved for Kurt'):'';
      return `<div data-chat-id="${esc(m.id||`${m.holder}:${m.createdAt}:${index}`)}" class="msg${m.holder===me?' msg-mine':''}"><div class="av" aria-hidden="true">${esc(name.slice(0,2).toUpperCase())}</div><div class="body"><div class="who"><strong class="chat-author"${share?` title="${esc(share)}"`:''}>${esc(name)}${m.holder===me?'<span class="chat-you">You</span>':''}</strong><time${validTime?` datetime="${esc(created.toISOString())}" title="${esc(created.toLocaleString())}"`:''}>${esc(time)}</time><button type="button" data-chat-reply="${esc(name)}" aria-label="Reply to ${esc(name)}">Reply</button></div><div class="txt">${esc(m.text)}</div>${m.reply?`<div class="reply"><div class="kurt-reply-label">Kurt <span>${m.reply.source==='community_rules'?'Community guide':'AI'}</span></div>${esc(m.reply.text)}${m.reply.source==='community_rules'?'<button class="chat-rule-action" type="button" data-chat-idea>Suggest an idea</button>':window.GatewayVoice?.button(m.reply)||''}</div>`:pending?`<div class="chat-state${m.chatState==='working'?' is-thinking':''}">${m.chatState==='working'?'<span class="chat-thinking" aria-hidden="true"><i></i><i></i><i></i></span>':''}${esc(pending)}</div>`:''}</div></div>`;
    }).join('');
  }};
})();
