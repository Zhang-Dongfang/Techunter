export const MAX_TERMINAL_OUTPUT = 100_000;
export function appendTerminalOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_TERMINAL_OUTPUT) return combined;
  const notice = '[较早的输出已省略，仅显示最近内容]\n';
  return notice + combined.slice(-(MAX_TERMINAL_OUTPUT - notice.length));
}
