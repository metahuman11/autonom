// Presentation only: no requests, timers that send, optimistic messages or authority.
(() => {
  const states = new WeakMap(), animations = new Set();
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const motionAllowed = () => !preference.matches && !document.hidden;
  function animate(node, frames, options = {}) {
    if (!node?.animate || !motionAllowed()) return;
    const animation = node.animate(frames, { duration: 280, easing: 'cubic-bezier(.2,.75,.25,1)', ...options });
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
  }
  function stopMotion() { for (const animation of animations) animation.cancel(); animations.clear(); }
  preference.addEventListener('change', stopMotion);
  document.addEventListener('visibilitychange', () => { document.documentElement.classList.toggle('chat-motion-hidden',document.hidden); if (document.hidden) stopMotion(); });
  const nearBottom = box => box.scrollHeight - box.clientHeight - box.scrollTop < 80;
  function stateFor(box) {
    if (states.has(box)) return states.get(box);
    const jump = document.createElement('button');
    jump.type = 'button'; jump.className = 'chat-jump'; jump.hidden = true;
    jump.setAttribute('aria-label', 'Jump to new messages'); box.after(jump);
    const state = { initialized: false, unread: 0, jump, html: null, followingUntil: 0 };
    states.set(box, state);
    jump.addEventListener('click', () => {
      state.followingUntil = performance.now() + 600;
      box.scrollTo({ top: box.scrollHeight, behavior: motionAllowed() ? 'smooth' : 'instant' });
      state.unread = 0; jump.hidden = true;
    });
    box.addEventListener('scroll', () => { if (nearBottom(box)) { state.unread = 0; jump.hidden = true; } }, { passive: true });
    for (const event of ['wheel','touchstart']) box.addEventListener(event, () => { state.followingUntil = 0; }, { passive: true });
    return state;
  }
  function render(box, html) {
    const state = stateFor(box);
    if (state.html === html && state.initialized) return;
    const first = !state.initialized, follow = first || nearBottom(box) || state.followingUntil > performance.now(), previousScroll = box.scrollTop;
    const top = box.getBoundingClientRect().top;
    const anchor = [...box.children].find(node => node.getBoundingClientRect().bottom > top);
    const anchorId = anchor?.dataset.chatId, anchorOffset = anchor?.getBoundingClientRect().top - top;
    const template = document.createElement('template'); template.innerHTML = html;
    const existing = new Map([...box.children].filter(node => node.dataset.chatId).map(node => [node.dataset.chatId, node]));
    const next = [], entering = [], replies = [];
    for (const incoming of template.content.children) {
      const key = incoming.dataset.chatId, current = key && existing.get(key);
      if (!current) { next.push(incoming); if (key) entering.push(incoming); continue; }
      if (current.innerHTML !== incoming.innerHTML || current.className !== incoming.className) {
        const hadReply = current.querySelector('.reply')?.textContent;
        const focus = current.contains(document.activeElement) ? document.activeElement?.getAttribute('data-chat-reply') : null;
        current.className = incoming.className;
        current.innerHTML = incoming.innerHTML;
        const reply = current.querySelector('.reply');
        if (reply && reply.textContent !== hadReply) replies.push(reply);
        if (focus !== null) current.querySelector('[data-chat-reply]')?.focus({ preventScroll: true });
      }
      next.push(current);
    }
    const keep = new Set(next);
    for (const node of [...box.children]) if (!keep.has(node)) node.remove();
    next.forEach((node, index) => { if (box.children[index] !== node) box.insertBefore(node, box.children[index] || null); });
    state.html = html; state.initialized = true;
    box.dataset.chatMarkup = html;
    if (!first) {
      entering.slice(-6).forEach((node, i) => animate(node, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay: i * 24 }));
      replies.slice(-3).forEach(node => animate(node, [{ opacity: .25, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }]));
    }
    if (follow) { box.scrollTop = box.scrollHeight; state.unread = 0; state.jump.hidden = true; }
    else {
      const retained = next.find(node => anchorId && node.dataset.chatId === anchorId);
      box.scrollTop = retained ? previousScroll + retained.getBoundingClientRect().top - top - anchorOffset : previousScroll;
      state.unread += first ? 0 : entering.length;
      if (state.unread) { state.jump.textContent = `${state.unread} new message${state.unread === 1 ? '' : 's'} ↓`; state.jump.hidden = false; }
    }
  }
  function leave(box) {
    const state = states.get(box);
    if (state) { state.initialized = false; state.html = null; state.jump.hidden = true; state.unread = 0; }
  }
  let sendTimer;
  function send(phase) {
    const form = document.getElementById('msgForm'), button = document.getElementById('sendMessage');
    if (!form || !button) return;
    clearTimeout(sendTimer);
    let status = document.getElementById('chatSendStatus');
    if (!status) { status = document.createElement('div'); status.id = 'chatSendStatus'; status.className = 'chat-send-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.after(status); }
    const labels = { sending: ['Sending', 'Sending your message…'], authorizing: ['Approve', 'Approve chat in your wallet'], sent: ['Sent', 'Message sent'], error: ['Retry', 'Not sent · your message is still here'] };
    if (!labels[phase]) return;
    form.dataset.sendState = phase;
    form.setAttribute('aria-busy', String(phase === 'sending' || phase === 'authorizing'));
    button.innerHTML = '<span class="chat-send-icon" aria-hidden="true"></span><span>' + labels[phase][0] + '</span>';
    status.textContent = labels[phase][1]; status.dataset.state = phase;
    if (phase === 'sent') {
      animate(button, [{ transform: 'scale(.95)' }, { transform: 'scale(1)' }], { duration: 200 });
      sendTimer = setTimeout(() => { delete form.dataset.sendState; button.textContent = 'Send'; status.textContent = ''; }, 1800);
    }
  }
  window.GatewayChatMotion = { render, leave, send, animate };
})();
