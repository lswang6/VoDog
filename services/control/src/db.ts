import pg from 'pg';
import type { PoolClient } from 'pg';

export type Db = pg.Pool;
export function createDb(connectionString: string): Db {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  });
}

// A checked-out client has no `error` listener (pg-pool removes its idle listener on
// acquire), so a connection Postgres terminates mid-checkout — `idle_in_transaction_session_timeout`
// is the one that bit us — emits an unhandled `error` and kills the process. Every
// checkout must attach a listener and must destroy a broken connection instead of
// recycling it.
const brokenClients = new WeakMap<PoolClient, Error>();
const asError = (value: unknown, message: string) => value instanceof Error ? value : new Error(message);

export function markClientBroken(client: PoolClient, error: unknown) {
  if (!brokenClients.has(client)) brokenClients.set(client, asError(error, 'database client failed'));
}
export function attachClientErrorListener(client: PoolClient): () => void {
  if (typeof (client as { on?: unknown }).on !== 'function') return () => undefined;
  const listener = (error: Error) => markClientBroken(client, error);
  client.on('error', listener);
  return () => {
    if (typeof (client as { removeListener?: unknown }).removeListener === 'function')
      client.removeListener('error', listener);
  };
}
export function takeClientError(client: PoolClient): Error | undefined {
  const error = brokenClients.get(client);
  brokenClients.delete(client);
  return error;
}
// Rolls back without masking the original failure. A failed ROLLBACK means the
// connection state is unknown, so the client is marked for destruction.
export async function safeRollback(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (error) {
    const rollbackError = asError(error, 'database rollback failed');
    markClientBroken(client, rollbackError);
    return rollbackError;
  }
}
export async function withClient<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  const detach = attachClientErrorListener(c);
  try {
    return await fn(c);
  } finally {
    detach();
    c.release(takeClientError(c));
  }
}
