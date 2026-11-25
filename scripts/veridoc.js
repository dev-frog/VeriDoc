#!/usr/bin/env node
/**
 * veridoc — command-line client for a running VeriDoc API.
 *
 *   veridoc upload <file...>          upload to Vercel Blob, register and process
 *   veridoc add <url> [--name f.pdf]  register a file that's already online, and process it
 *   veridoc ask "<question>"          answer with verified [Source N] citations
 *   veridoc search "<query>"          hybrid search results
 *   veridoc docs [--status ready]     list documents
 *   veridoc rm <id>                   delete a document and its chunks
 *
 * Options: --doc <id> (repeatable) limits ask/search to documents; --json prints raw JSON.
 * Env: VERIDOC_URL (default http://localhost:3000), VERIDOC_API_KEY, BLOB_READ_WRITE_TOKEN (upload).
 * A .env file in the current directory is loaded if present.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { formatAnswer, formatSearch, formatDocuments, palette } from '../src/cli/format.js';

try {
  process.loadEnvFile?.('.env');
} catch {}

const HELP = `veridoc — client for a VeriDoc server

Usage:
  veridoc upload <file...>          upload to Vercel Blob, register and process
  veridoc add <url> [--name f.pdf]  register a file that's already online, and process it
  veridoc ask "<question>"          answer with verified [Source N] citations
  veridoc search "<query>"          hybrid search
  veridoc docs [--status ready]     list documents
  veridoc rm <id>                   delete a document

Options:
  --doc <id>     limit ask/search to a document (repeatable)
  --top <n>      number of sources/results (default: server TOP_N)
  --json         print the raw JSON response
  -h, --help

Env: VERIDOC_URL (default http://localhost:3000), VERIDOC_API_KEY, BLOB_READ_WRITE_TOKEN`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    doc: { type: 'string', multiple: true },
    top: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const [command, ...args] = positionals;
const base = (process.env.VERIDOC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const color = Boolean(process.stdout.isTTY) && !opts.json;
const p = palette(color);

class ApiError extends Error {}

/** @param {string} method @param {string} path @param {unknown} [body] */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(process.env.VERIDOC_API_KEY && { authorization: `Bearer ${process.env.VERIDOC_API_KEY}` }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(`Can't reach ${base} (${err.cause?.code ?? err.message}). Is the server running? Set VERIDOC_URL if it's elsewhere.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new ApiError(`${res.status} ${json.error?.code ?? ''}: ${json.error?.message ?? res.statusText}`);
    e.retryable = Boolean(json.error?.retryable) || res.status === 502;
    throw e;
  }
  return json;
}

const out = (json, pretty) => console.log(opts.json ? JSON.stringify(json, null, 2) : pretty(json));
const scope = () => ({
  ...(opts.doc?.length && { documentIds: opts.doc }),
  ...(opts.top && { topN: Number(opts.top) }),
});

/** Call /process until ready or failed, retrying transient 502s. */
async function processUntilDone(id, label) {
  let r;
  let retries = 0;
  for (;;) {
    try {
      r = await api('POST', `/documents/${id}/process`);
      retries = 0;
    } catch (err) {
      if (!err.retryable || ++retries > 5) throw err;
      process.stderr.write(`\n${p.yellow(`  ${err.message} — retrying in ${retries * 5}s`)}\n`);
      await new Promise((res) => setTimeout(res, retries * 5000));
      continue;
    }
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label}: ${r.status} ${r.processed}/${r.total}\x1b[K`);
    if (r.status === 'ready' || r.status === 'failed') break;
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  return r;
}

async function register(url, fileName) {
  const { id } = await api('POST', '/documents', { url, fileName });
  const r = await processUntilDone(id, fileName);
  if (r.status === 'ready') console.log(`${p.green('ready ')} ${fileName}  ${p.dim(`${r.total} chunks · id ${id}`)}`);
  else {
    console.log(`${p.red('failed')} ${fileName}  ${p.dim(r.error ?? '')}`);
    process.exitCode = 1;
  }
}

async function upload(files) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new ApiError(
      'BLOB_READ_WRITE_TOKEN is not set. Create a public Blob store (Vercel → Storage → Blob), connect it, then `vercel env pull`. ' +
        'Or use `veridoc add <url>` for a file that is already online, or `pnpm ingest <folder>` for local files.',
    );
  }
  const { put } = await import('@vercel/blob');
  for (const file of files) {
    const { size } = await stat(file);
    const name = basename(file);
    process.stdout.write(`  uploading ${name} (${(size / 1024 / 1024).toFixed(1)} MB)…`);
    const blob = await put(name, await readFile(file), {
      access: 'public',
      addRandomSuffix: true,
      token,
      multipart: size > 50 * 1024 * 1024,
    });
    process.stdout.write('\r\x1b[K');
    await register(blob.url, name);
  }
}

async function main() {
  if (opts.help || !command) return console.log(HELP);
  switch (command) {
    case 'ask':
      if (!args.length) throw new ApiError('Usage: veridoc ask "<question>"');
      return out(await api('POST', '/ask', { question: args.join(' '), ...scope() }), (r) => formatAnswer(r, { color }));
    case 'search':
      if (!args.length) throw new ApiError('Usage: veridoc search "<query>"');
      return out(await api('POST', '/search', { query: args.join(' '), ...scope() }), (r) => formatSearch(r, { color }));
    case 'upload':
      if (!args.length) throw new ApiError('Usage: veridoc upload <file...>');
      return upload(args);
    case 'add':
      if (!args[0]) throw new ApiError('Usage: veridoc add <url> [--name file.pdf]');
      return register(args[0], opts.name ?? decodeURIComponent(new URL(args[0]).pathname.split('/').pop() ?? 'file'));
    case 'docs': {
      const q = new URLSearchParams({ limit: '100', ...(opts.status && { status: opts.status }) });
      return out(await api('GET', `/documents?${q}`), (r) => formatDocuments(r.items, { color }));
    }
    case 'rm':
      if (!args[0]) throw new ApiError('Usage: veridoc rm <id>');
      await api('DELETE', `/documents/${args[0]}`);
      return console.log(`deleted ${args[0]}`);
    default:
      throw new ApiError(`Unknown command "${command}". Run veridoc --help`);
  }
}

try {
  await main();
} catch (err) {
  console.error(p.red(err instanceof ApiError ? err.message : `veridoc: ${err.stack ?? err}`));
  process.exitCode = 1;
}
