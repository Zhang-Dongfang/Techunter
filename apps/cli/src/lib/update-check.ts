import Conf from 'conf';
import chalk from 'chalk';
import { execFile } from 'node:child_process';

const PACKAGE_NAME = 'techunter';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

const cache = new Conf<UpdateCache>({
  projectName: 'techunter-update-cache',
  defaults: { lastChecked: 0, latestVersion: '' },
});

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const { fetch } = await import('undici');
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/**
 * Returns the latest version string if newer than current, otherwise null.
 * Results are cached for 24 hours.
 */
export async function getAvailableUpdate(currentVersion: string): Promise<string | null> {
  const now = Date.now();
  const lastChecked = cache.get('lastChecked');
  let latest = cache.get('latestVersion');

  if (!latest || now - lastChecked > CHECK_INTERVAL_MS) {
    const fetched = await fetchLatestVersion();
    if (fetched) {
      latest = fetched;
      cache.set('latestVersion', fetched);
      cache.set('lastChecked', now);
    }
  }

  return latest && isNewer(latest, currentVersion) ? latest : null;
}

/**
 * Run `npm install -g techunter` and resolve with the new version on success,
 * or reject with the error message on failure.
 */
export function installUpdate(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('npm', ['install', '-g', PACKAGE_NAME], { shell: true }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(cache.get('latestVersion'));
      }
    });
  });
}

/**
 * Checks for an update, kicks off auto-install in background if one is found.
 * Prints progress directly to stdout so it is visible between prompts.
 * Resolves immediately with a cleanup function (noop if no update was started).
 */
export async function startAutoUpdate(currentVersion: string): Promise<void> {
  // Use a short race so we don't slow down startup
  const latest = await Promise.race([
    getAvailableUpdate(currentVersion),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);

  if (!latest) return;

  console.log(
    chalk.cyan('\n  ↑ Auto-updating to v' + latest + '…') +
    chalk.dim(' (running in background)\n')
  );

  // Fire-and-forget — resolve instantly, print result when done
  installUpdate().then((installedVersion) => {
    console.log(
      '\n' +
      chalk.green('  ✔ Updated to v' + (installedVersion || latest)) +
      chalk.dim('  —  restart tch to use the new version\n') +
      chalk.cyan('  You › ')   // redraw the prompt hint
    );
  }).catch((err: Error) => {
    console.log(
      '\n' +
      chalk.red('  ✘ Auto-update failed: ') + chalk.dim(err.message) + '\n' +
      chalk.dim('  Run manually: npm install -g techunter\n') +
      chalk.cyan('  You › ')
    );
  });
}
