// Hand-drawn vector illustration; it does not simulate or send real project work.
// All network, wallet and financial actions remain outside this component.
const ART = `<svg class="aw-svg" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="900" height="700" viewBox="0 0 900 700" fill="none">
<defs>
  <linearGradient id="aw-ivory" x1="330" y1="180" x2="590" y2="425" gradientUnits="userSpaceOnUse"><stop stop-color="#fffcef"/><stop offset=".58" stop-color="#e4e4cf"/><stop offset="1" stop-color="#969f90"/></linearGradient>
  <linearGradient id="aw-chrome" x1="200" y1="440" x2="285" y2="455" gradientUnits="userSpaceOnUse"><stop stop-color="#6a7d74"/><stop offset=".25" stop-color="#e2ebde"/><stop offset=".43" stop-color="#8fa69a"/><stop offset=".72" stop-color="#435d51"/><stop offset="1" stop-color="#abc1ae"/></linearGradient>
  <linearGradient id="aw-top" x1="279" y1="280" x2="650" y2="549" gradientUnits="userSpaceOnUse"><stop stop-color="#d1e0c6"/><stop offset=".6" stop-color="#8ca390"/><stop offset="1" stop-color="#5b7768"/></linearGradient>
  <linearGradient id="aw-purple" x1="620" y1="211" x2="760" y2="405" gradientUnits="userSpaceOnUse"><stop stop-color="#d0bfff"/><stop offset=".56" stop-color="#a18dce"/><stop offset="1" stop-color="#635785"/></linearGradient>
  <linearGradient id="aw-screen" x1="367" y1="233" x2="539" y2="337" gradientUnits="userSpaceOnUse"><stop stop-color="#36473f"/><stop offset="1" stop-color="#17251e"/></linearGradient>
  <radialGradient id="aw-orb"><stop stop-color="#faf8df"/><stop offset=".58" stop-color="#ced8be"/><stop offset="1" stop-color="#6f8c77"/></radialGradient>
  <linearGradient id="aw-beam" x1="280" y1="190" x2="345" y2="420" gradientUnits="userSpaceOnUse"><stop stop-color="#efffb3" stop-opacity=".17"/><stop offset="1" stop-color="#efffb3" stop-opacity="0"/></linearGradient>
  <filter id="aw-shadow" x="-30%" y="-40%" width="160%" height="190%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>

<g class="aw-scene" stroke="#121c17" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round">
  <ellipse cx="457" cy="610" rx="315" ry="43" fill="#050a07" opacity=".54" filter="url(#aw-shadow)" stroke="none"/>
  <g class="aw-floor-marks" stroke="#3b4c3e" stroke-width="1.5" opacity=".6"><path d="m91 538 103 47m424 59 150-87M260 606l37 17m454-135 38 17"/><path d="m764 564 16 7-16 9-16-8Z"/></g>
  <!-- Chrome table legs: a distinct open silhouette, not a floating dashboard. -->
  <g class="aw-table-legs"><path d="M225 441v136q0 15 19 18l20-9V452Z" fill="url(#aw-chrome)"/><path d="M562 515v108q0 14 18 13l22-11V510Z" fill="url(#aw-chrome)"/><path d="M726 426v111q0 11 15 12l18-8V414Z" fill="url(#aw-chrome)"/><path d="m264 563 298 57v-18l-298-57Z" fill="#3b5145"/><path d="M239 588v8m339 33v8m164-94v9" stroke="#d2dcc8" stroke-width="5"/></g>
  <path d="M153 397 350 283q15-9 33-2l416 135q17 6 9 20L616 557q-19 13-40 5L156 431q-20-6-17-19Z" fill="#495f51"/>
  <path d="M151 391 352 276q15-9 33-2l414 136q20 7 3 18L611 546q-17 11-35 5L153 418q-21-7-2-27Z" fill="url(#aw-top)"/>
  <path d="m165 403 413 135q19 6 34-4l178-108" stroke="#dce8d0" stroke-width="2" opacity=".55"/>
  <path d="M604 556v14l17-10v-14" fill="#364d3e"/>
  <!-- The cable is an illustrative connection, never a real activity readout. -->
  <path class="aw-wire" d="M457 376c-53 29-9 48 71 27s99-11 118-48" stroke="#324d37" stroke-width="10"/>
  <path class="aw-wire-route" d="M457 376c-53 29-9 48 71 27s99-11 118-48" stroke="#c8ef7d" stroke-width="3"/>
  <path class="aw-packet" d="M457 376c-53 29-9 48 71 27s99-11 118-48" stroke="#f1ffba" stroke-width="5" stroke-dasharray="3 282"/>
  <!-- Articulated desk lamp. -->
  <g class="aw-lamp"><ellipse cx="242" cy="365" rx="44" ry="17" fill="#5c7562"/><ellipse cx="242" cy="358" rx="44" ry="15" fill="#b4c3a6"/><path d="m239 353-40-124 54-68" stroke="#526b58" stroke-width="15"/><path d="m236 349-34-120 53-66" stroke="#c6d3b6" stroke-width="5"/><circle cx="199" cy="228" r="12" fill="#dcdfbe"/><circle cx="199" cy="228" r="4" fill="#566951"/><path d="m251 149 15-10q16 3 26 22l-22 16Z" fill="#d5ddbb"/><path d="M254 152q35-5 53 36l-63 24q-14-26 10-60Z" fill="#dae3be"/><path d="m244 212 63-24" stroke="#f8ffe1" stroke-width="7"/><path d="m248 214-3 152 225 56-165-229Z" fill="url(#aw-beam)" stroke="none"/></g>
  <!-- Rounded data store, its ribs and cables are original vector geometry. -->
  <g class="aw-store" data-aw-focus="treasury">
    <ellipse cx="659" cy="391" rx="90" ry="22" fill="#17291c" opacity=".22" stroke="none"/>
    <path d="m594 342 103-31 52 28v43q0 8-12 11l-105 33q-9 3-17-3l-21-17Z" fill="#6d6387"/>
    <path d="m594 340 103-31 52 28q8 7-3 12l-107 34q-10 3-19-2l-24-23q-10-9-2-18Z" fill="url(#aw-purple)"/>
    <path d="m594 298 103-31 52 28v38q0 8-12 11l-105 33q-9 3-17-3l-21-17Z" fill="#77678f"/>
    <path d="m594 296 103-31 52 28q8 7-3 12l-107 34q-10 3-19-2l-24-23q-10-9-2-18Z" fill="#b6a0de"/>
    <path d="m594 254 103-31 52 28v37q0 8-12 11l-105 33q-9 3-17-3l-21-17Z" fill="#8b79a4"/>
    <path d="m594 252 103-31 52 28q8 7-3 12l-107 34q-10 3-19-2l-24-23q-10-9-2-18Z" fill="#cfbced"/>
    <path d="m635 248 56-17 24 13-58 19Z" fill="#a88ec9" stroke-width="2"/><path d="m647 246 14 8 27-8-14-8Z" fill="#e3d4f7" stroke-width="1.8"/>
    <path d="m648 309 57-18m-57 61 57-18m-57 61 57-18" stroke="#e2d1f1" stroke-width="4"/>
    <g class="aw-leds" fill="#d5f7a0" stroke-width="1.5"><ellipse cx="722" cy="288" rx="4" ry="5"/><ellipse cx="722" cy="331" rx="4" ry="5"/><ellipse cx="722" cy="374" rx="4" ry="5"/></g>
    <path d="M721 234v-30q0-18-24-24" stroke="#798d73" stroke-width="8"/><path d="M721 234v-30q0-18-24-24" stroke="#d1e3a9" stroke-width="2.5"/>
  </g>
  <!-- Broadcast companion, its real-world posture reads like an instrument. -->
  <g class="aw-orb" data-aw-focus="community">
    <path d="m684 163 23-62" stroke="#cadb99" stroke-width="4"/><circle cx="709" cy="94" r="8" fill="#d7f797"/>
    <path class="aw-signal" d="M724 91q14 4 15 17m-15-29q28 5 30 29" stroke="#bfdc89" stroke-width="2.5" opacity=".6"/>
    <ellipse cx="670" cy="160" rx="61" ry="47" transform="rotate(-17 670 160)" fill="url(#aw-orb)"/>
    <path d="M614 162q36 45 107-4" stroke="#6b876b" stroke-width="5"/><path d="M633 123q37-20 64-4" stroke="#f0f4ce" stroke-width="4"/>
    <ellipse cx="674" cy="158" rx="28" ry="24" transform="rotate(-17 674 158)" fill="#273d31"/><ellipse cx="678" cy="155" rx="16" ry="15" fill="#aee09d"/>
    <ellipse cx="682" cy="151" rx="6" ry="7" fill="#e7ffc0" stroke="none"/>
    <path d="m619 172-18 5 3 14 23-3" fill="#90a687"/><path d="m721 140 14-1 4 11-14 5" fill="#cadcaa"/>
  </g>
  <!-- The monitor is the agent: soft casing, expressive screen, small mechanical arms. -->
  <g class="aw-agent" data-aw-focus="workspace">
    <ellipse cx="444" cy="429" rx="86" ry="23" fill="#17251c" opacity=".25" stroke="none"/>
    <path d="M420 367v39l-26 16q-7 5 3 9l69 16q12 2 20-5l12-12q6-6-2-9l-40-16v-43Z" fill="#939f8b"/><path d="m418 407 39 1 36 19-18 9-73-16Z" fill="#e2e4ce"/>
    <path d="M346 177q9-20 39-17l166 16q34 3 36 35l8 126q2 32-23 39l-14 5-10-190Z" fill="#879583"/>
    <path d="M336 190q-1-24 24-23l167 13q32 2 36 30l13 132q3 29-25 35l-166-10q-28-2-31-28Z" fill="url(#aw-ivory)"/>
    <path d="m353 193 168 14q18 1 19 20l10 101q2 18-16 18l-149-9q-15-1-17-17l-12-110q-1-9-3-17Z" fill="url(#aw-screen)"/>
    <path d="m367 206 67 6-63 105Z" fill="#a7c6a1" opacity=".08" stroke="none"/>
    <g class="aw-face">
      <g class="aw-eyes" fill="#d7f6a0" stroke="none"><rect x="400" y="252" width="17" height="32" rx="8.5" transform="rotate(-5 400 252)"/><rect x="484" y="258" width="17" height="32" rx="8.5" transform="rotate(-5 484 258)"/></g>
      <path d="M436 295q18 20 34 2" stroke="#d7f6a0" stroke-width="5"/>
      <path d="m387 289 12 2m111 7 11 1" stroke="#91b58a" stroke-width="4"/>
    </g>
    <g class="aw-screen-community" fill="#d9f5aa" stroke="none"><circle cx="409" cy="263" r="16"/><circle cx="485" cy="269" r="16"/><circle cx="450" cy="304" r="14"/><path d="m424 270 13 22m26 3 13-13m-49-18 38 3" stroke="#95b781" stroke-width="3"/></g>
    <g class="aw-screen-treasury" stroke="#d9f5aa" stroke-width="4"><path d="m450 241 41 25-5 39-38 16-33-21-5-39Z"/><path d="m412 262 36 24 40-19m-40 19v34"/><path d="m430 253 38 23" stroke="#7f9e72"/></g>
    <path d="m387 350 71 5" stroke="#7e8e79" stroke-width="4"/><circle class="aw-power" cx="536" cy="359" r="5" fill="#d9fa9b" stroke-width="1.5"/>
    <path d="m574 216 4 91m-9-72 5 63" stroke="#566e58" stroke-width="2"/>
  </g>
  <!-- Keyboard keys are individually drawn and follow the same desk perspective. -->
  <g class="aw-keyboard"><path d="m349 416 176 54-44 39-188-57Z" fill="#6a7f69"/><path d="m349 409 176 53-44 39-188-57Z" fill="#d2d9b9"/><path d="m349 420 153 46-10 9-154-46Zm-23 15 154 46-12 9-154-45Z" fill="#98ac8d" stroke-width="2"/>
    <path d="m367 420-12 11m34-4-12 11m35-4-13 11m35-4-12 11m35-4-12 11m34-4-11 11m-106-20-10 10m32-3-10 10m33-3-10 10m32-3-10 10m32-3-10 10" stroke="#52694f" stroke-width="2"/>
    <path d="m360 459 75 22 10-8-75-22Z" fill="#e8efcd" stroke-width="2"/>
  </g>
  <g class="aw-arm aw-arm-left"><path d="M352 299q-48 16-31 58l36 57" stroke="#51654f" stroke-width="21"/><path d="M351 298q-39 18-25 56l37 57" stroke="#dee2c7" stroke-width="13"/><circle cx="327" cy="359" r="12" fill="#afbd9e"/><path d="m353 401 18 3q12 3 13 13l-2 11q-3 7-13 4l-20-7q-10-4-6-14Z" fill="#f1efd8"/><path d="m363 417 17 5m-19-12 15 5" stroke="#83947a" stroke-width="2"/></g>
  <g class="aw-arm aw-arm-right"><path d="M569 314q48 20 21 64l-76 67" stroke="#4d634f" stroke-width="21"/><path d="M570 312q40 20 13 61l-76 65" stroke="#d8dfc1" stroke-width="13"/><circle cx="583" cy="377" r="12" fill="#adbd9c"/><path d="m497 431 22 5q9 3 9 12l-9 12q-6 5-13 2l-16-9q-7-5-1-13Z" fill="#f2efd8"/><path d="m502 444 17 7m-23-1 17 8" stroke="#83947a" stroke-width="2"/></g>
  <!-- Small everyday objects ground the scene. -->
  <g class="aw-cup"><ellipse cx="661" cy="468" rx="31" ry="12" fill="#173023" opacity=".3" stroke="none"/><path d="M668 430q35-9 26 16-4 11-22 9" stroke="#dfe5c4" stroke-width="8"/><path d="m630 423 4 38q1 13 19 12 18-1 20-13l3-35Z" fill="#ece9cf"/><ellipse cx="653" cy="425" rx="23" ry="9" fill="#a2ac8b"/><ellipse cx="653" cy="426" rx="16" ry="5" fill="#4f4634" stroke="none"/><path class="aw-steam" d="M648 410q-8-9 0-18m11 17q8-11 2-19" stroke="#cbd7ba" stroke-width="2" opacity=".45"/></g>
  <g class="aw-plant"><ellipse cx="156" cy="516" rx="48" ry="17" fill="#030c07" opacity=".4" stroke="none"/><path d="m121 457 12 49q3 17 30 16 27-1 30-18l8-48Z" fill="#9ca88b"/><ellipse cx="160" cy="456" rx="40" ry="13" fill="#697e5e"/><ellipse cx="160" cy="456" rx="31" ry="8" fill="#30472e"/><path d="M160 455q-4-87 10-119m-12 94-41-41m45 16 40-42" stroke="#8dba69" stroke-width="5"/><path d="M168 377q-39-15-20-48 36 7 20 48Z" fill="#bad994"/><path d="M159 420q-55 4-49-41 37-1 49 41Z" fill="#7da56d"/><path d="M162 410q-4-45 44-54 10 38-44 54Z" fill="#9ec77f"/><path d="M166 366q-2-39 31-55 18 35-31 55Z" fill="#bcd79b"/><path d="m140 474 6 30m30-30-4 30" stroke="#d1dabc" stroke-width="2"/></g>
  <g class="aw-small-details"><path d="m531 496 39 11 12-8-37-11Z" fill="#ded5bb"/><path d="m539 489 37 11" stroke="#716850" stroke-width="2"/><circle cx="753" cy="457" r="3" fill="#c7dba8" stroke="none"/><circle cx="762" cy="452" r="3" fill="#c7dba8" stroke="none"/></g>
</g>
</svg>
`;

