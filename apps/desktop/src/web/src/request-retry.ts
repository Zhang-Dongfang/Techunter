export interface RetryRequestOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function isTransientRequestError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = Number((error as { status?: unknown }).status);
  return status === 429 || (status >= 500 && status <= 599);
}

export async function retryTransientRequest<T>(
  operation: () => Promise<T>,
  options: RetryRequestOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const delayMs = Math.max(0, options.delayMs ?? 350);
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRequestError(error) || attempt === attempts - 1) throw error;
      await sleep(delayMs * (2 ** attempt));
    }
  }

  throw lastError;
}
