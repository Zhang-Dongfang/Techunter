import { describe, expect, it, vi } from 'vitest';
import { isTransientRequestError, retryTransientRequest } from './request-retry.js';

describe('retryTransientRequest', () => {
  it('retries browser network failures and returns the later successful response', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ branches: ['main', 'demo'] });

    await expect(retryTransientRequest(operation, { delayMs: 0 })).resolves.toEqual({ branches: ['main', 'demo'] });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('retries rate limits and temporary server failures', () => {
    expect(isTransientRequestError({ status: 429 })).toBe(true);
    expect(isTransientRequestError({ status: 503 })).toBe(true);
  });

  it('does not retry permanent API errors', async () => {
    const error = Object.assign(new Error('GitHub account required'), { status: 401 });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryTransientRequest(operation, { delayMs: 0 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
