import Conf from 'conf';
import chalk from 'chalk';

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
 * Check npm for a newer version of techunter.
 * Uses a 24-hour cache so it doesn't hit npm on every startup.
 * Returns a formatted notice string if an update is available, otherwise null.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
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

  if (latest && isNewer(latest, currentVersion)) {
    return (
      chalk.yellow('  ┌─────────────────────────────────────────────────┐\n') +
      chalk.yellow('  │') +
      chalk.bold(`  Update available: v${currentVersion} → v${latest}`.padEnd(49)) +
      chalk.yellow('│\n') +
      chalk.yellow('  │') +
      chalk.dim('  Run: npm install -g techunter'.padEnd(49)) +
      chalk.yellow('│\n') +
      chalk.yellow('  └─────────────────────────────────────────────────┘')
    );
  }

  return null;
}
