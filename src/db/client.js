import { MongoClient } from 'mongodb';
import { getConfig } from '../config.js';

/**
 * The client promise is cached on globalThis so that warm serverless
 * invocations (and `node --watch` reloads of importing modules) reuse one
 * connection pool instead of opening a new one per request.
 * @type {{ __veridocMongo?: Promise<MongoClient> }}
 */
const g = globalThis;

/**
 * @returns {Promise<MongoClient>}
 */
export function getClient() {
  if (!g.__veridocMongo) {
    const { MONGODB_URI } = getConfig();
    const client = new MongoClient(MONGODB_URI, {
      appName: 'veridoc',
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    g.__veridocMongo = client.connect().catch((err) => {
      // Don't cache a failed connection; the next call retries.
      g.__veridocMongo = undefined;
      throw err;
    });
  }
  return g.__veridocMongo;
}

/**
 * @returns {Promise<import('mongodb').Db>}
 */
export async function getDb() {
  const client = await getClient();
  return client.db(getConfig().MONGODB_DB);
}

/**
 * Round-trip to the server. Resolves true/false, never throws.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function pingDb(timeoutMs = 3000) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
    });
    const ping = getDb().then((db) => db.command({ ping: 1 }));
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** For scripts and graceful shutdown in local dev. */
export async function closeClient() {
  const p = g.__veridocMongo;
  g.__veridocMongo = undefined;
  if (p) await (await p).close();
}
