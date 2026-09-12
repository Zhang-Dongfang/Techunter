import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startCommand, stopAllCommands, type ManagedCommand } from './command-process.js';

const roots: string[] = [], running: ManagedCommand[] = [];
const pids = new Set<number>();
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map(command => command.cancel()));
  for (const pid of pids) { try { process.kill(pid); } catch { /* already terminated */ } }
  pids.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('techunter-command-')) throw new Error('Unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'techunter-command-')); roots.push(root);
  const helper = path.join(root, 'helper.cjs'), started = path.join(root, 'started.json'), finished = path.join(root, 'finished.txt');
  await fs.writeFile(helper, `const fs = require('node:fs');
if (process.argv[2] === 'parent') {
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'child', ...process.argv.slice(3)], {stdio:'ignore', detached:true, windowsHide:true}); child.unref();
} else {
  fs.writeFileSync(process.argv[3], JSON.stringify({pid:process.pid}));
  setTimeout(() => fs.writeFileSync(process.argv[4], 'late write'), 5000);
}`);
  return { root, helper, started, finished, command: `& ${quote(process.execPath)} ${quote(helper)} parent ${quote(started)} ${quote(finished)}` };
}

async function startedPid(file: string): Promise<number> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const pid = Number(JSON.parse(await fs.readFile(file, 'utf8')).pid); pids.add(pid); return pid; } catch { /* wait for native startup */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Command descendant did not start');
}
async function assertStopped(pid: number, finished: string) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { pids.delete(pid); expect(await fs.stat(finished).catch(() => null)).toBeNull(); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Command descendant survived cleanup');
}

it.skipIf(process.platform !== 'win32')('preserves UTF-8 output and failure exit codes without PowerShell XML', async () => {
  const command = startCommand("Write-Output '中文🙂'; [Console]::Error.WriteLine('stderr marker'); exit 7", os.tmpdir()); running.push(command);
  let stdout = '', stderr = '';
  command.process.stdout.on('data', data => { stdout += data.toString(); });
  command.process.stderr.on('data', data => { stderr += data.toString(); });
  expect(await command.completed).toEqual({ exitCode: 7, cancelled: false });
  expect(stdout).toContain('中文🙂'); expect(stderr).toContain('stderr marker'); expect(stderr).not.toContain('CLIXML');
});

it.skipIf(process.platform !== 'win32')('manual cancellation kills descendants even after their shell and immediate parent exit', async () => {
  const f = await fixture(); const command = startCommand(f.command, f.root); running.push(command);
  const pid = await startedPid(f.started);
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { windowsHide: true, stdio: 'ignore' });
  pids.add(unrelated.pid!);
  try {
    await command.cancel();
    expect((await command.completed).cancelled).toBe(true);
    await assertStopped(pid, f.finished);
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  } finally { unrelated.kill(); await new Promise(resolve => unrelated.once('close', resolve)); pids.delete(unrelated.pid!); }
});

it.skipIf(process.platform !== 'win32')('timeout stops the whole command job before a descendant can write again', async () => {
  const f = await fixture(); const command = startCommand(f.command, f.root, 4000); running.push(command);
  const pid = await startedPid(f.started);
  expect((await command.completed).cancelled).toBe(true);
  await assertStopped(pid, f.finished);
});

it.skipIf(process.platform !== 'win32')('shutdown stops commands from the shared registry and prevents new work', async () => {
  const f = await fixture(); const command = startCommand(f.command, f.root); running.push(command);
  const pid = await startedPid(f.started);
  await stopAllCommands();
  await assertStopped(pid, f.finished);
  expect(() => startCommand('Write-Output should-not-start', f.root)).toThrow('正在退出');
});
