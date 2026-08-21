import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

export type TechunterDatabase = SupabaseClient<any, 'techunter', any>;

let cached: TechunterDatabase | undefined;

export function database(): TechunterDatabase {
  if (!cached) {
    const value = config();
    cached = createClient(value.supabaseUrl, value.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'techunter' },
    }) as unknown as TechunterDatabase;
  }
  return cached;
}

export function dataOrThrow<T>(result: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    const error = new Error(result.error.message) as Error & { code?: string };
    error.code = result.error.code;
    throw error;
  }
  if (result.data === null) throw new Error('数据库没有返回预期数据。');
  return result.data;
}
