import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal({ showSectionPrefix: false }) as Parameters<typeof marked.use>[0]);

export function renderMarkdown(text: string): string {
  return marked(text) as string;
}
