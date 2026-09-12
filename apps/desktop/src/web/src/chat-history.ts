import type { AgentChatMessage } from '@techunter/core';

/** Keep the wire payload within the API's history and per-message limits. */
export function chatHistory(messages: Array<AgentChatMessage & { error?: boolean }>): AgentChatMessage[] {
  return messages.filter(message => !message.error).slice(-16)
    .map(({ role, content }) => ({ role, content: content.slice(-20_000) }));
}
