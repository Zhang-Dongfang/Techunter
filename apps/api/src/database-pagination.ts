import { dataOrThrow } from './database.js';

/** Keep the existing complete-list contract even with a lower server row cap. */
export async function readAllRows<T>(page: (from: number, to: number) => PromiseLike<{
  data: T[] | null; error: { message: string; code?: string } | null; count?: number | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const result = await page(rows.length, rows.length + 499);
    const next = dataOrThrow(result);
    rows.push(...next);
    // A short page may be the server's cap, not the end of the result set.
    if (!next.length || (result.count != null && rows.length >= result.count)) return rows;
  }
}
