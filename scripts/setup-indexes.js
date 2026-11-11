/**
 * Create collections and indexes idempotently, then wait until the Atlas
 * search indexes are queryable.
 *
 *   pnpm db:setup            # create what's missing
 *   pnpm db:setup --update   # also replace existing search index definitions
 */
import { getConfig, ConfigError } from '../src/config.js';
import { getDb, closeClient } from '../src/db/client.js';
import { COLLECTIONS } from '../src/db/collections.js';
import {
  REGULAR_INDEXES,
  VECTOR_INDEX_NAME,
  chunkSearchIndexSpecs,
  ensureSearchIndex,
  vectorIndexDrift,
  waitForSearchIndexes,
} from '../src/db/indexes.js';

const update = process.argv.includes('--update');

async function ensureCollection(db, name) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (exists) return console.log(`collection ${name}: exists`);
  await db.createCollection(name);
  console.log(`collection ${name}: created`);
}

async function main() {
  const config = getConfig();
  const db = await getDb();
  console.log(`Database: ${config.MONGODB_DB}`);

  for (const name of Object.values(COLLECTIONS)) await ensureCollection(db, name);

  for (const [collName, indexes] of Object.entries(REGULAR_INDEXES)) {
    // createIndexes is a no-op for indexes that already exist with the same spec.
    const names = await db.collection(collName).createIndexes(indexes);
    console.log(`indexes on ${collName}: ${names.join(', ')}`);
  }

  const chunks = db.collection(COLLECTIONS.chunks);
  const specs = chunkSearchIndexSpecs(config);

  for (const spec of specs) {
    const result = await ensureSearchIndex(chunks, spec, { update });
    console.log(`search index ${spec.name} (${spec.type}): ${result}`);
  }

  if (!update) {
    const [live] = await chunks.listSearchIndexes(VECTOR_INDEX_NAME).toArray();
    const drift = vectorIndexDrift(live?.latestDefinition, specs[0]);
    if (drift.length) {
      console.warn(`WARNING: ${VECTOR_INDEX_NAME} differs from config: ${drift.join('; ')}`);
      console.warn('Run `pnpm db:setup --update` to rebuild it (existing embeddings must match the new dimensions).');
    }
  }

  console.log('Waiting for search indexes to become queryable (this can take a few minutes)...');
  let last = '';
  await waitForSearchIndexes(
    chunks,
    specs.map((s) => s.name),
    {
      onPoll: (s) => {
        const line = Object.entries(s).map(([n, st]) => `${n}=${st}`).join('  ');
        if (line !== last) console.log(`  ${line}`);
        last = line;
      },
    },
  );
  console.log('All indexes ready.');
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `db:setup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeClient().catch(() => {});
}
