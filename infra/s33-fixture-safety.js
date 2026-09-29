export const S33_DATABASE_NAME = "vodog_s33_ui_test";
export const S33_DATABASE_PREFIX = "vodog_s33_";
export const S33_WEB_ORIGIN = "http://127.0.0.1:4183";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * S33 is allowed to mutate exactly one disposable, loopback PostgreSQL database.
 * Keep this check independent from the server so scripts and tests can run it
 * before opening a connection.
 */
export function assertSafeS33DatabaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("S33_DATABASE_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    throw new Error("S33_DATABASE_URL must use postgres:// or postgresql://");
  // libpq-style query keys can override the apparent authority/database. The
  // fixture needs none of them, so reject the whole query/fragment surface.
  if (parsed.search || parsed.hash)
    throw new Error("S33_DATABASE_URL must not contain query parameters or a fragment");
  if (!LOOPBACK_HOSTS.has(parsed.hostname))
    throw new Error("S33_DATABASE_URL must use a loopback host");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.startsWith(S33_DATABASE_PREFIX) || databaseName !== S33_DATABASE_NAME)
    throw new Error(`S33_DATABASE_URL must name exactly ${S33_DATABASE_NAME}`);
  return parsed;
}

export function assertLoopbackListen(host, port) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("S33 fixture must listen on loopback");
  if (port !== 16880) throw new Error("S33 fixture must listen on port 16880");
}

export function assertSafeS33WebOrigin(raw) {
  if (raw !== S33_WEB_ORIGIN)
    throw new Error(`S33_WEB_ORIGIN must be exactly ${S33_WEB_ORIGIN}`);
  return new URL(raw);
}
