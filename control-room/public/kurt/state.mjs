// Read-only presentation of the existing token feed, never a second agent loop.
export function kurtState(token) {
  if (!token) return { mode: 'idle', label: 'Connecting to the community…', online: false };
  const vps = token.vps || {}, health = vps.health || {};
  const paused = token.funding?.state === 'paused' || token.lock?.state === 'paused' ||
    token.agent?.state === 'paused' || health.status === 'paused';
  const locked = token.lock?.state === 'locked';
  const attention = vps.reconciliationRequired === true || health.status === 'attention_required' ||
    ['stopping', 'reconciliation_required'].includes(vps.phase);
  // A rented server or a past stream event is not a fresh AI connection.
  // Health is authoritative when present; runtime acknowledgment is the older
  // API fallback. Missing evidence must never become an "Online" claim.
  const acknowledgedOnline = typeof health.agentOnline === 'boolean'
    ? health.agentOnline : token.runtime?.online === true;
  const online = !paused && !locked && !attention && vps.mode === 'real' &&
    vps.state === 'running' && acknowledgedOnline;
  const working = online && (token.messages || []).some(m => !m.reply && m.chatState === 'working');
  const label = paused ? 'Paused · your community is still here'
    : locked ? 'Waiting for community funding'
    : attention ? 'Paused · an operator check is needed'
    : vps.mode === 'sim' ? 'Simulation · no live AI connection'
    : ['renting', 'booting'].includes(vps.phase) || health.status === 'starting' ? 'Getting ready · the machine is starting'
    : working ? 'Thinking about a community message…'
    : online ? 'Online · ready for the community'
    : vps.state === 'running' ? 'Reconnecting · waiting for a fresh agent update'
    : 'Offline · previous conversations are available';
  return { mode: working ? 'thinking' : 'idle', label, online };
}

export function latestReply(token) {
  // The API delivers messages oldest first; do not mutate or evaluate its text.
  const messages = Array.isArray(token?.messages) ? token.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const reply = messages[i]?.reply;
    if (reply && typeof reply.text === 'string' && reply.text.trim())
      return { id: String(reply.id || messages[i].id || ''), text: reply.text.slice(0, 6000) };
  }
  return null;
}
