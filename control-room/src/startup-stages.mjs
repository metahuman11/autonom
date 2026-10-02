// Pure staged onboarding projection, shared by queues and the public UI.
// No estimates of unclaimed creator fees can authorize a provider charge.
import { packageTerms, isStagedLaunch, isPackageFunded, runtimeStageReady, operationalReserveMicros,
  hasFreshMarketingObservation, socialStageComplete, dexStageComplete, holderWorkAllowed,
  socialAccountFundingCreditMicros } from './launch-package.mjs';
import { heldUsage, packageHolds } from './usage-budget.mjs';
export function stageFundingOf(t, kind, {now=Date.now()}={}) {
  if (!['social','dex'].includes(kind)) throw new Error('Unknown setup funding stage');
  const terms=packageTerms(t), staged=isStagedLaunch(t), thresholdMicros=terms?.[kind==='social'?'socialAccountBudgetMicros':'dexBudgetMicros']||0;
  const paid=kind==='social'?socialAccountFundingCreditMicros(t):t.launchPackageRun?.dex?.state==='settled' && t.launchPackageRun.dex.paymentVerified===true && t.launchPackageRun.dex.sourceBalanceReconciled===true ? t.launchPackageRun.dex.actualMicros||0:0;
  const completed=kind==='social'?socialStageComplete(t):dexStageComplete(t);
  const fresh=Number.isSafeInteger(t.treasury?.micros)&&t.treasury.micros>=0&&hasFreshMarketingObservation(t,now);
  const ownHeldMicros=packageHolds(t)[kind],otherHeldMicros=Math.max(0,heldUsage(t)-ownHeldMicros);
  const operatingReserveMicros=staged?operationalReserveMicros(t,{now}):0;
  const availableMicros=Number.isSafeInteger(t.treasury?.micros)?Math.max(0,t.treasury.micros-otherHeldMicros-operatingReserveMicros):0;
  const previousReady=!staged||runtimeStageReady(t,{now})&&(kind==='social'||socialStageComplete(t));
  const collectedMicros=completed||paid>0?thresholdMicros:Math.min(thresholdMicros,availableMicros);
  const funded=thresholdMicros>0&&(completed||paid>0||fresh&&collectedMicros>=thresholdMicros);
  const ready=!completed&&paid===0&&funded&&fresh&&previousReady&&t.lock?.state!=='paused';
  const blockedReason=completed?null:t.lock?.state==='paused'?'paused':!previousReady?'previous_stage':!fresh?'balance_unavailable':!funded?'funding':null;
  return {thresholdMicros,collectedMicros,availableMicros,creditedMicros:paid,otherHeldMicros,operatingReserveMicros,fresh,funded,ready,blockedReason,waitingPreviousStage:!previousReady};
}
export function startupStagesOf(t,{now=Date.now()}={}) {
  if(!isStagedLaunch(t))return null;
  const terms=packageTerms(t),runtime=runtimeStageReady(t,{now}),social=socialStageComplete(t),dex=dexStageComplete(t);
  const funded=isPackageFunded(t),paused=t.lock?.state==='paused',j=t.launchPackageRun||{};
  const x=stageFundingOf(t,'social',{now}),d=stageFundingOf(t,'dex',{now});
  const state=(f,job,done)=>done?'complete':paused?'attention_required':f.waitingPreviousStage?'pending':
    job?.terminal===true?'attention_required':['payment_pending','submitted','reconciliation_required','preparing'].includes(job?.state)?'processing':f.funded?'ready':'funding';
  const fresh=hasFreshMarketingObservation(t,now);
  const runtimeAvailable=Math.max(0,(t.treasury?.micros||0)-heldUsage(t));
  const stages=[
    {id:'runtime',label:'AI + computer',state:runtime?'complete':paused?'attention_required':funded?'processing':'funding',
      detail:runtime?'The AI computer is online.':funded?'Starting the AI computer.':'Collecting the initial AI and computer budget.',
      requiredMicros:terms.activationMicros,availableMicros:runtimeAvailable,collectedMicros:funded?terms.activationMicros:Math.min(terms.activationMicros,runtimeAvailable)},
    {id:'social',label:'X account',state:state(x,j.socialAccount,social),detail:x.waitingPreviousStage?'Starts after the AI computer is online.':j.socialAccount?.detail==='X_POOL_EMPTY'?'Waiting for an available verified account. No payment taken.':social?'The account payment and assignment are verified.':'Account funding preserves the running computer budget.',requiredMicros:x.thresholdMicros,...x},
    {id:'dex',label:'DEX Screener',state:state(d,j.dex,dex),detail:d.waitingPreviousStage?'Starts after the X account is verified.':dex?'Payment and listing publication are verified.':'A verified order, payment receipt and published listing are required.',requiredMicros:d.thresholdMicros,...d},
    {id:'holders',label:'Holder requests',state:holderWorkAllowed(t,{now})?'complete':'pending',detail:'Custom holder work opens after the AI computer, X account and DEX listing are ready.',requiredMicros:0,availableMicros:0,collectedMicros:0}
  ];
  return {version:1,policyVersion:5,activeStage:!runtime?'runtime':!social?'social':!dex?'dex':'holders',stages,
    operatingReserveMicros:operationalReserveMicros(t,{now}),holderWorkAllowed:holderWorkAllowed(t,{now}),fresh};
}
