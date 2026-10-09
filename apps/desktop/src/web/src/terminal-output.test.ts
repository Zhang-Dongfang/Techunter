import { expect, it } from 'vitest';
import { appendTerminalOutput, MAX_TERMINAL_OUTPUT } from './terminal-output';

it('keeps recent output bounded even when a single command floods the terminal', () => {
  const result = appendTerminalOutput('old', 'x'.repeat(1_000_000) + 'latest failure');
  expect(result.length).toBe(MAX_TERMINAL_OUTPUT);
  expect(result).toContain('较早的输出已省略');
  expect(result.endsWith('latest failure')).toBe(true);
});
