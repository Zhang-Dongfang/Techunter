import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, httpRequest } from './http-request';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('network feedback', () => {
  it('rejects successful HTML rather than returning an empty data object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy</html>')));
    await expect(httpRequest('/fixture')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });
  it('preserves authorization errors for the login flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '登录过期', code: 'SESSION_EXPIRED' }), { status: 401 })));
    await expect(httpRequest('/fixture')).rejects.toMatchObject({ message: '登录过期', status: 401, code: 'SESSION_EXPIRED' });
  });
  it('bounds a hung load and tells users how to recover', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const result = expect(httpRequest('/fixture', {}, 100)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('加载超时') });
    await vi.advanceTimersByTimeAsync(100); await result;
  });
  it('does not suggest blindly repeating timed-out writes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const result = expect(httpRequest('/fixture', { method: 'POST' }, 100)).rejects.toMatchObject({ message: expect.stringContaining('刷新查看结果') });
    await vi.advanceTimersByTimeAsync(100); await result;
  });
  it('propagates user cancellation and releases the timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const pending = httpRequest('/fixture', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('explains connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(httpRequest('/fixture')).rejects.toBeInstanceOf(ApiError);
    await expect(httpRequest('/fixture')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});
