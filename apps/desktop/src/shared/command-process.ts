import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { windowsCommandInvocation } from './windows-command-job.js';

export type CommandResult = { exitCode: number | null; cancelled: boolean };
export type ManagedCommand = {
  process: ChildProcessWithoutNullStreams;
  completed: Promise<CommandResult>;
  cancel(): Promise<void>;
};
const commands = new Set<ManagedCommand>();
let stopping = false;

export function startCommand(command: string, cwd: string, timeoutMs?: number): ManagedCommand {
  if (stopping) throw new Error('应用正在退出，不能启动新命令。');
  const windows = process.platform === 'win32';
  const invocation = windows ? windowsCommandInvocation(command) : { args: ['-lc', command], env: process.env };
  const child = spawn(windows ? 'powershell.exe' : (process.env['SHELL'] || '/bin/sh'),
    invocation.args, { cwd, env: invocation.env, windowsHide: true, stdio: 'pipe', detached: !windows });
  let cancelled = false, closed = false, timer: NodeJS.Timeout | undefined;
  const completed = new Promise<CommandResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', exitCode => { closed = true; resolve({ exitCode, cancelled }); });
  });
  const managed: ManagedCommand = {
    process: child, completed,
    async cancel() {
      if (!closed && !cancelled) {
        cancelled = true;
        if (child.pid) {
          if (windows) child.kill(); // The helper owns the complete Job Object.
          else {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          }
        }
      }
      await completed;
    },
  };
  commands.add(managed);
  void completed.finally(() => { if (timer) clearTimeout(timer); commands.delete(managed); }).catch(() => {});
  if (timeoutMs !== undefined) timer = setTimeout(() => { void managed.cancel().catch(() => {}); }, timeoutMs);
  return managed;
}

export async function stopAllCommands(): Promise<void> {
  // Close the registry before awaiting: no new terminal or setup command can race shutdown.
  stopping = true;
  const results = await Promise.allSettled([...commands].map(command => command.cancel()));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
