import { dataOrThrow } from './database.js';

/** Each query orders by the immutable primary key and filters id > after. */
export async function readRowsById<T>(page: (after: string | null) => PromiseLike<{
  data: T[] | null; error: { message: string; code?: string } | null; count?: number | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  for (;;) {
    const result = await page(after);
    const next = dataOrThrow(result);
    for (const row of next) {
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string' || (after !== null && id <= after)) throw new Error('数据库分页游标未前进。');
      after = id;
      rows.push(row);
    }
    // count describes this cursor's remaining set, not an offset from a prior snapshot.
    if (!next.length || (result.count != null && next.length >= result.count)) return rows;
  }
}
