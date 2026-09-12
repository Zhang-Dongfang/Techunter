import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'th_gh_v1';
const SESSION_HASH = /^[a-f0-9]{64}$/;

type GitHubOAuthStateClaims = {
  version: 1;
  sessionTokenHash: string;
  expiresAt: number;
  nonce: string;
  connectionVersion?: string;
};

function signature(payload: string, key: string): string {
  return createHmac('sha256', key).update(`${PREFIX}.${payload}`).digest('base64url');
}

export function issueGitHubOAuthState(
  sessionTokenHash: string,
  key: string,
  now = Date.now(),
  connectionVersion?: string,
): string {
  if (!SESSION_HASH.test(sessionTokenHash)) throw new Error('GitHub OAuth session hash is invalid.');
  const claims: GitHubOAuthStateClaims = {
    version: 1,
    sessionTokenHash,
    expiresAt: now + 10 * 60_000,
    nonce: randomBytes(24).toString('base64url'),
    ...(connectionVersion ? { connectionVersion } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${PREFIX}.${payload}.${signature(payload, key)}`;
}

export function verifyGitHubOAuthState(
  state: string,
  key: string,
  now = Date.now(),
): GitHubOAuthStateClaims {
  const [prefix, payload, suppliedSignature, extra] = state.split('.');
  if (prefix !== PREFIX || !payload || !suppliedSignature || extra !== undefined) {
    throw new Error('GitHub OAuth state is invalid.');
  }
  const expected = signature(payload, key);
  const left = Buffer.from(expected);
  const right = Buffer.from(suppliedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error('GitHub OAuth state signature is invalid.');
  }
  let claims: GitHubOAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GitHubOAuthStateClaims;
  } catch {
    throw new Error('GitHub OAuth state payload is invalid.');
  }
  if (
    claims.version !== 1 || !SESSION_HASH.test(claims.sessionTokenHash) ||
    !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now ||
    typeof claims.nonce !== 'string' || claims.nonce.length < 20 ||
    (claims.connectionVersion !== undefined && !/^[a-f0-9-]{36}$/.test(claims.connectionVersion))
  ) throw new Error('GitHub OAuth state has expired or is invalid.');
  return claims;
}
