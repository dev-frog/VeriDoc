/**
 * Ingest a local folder end-to-end (development tool).
 *
 *   pnpm ingest ./docs            # skip files already ingested (status ready)
 *   pnpm ingest ./docs --force    # delete and re-ingest them
 *
 * Uses the same core service as the API; files are read from disk via
 * file:// URLs instead of being downloaded.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getConfig, ConfigError } from '../src/config.js';
import { closeClient } from '../src/db/client.js';
import { createServices } from '../src/services.js';
import { mimeTypeForFileName, CoreError } from '../src/core/index.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const folder = args.find((a) => !a.startsWith('--'));

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && mimeTypeForFileName(entry.name)) yield full;
  }
}

/** @param {string} url */
async function readLocalFile(url) {
  if (!url.startsWith('file://')) throw new CoreError('fetch_failed', `CLI only reads file:// URLs, got ${url}`);
  return new Uint8Array(await readFile(fileURLToPath(url)));
}

async function main() {
  if (!folder) {
    console.error('Usage: pnpm ingest <folder> [--force]');
    process.exitCode = 1;
    return;
  }
  const root = resolve(folder);
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory`);

  const config = getConfig();
  const { ingest, ingestRepo: repo } = createServices(config, { fetchFile: readLocalFile, allowAnySource: true });

  const totals = { ready: 0, failed: 0, skipped: 0 };
  for await (const path of walk(root)) {
    const name = relative(root, path);
    const url = pathToFileURL(path).href;

    let existing = await repo.findDocumentBySourceUrl(url);
    if (existing && force) {
      await ingest.deleteDocument(existing.id);
      existing = null;
    }
    if (existing?.status === 'ready') {
      console.log(`skip    ${name} (already ingested, use --force to redo)`);
      totals.skipped++;
      continue;
    }
    if (existing?.status === 'failed') await ingest.deleteDocument(existing.id);

    const id = existing && existing.status !== 'failed' ? existing.id : (await ingest.createDocument({ url, fileName: name })).id;

    const started = Date.now();
    let r;
    do {
      r = await ingest.processNext(id);
      process.stdout.write(`\r...     ${name}: ${r.processed}/${r.total}`);
    } while (r.status === 'pending' || r.status === 'processing');
    process.stdout.write('\r\x1b[K');

    if (r.status === 'ready') {
      console.log(`ready   ${name}: ${r.total} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      totals.ready++;
    } else {
      console.log(`failed  ${name}: ${r.error}`);
      totals.failed++;
    }
  }
  console.log(`\nDone: ${totals.ready} ready, ${totals.failed} failed, ${totals.skipped} skipped`);
  if (totals.failed) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `ingest failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeClient().catch(() => {});
}
