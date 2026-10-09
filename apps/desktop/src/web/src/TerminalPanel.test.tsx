// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalPanel } from './App';

afterEach(() => { cleanup(); delete window.techunterDesktop; });
it('handles output and exit before IPC resolves without getting stuck running', async () => {
  let output!: Parameters<NonNullable<typeof window.techunterDesktop>['onOutput']>[0];
  let exit!: Parameters<NonNullable<typeof window.techunterDesktop>['onExit']>[0];
  window.techunterDesktop = {
    onOutput: listener => { output = listener; return () => {}; },
    onExit: listener => { exit = listener; return () => {}; },
    run: vi.fn(async () => {
      output({ sessionId: 'other', stream: 'stdout', data: 'foreign output' });
      output({ sessionId: 'own', stream: 'stdout', data: 'own output' });
      exit({ sessionId: 'own', exitCode: 0 });
      return { sessionId: 'own' };
    }),
  } satisfies Pick<NonNullable<typeof window.techunterDesktop>, 'onOutput' | 'onExit' | 'run'> as unknown as NonNullable<typeof window.techunterDesktop>;
  render(<TerminalPanel cwd="fixture" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '执行' }));
  await act(async () => {});
  expect(screen.getByText(/own output/)).toBeTruthy();
  expect(screen.queryByText(/foreign output/)).toBeNull();
  expect((screen.getByRole('button', { name: '执行' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole('button', { name: '终止' })).toBeNull();
});

it('reports startup failures and allows a retry', async () => {
  window.techunterDesktop = {
    onOutput: () => () => {}, onExit: () => () => {},
    run: vi.fn().mockRejectedValue(new Error('invalid directory')),
  } as unknown as NonNullable<typeof window.techunterDesktop>;
  render(<TerminalPanel cwd="fixture" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '执行' }));
  await screen.findByText(/启动失败：invalid directory/);
  expect((screen.getByRole('button', { name: '执行' }) as HTMLButtonElement).disabled).toBe(false);
});
