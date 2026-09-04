import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AssetVcsConfig } from '../types.js';

const execFileAsync = promisify(execFile);

function buildArgs(args: string[], cfg?: AssetVcsConfig): string[] {
  const auth: string[] = [];
  if (cfg?.username) auth.push('--username', cfg.username);
  if (cfg?.password) auth.push('--password', cfg.password, '--no-auth-cache');
  return [...auth, '--non-interactive', ...args];
}

export async function detectSvnInfo(path = '.'): Promise<{ url: string; username: string } | null> {
  try {
    const { stdout } = await execFileAsync('svn', ['info', path]);
    const urlMatch = stdout.match(/^URL:\s+(.+)$/m);
    const userMatch = stdout.match(/^Last Changed Author:\s+(.+)$/m);
    if (!urlMatch) return null;
    return { url: urlMatch[1].trim(), username: userMatch?.[1].trim() ?? '' };
  } catch {
    return null;
  }
}

export async function svnLock(paths: string[], cfg: AssetVcsConfig): Promise<void> {
  await execFileAsync('svn', buildArgs(['lock', ...paths], cfg));
}

export async function svnUnlock(paths: string[], cfg: AssetVcsConfig): Promise<void> {
  await execFileAsync('svn', buildArgs(['unlock', ...paths], cfg));
}

// Returns the committed revision string (e.g. "r1234"), or null if there were no local changes.
export async function svnCommit(paths: string[], message: string, cfg: AssetVcsConfig): Promise<string | null> {
  const { stdout } = await execFileAsync('svn', buildArgs(['commit', ...paths, '-m', message], cfg));
  const match = stdout.match(/Committed revision (\d+)\./);
  return match ? `r${match[1]}` : null;
}

export async function svnRevert(paths: string[], cfg: AssetVcsConfig): Promise<void> {
  await execFileAsync('svn', buildArgs(['revert', '--depth', 'infinity', ...paths], cfg));
}
