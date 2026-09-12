import { randomUUID } from 'node:crypto';
import type { TechunterDatabase } from './database.js';
import { httpError, translateDatabaseError } from './errors.js';

/** A database lease survives process restarts; credentials stay in this request. */
export async function runTaskOperation(
  db: TechunterDatabase, id: string, actorId: string,
  work: (payload: Record<string, any>, token: string, checkpoint: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const token = randomUUID();
  const acquire = async () => {
    const result = await db.rpc('lease_task_operation', { p_id: id, p_actor_id: actorId, p_token: token });
    if (result.error) translateDatabaseError(new Error(result.error.message));
    return result.data as Record<string, any> | null;
  };
  const payload = await acquire();
  if (!payload) return;
  let failure: unknown;
  let heartbeat: Promise<void> | undefined;
  const renew = async () => {
    if (!await acquire()) throw httpError('操作已完成或由其他请求接续，请刷新任务。', 409, 'OPERATION_LEASE_LOST');
  };
  const timer = setInterval(() => {
    if (!heartbeat) heartbeat = renew().catch(error => { failure = error; }).finally(() => { heartbeat = undefined; });
  }, 20_000);
  timer.unref();
  const checkpoint = async () => {
    if (heartbeat) await heartbeat;
    if (failure) throw failure;
    await renew();
  };
  try { await work(payload, token, checkpoint); }
  finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    // Failure to release is harmless: another request can resume after 90s.
    await db.rpc('release_task_operation', { p_id: id, p_token: token }).then(() => undefined, () => undefined);
  }
}
