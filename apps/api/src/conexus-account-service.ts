import { config } from './config.js';
import { httpError } from './errors.js';

export interface ConexusAuthorization {
  runTicket: string;
  audience: string;
  publicationSlug: string;
  expiresAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: 'user' | 'admin';
    status: string;
    monthlyTokenLimit: number;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class ConexusAccountService {
  async introspect(runTicket: string, audience: string): Promise<ConexusAuthorization> {
    const value = config();
    const response = await fetch(`${value.conexus.apiUrl}/v1/runtime/run-tickets/introspect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runTicket}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience, publicationSlug: value.conexus.publicationSlug }),
    });
    const payload = record(await response.json().catch(() => null));
    if (!response.ok) {
      const nested = record(payload['error']);
      throw httpError(String(nested['message'] || payload['message'] || 'Conexus 授权失败。'), response.status < 500 ? response.status : 502);
    }
    const user = record(payload['user']);
    const result: ConexusAuthorization = {
      runTicket,
      audience: String(payload['audience'] || ''),
      publicationSlug: String(payload['publicationSlug'] || ''),
      expiresAt: String(payload['expiresAt'] || ''),
      user: {
        id: String(user['id'] || ''),
        email: String(user['email'] || ''),
        name: String(user['name'] || ''),
        role: user['role'] === 'admin' ? 'admin' : 'user',
        status: String(user['status'] || ''),
        monthlyTokenLimit: Number(user['monthlyTokenLimit'] || 0),
      },
    };
    if (
      !result.user.id || !result.user.email || result.user.status !== 'active' ||
      result.audience !== audience || result.publicationSlug !== value.conexus.publicationSlug ||
      !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()
    ) throw httpError('Conexus 返回了无效的账号授权。', 401);
    return result;
  }
}
