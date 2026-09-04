import chalk from 'chalk';

export function formatInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => {
      if (typeof v === 'number') return `${k}=${v}`;
      if (typeof v === 'string') {
        if (k === 'body' || v.length > 50) return `${k}=[${v.length} chars]`;
        return `${k}="${v}"`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join('  ');
}

export function summarize(result: string): string {
  const first = result.split('\n').find((l) => l.trim()) ?? result;
  return first.length > 100 ? first.slice(0, 97) + '...' : first;
}

export function printToolCall(name: string, input: Record<string, unknown>): void {
  const params = formatInput(input);
  console.log(`  ${chalk.cyan('→')} ${chalk.bold(name)}${params ? '  ' + chalk.dim(params) : ''}`);
}

export function printToolResult(result: string): void {
  const ok = !result.startsWith('Error:');
  const icon = ok ? chalk.green('✓') : chalk.red('✗');
  console.log(`  ${icon} ${chalk.dim(summarize(result))}`);
}
