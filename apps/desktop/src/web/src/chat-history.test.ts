import { expect, it } from 'vitest';
import { chatHistory } from './chat-history';

it('continues long conversations and bounds large replies without sending failed responses', () => {
  const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: String(i) }));
  const result = chatHistory([...messages, { role: 'assistant', content: 'x'.repeat(30_000) }, { role: 'assistant', content: 'request failed', error: true }]);
  expect(result).toHaveLength(16);
  expect(result[0]?.content).toBe('9');
  expect(result.at(-1)?.content).toHaveLength(20_000);
  expect(result.some(message => message.content === 'request failed')).toBe(false);
});