const MODES = ['workspace', 'community', 'treasury'];
const LABELS = {
  en: ['Workspace','Community','Treasury','Pause motion','Play motion','Reduced motion','Interactive illustration','Show the next illustration view','Illustration views','projects','live'],
  es: ['Espacio de trabajo','Comunidad','Tesorería','Pausar movimiento','Activar movimiento','Movimiento reducido','Ilustración interactiva','Mostrar la siguiente vista de la ilustración','Vistas de la ilustración','proyectos','en directo'],
  fr: ['Espace de travail','Communauté','Trésorerie','Suspendre les animations','Activer les animations','Animations réduites','Illustration interactive','Afficher la vue suivante de l’illustration','Vues de l’illustration','projets','en direct'],
  de: ['Arbeitsplatz','Community','Projektkasse','Animation pausieren','Animation abspielen','Reduzierte Bewegung','Interaktive Illustration','Nächste Illustrationsansicht zeigen','Illustrationsansichten','Projekte','live'],
  pt: ['Espaço de trabalho','Comunidade','Tesouraria','Pausar movimento','Ativar movimento','Movimento reduzido','Ilustração interativa','Mostrar a próxima vista da ilustração','Vistas da ilustração','projetos','ao vivo'],
  it: ['Spazio di lavoro','Comunità','Tesoreria','Pausa animazioni','Attiva animazioni','Movimento ridotto','Illustrazione interattiva','Mostra la vista successiva dell’illustrazione','Viste dell’illustrazione','progetti','in diretta'],
  ja: ['ワークスペース','コミュニティ','資金庫','動きを一時停止','動きを再生','動きを軽減','インタラクティブなイラスト','イラストの次の表示に切り替え','イラストの表示','プロジェクト','ライブ'],
  ko: ['작업 공간','커뮤니티','프로젝트 금고','움직임 일시 정지','움직임 재생','움직임 줄임','인터랙티브 일러스트','다음 일러스트 보기','일러스트 보기','프로젝트','라이브'],
  zh: ['工作空间','社区','项目资金库','暂停动画','播放动画','减少动画','互动插画','显示下一个插画视图','插画视图','个项目','正在直播'],
  ar: ['مساحة العمل','المجتمع','خزينة المشروع','إيقاف الحركة','تشغيل الحركة','حركة مخفّفة','رسم تفاعلي','عرض المشهد التوضيحي التالي','مشاهد الرسم','مشاريع','مباشر'],
};
const mounted = new WeakMap();
let sequence = 0;
const languageOf = value => String(value || 'en').toLowerCase().split(/[-_]/)[0];

