import { describe, expect, it } from 'vitest';
import { authorizeConexusInBrowser } from './browser-auth.js';

describe('Conexus system-browser authorization', () => {
  it('accepts a scoped authorization only through the random loopback callback', async () => {
    const expected = {
      runTicket: 'cnx_run_v1.payload.signature',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        role: 'user' as const,
        status: 'active',
        monthlyTokenLimit: 100_000,
      },
    };
    const result = await authorizeConexusInBrowser(
      { apiUrl: 'https://conexus.example.com', publicationSlug: 'techunter', displayName: 'Techunter' },
      'http://127.0.0.1:5173',
      async (rawUrl) => {
        const loginUrl = new URL(rawUrl);
        expect(loginUrl.origin).toBe('https://conexus.example.com');
        expect(loginUrl.searchParams.get('audience')).toBe('http://127.0.0.1:5173');
        const redirectUri = loginUrl.searchParams.get('redirectUri')!;
        const state = loginUrl.searchParams.get('state')!;
        expect((await fetch(redirectUri)).status).toBe(200);
        const completeUrl = new URL('/complete', redirectUri);
        const response = await fetch(completeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, authorization: JSON.stringify(expected) }),
        });
        expect(response.status).toBe(204);
      },
    );
    expect(result).toEqual(expected);
  });
});
