// Routing is a UX aid, never an authorization check. Chat cannot grant tools.
export function chatAudience(text) {
  const value = String(text).normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '').trim();
  const addressed = /^@?kurt\b[\s,:-]*/i.test(value);
  const body = value.replace(/^@?kurt\b[\s,:-]*/i, '');
  const action = /^(?:(?:please|can you|could you|would you|lütfen|lutfen)\s+)*(?:build|create|deploy|publish|buy|burn|sell|transfer|send|execute|run|change|update|delete|install|mint|write)\b/i.test(body)
    || /(?:site|websitesi|token|coin|logo|banner|kod|dosya|tweet|dolar|\$\s*\d+).{0,100}\b(?:yap|oluştur|olustur|yayınla|yayinla|al|sat|yak|gönder|gonder|çalıştır|calistir|değiştir|degistir)(?:\s|[.!?]|$)/iu.test(body)
    || /^\/research\b/i.test(value);
  if (action) return 'rules';
  return addressed ? 'agent' : 'community';
}

export function chatRules(t, settings) {
  const voting = t.governanceVersion === 2
    ? `Hold more than 1% of total supply to propose. After the ${settings.votingHours}-hour vote ends, Yes must represent more than 15% of total supply and exceed No.`
    : `To propose, hold at least ${settings.proposalMinBps / 100}% of eligible supply. Voting lasts ${settings.votingHours} hours, needs ${settings.quorumBps / 100}% participation and more than ${settings.passBps / 100}% Yes voting weight.`;
  return `I cannot start tasks from chat. Use “Suggest an idea” so the community can review and vote. ${voting} Approval does not override safety, available tools or the project budget. Nothing was started or spent from this message.`;
}

export function needsAgentReply(message) {
  return message?.audience === 'agent' && !message.permissions?.length && !message.cancelledAt && !message.revokedAt;
}