export function mountAutonomWorld(element) {
  if (!element || element.nodeType !== 1) throw new TypeError('An illustration mount element is required');
  if (mounted.has(element)) return mounted.get(element);
  const doc = element.ownerDocument, win = doc.defaultView;
  const prefix = `autonom-world-${++sequence}-`, canvasId = `${prefix}canvas`, captionId = `${prefix}caption`;
  element.classList.add('autonom-world');
  element.dataset.mode = MODES.includes(element.dataset.mode) ? element.dataset.mode : 'workspace';
  element.dataset.motion = 'paused';
  element.innerHTML = `<button type="button" class="aw-art-button" id="${canvasId}" aria-describedby="${captionId}">${ART.replaceAll('id="aw-', 'id="'+prefix).replaceAll('url(#aw-', 'url(#'+prefix)}</button>
    <div class="aw-toolbar"><div class="aw-mode-group" role="group">${MODES.map(mode => `<button type="button" class="aw-mode" data-world-mode="${mode}" aria-controls="${canvasId}" aria-pressed="false"></button>`).join('')}</div>
    <button type="button" class="aw-motion" aria-pressed="false"><span class="aw-motion-icon" aria-hidden="true"></span><span class="aw-motion-label"></span></button></div>
    <p class="aw-caption" id="${captionId}"><span class="aw-caption-label"></span><output class="aw-directory" hidden></output></p>
    <span class="aw-sr-only aw-status" role="status" aria-live="polite" aria-atomic="true"></span>`;
  const art = element.querySelector('.aw-art-button'), modeButtons = [...element.querySelectorAll('[data-world-mode]')];
  const pause = element.querySelector('.aw-motion'), pauseLabel = element.querySelector('.aw-motion-label');
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)'), finePointer = win.matchMedia('(hover: hover) and (pointer: fine)');
  const removers = [];
  let mode = element.dataset.mode, paused = false, inView = !win.IntersectionObserver, pageActive = true, destroyed = false, tapTimer = null, directory = null;
  let labels = LABELS.en;
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    removers.push(() => target.removeEventListener(name, callback, options));
  };
  const mediaListen = (media, callback) => {
    if (media.addEventListener) listen(media, 'change', callback);
    else { media.addListener(callback); removers.push(() => media.removeListener(callback)); }
  };
  function resetParallax() {
    element.style.removeProperty('--aw-x'); element.style.removeProperty('--aw-y'); element.style.removeProperty('--aw-r');
  }
  function motion() {
    if (destroyed) return;
    const running = !paused && !reduced.matches && !doc.hidden && inView && pageActive;
    element.dataset.motion = running ? 'running' : 'paused';
    pause.disabled = reduced.matches;
    pause.setAttribute('aria-pressed', String(paused || reduced.matches));
    pauseLabel.textContent = labels[reduced.matches ? 5 : paused ? 4 : 3];
    pause.setAttribute('aria-label', pauseLabel.textContent);
    if (!running) resetParallax();
  }
  function renderDirectory() {
    const output = element.querySelector('.aw-directory');
    output.hidden = !directory;
    output.textContent = directory ? `${directory.total} ${labels[9]} · ${directory.live} ${labels[10]}` : '';
  }
  function translate() {
    labels = LABELS[languageOf(doc.documentElement.lang)] || LABELS.en;
    modeButtons.forEach((button,index) => { button.textContent = labels[index]; });
    element.querySelector('.aw-mode-group').setAttribute('aria-label', labels[8]);
    element.querySelector('.aw-caption-label').textContent = labels[6];
    art.setAttribute('aria-label', `${labels[7]}. ${labels[MODES.indexOf(mode)]}.`);
    renderDirectory(); motion();
  }
  function setMode(next, announce = false) {
    if (destroyed || !MODES.includes(next)) return false;
    mode = next; element.dataset.mode = next;
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.worldMode === mode)));
    art.setAttribute('aria-label', `${labels[7]}. ${labels[MODES.indexOf(mode)]}.`);
    if (announce) {
      element.querySelector('.aw-status').textContent = labels[MODES.indexOf(mode)];
      element.dispatchEvent(new win.CustomEvent('autonom:world-mode', {bubbles:true, detail:{mode}}));
    }
    return true;
  }
  function setPaused(value) { if (!destroyed) { paused = Boolean(value); motion(); } }
  modeButtons.forEach(button => listen(button, 'click', () => setMode(button.dataset.worldMode, true)));
  listen(pause, 'click', () => setPaused(!paused));
  listen(art, 'click', () => {
    setMode(MODES[(MODES.indexOf(mode)+1)%MODES.length], true);
    if (reduced.matches) return;
    element.dataset.tapped = 'true';
    win.clearTimeout(tapTimer);
    tapTimer = win.setTimeout(() => { delete element.dataset.tapped; tapTimer = null; }, 220);
  });
  listen(art, 'pointermove', event => {
    if (!finePointer.matches || event.pointerType === 'touch' || element.dataset.motion !== 'running') return;
    const rect = art.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(-1, Math.min(1, (event.clientX-rect.left)/rect.width*2-1));
    const y = Math.max(-1, Math.min(1, (event.clientY-rect.top)/rect.height*2-1));
    element.style.setProperty('--aw-x', `${(x*5).toFixed(2)}px`);
    element.style.setProperty('--aw-y', `${(y*3).toFixed(2)}px`);
    element.style.setProperty('--aw-r', `${(x*.45).toFixed(2)}deg`);
  }, {passive:true});
  listen(art, 'pointerleave', resetParallax);
  listen(art, 'pointercancel', resetParallax);
  listen(doc, 'visibilitychange', motion);
  listen(win, 'pagehide', event => { pageActive = false; motion(); if (!event.persisted) destroy(); });
  listen(win, 'pageshow', () => { pageActive = true; motion(); });
  mediaListen(reduced, motion); mediaListen(finePointer, resetParallax);
  listen(doc, 'autonom:directory', event => {
    const value = event.detail;
    if (value == null) directory = null;
    else if (Number.isSafeInteger(value.total) && value.total >= 0 && Number.isSafeInteger(value.live) && value.live >= 0 && value.live <= value.total)
      directory = {total:value.total, live:value.live};
    else return;
    renderDirectory();
  });
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    const entry = entries.find(item => item.target === element);
    if (!entry) return;
    inView = entry.isIntersecting && entry.intersectionRatio >= .08; motion();
  }, {threshold:[0,.08]}) : null;
  intersection?.observe(element);
  const localeObserver = new win.MutationObserver(translate);
  localeObserver.observe(doc.documentElement, {attributes:true, attributeFilter:['lang']});
  function destroy() {
    if (destroyed) return;
    destroyed = true; element.dataset.motion = 'paused'; resetParallax();
    win.clearTimeout(tapTimer); intersection?.disconnect(); localeObserver.disconnect();
    removers.forEach(remove => remove()); mounted.delete(element); delete element.dataset.tapped;
  }
  const controller = {setMode, setPaused, destroy};
  mounted.set(element, controller);
  translate(); setMode(mode); motion();
  return controller;
}

export function mountAutonomWorlds(root = document) {
  return [...root.querySelectorAll('[data-autonom-world]')].map(mountAutonomWorld);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAutonomWorlds(), {once:true});
  else mountAutonomWorlds();
}
