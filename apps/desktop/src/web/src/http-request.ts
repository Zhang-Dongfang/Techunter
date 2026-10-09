export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function httpRequest<T>(url: string, init: RequestInit = {}, timeoutMs =
  !init.method || init.method === 'GET' ? 20_000 : 195_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(url, {
      ...init, signal, credentials: 'include',
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const body: unknown = await response.json().catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new ApiError('服务返回了无法读取的响应，请稍后重试。', response.ok ? 502 : response.status, 'INVALID_RESPONSE');
    });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError('服务返回了无法读取的响应，请稍后重试。', 502, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const failure = body as { error?: unknown; code?: unknown };
      throw new ApiError(typeof failure.error === 'string' ? failure.error : `请求失败 (${response.status})`,
        response.status, typeof failure.code === 'string' ? failure.code : undefined);
    }
    return body as T;
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    if (controller.signal.aborted) {
      const reading = !init.method || init.method === 'GET';
      throw new ApiError(reading ? '加载超时，请检查网络后重试。' : '操作等待超时，请刷新查看结果后再决定是否重试。', 408, 'REQUEST_TIMEOUT');
    }
    if (error instanceof TypeError) {
      throw new ApiError('无法连接服务，请检查网络后重试。', 0, 'NETWORK_ERROR');
    }
    throw error;
  } finally { clearTimeout(timer); }
}
