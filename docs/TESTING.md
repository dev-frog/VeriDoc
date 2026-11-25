# Testing VeriDoc

[← Back to README](../README.md) · [API reference](API.md)

There are five ways to test VeriDoc. They go from fast and offline to real and end to end:

| # | Method | Needs | Time |
|---|---|---|---|
| 1 | [Unit + API tests](#1-unit--api-tests) — `pnpm test` | Nothing (no DB, no keys, no network) | seconds |
| 2 | [Config & connectivity check](#2-config--connectivity-check) — `pnpm check` | `.env` with real credentials | ~10 s |
| 3 | [Smoke test script](#3-smoke-test-script) — `scripts/smoke-test.sh` | A running server | ~30 s |
| 4 | [Manual requests](#4-manual-requests-curl-rest-client-postman) — curl, REST Client, Postman | A running server | as long as you like |
| 5 | [Real file types](#5-testing-pdf-docx-and-other-real-files) — PDF, DOCX, folders | A running server or `pnpm ingest` | minutes |

---

## 1. Unit + API tests

```bash
pnpm test          # run once
pnpm test:watch    # re-run on save
```

The suite runs **fully offline**. The API tests build the real Hono app with an in-memory repository (`tests/helpers/memory-repo.js`), a fake embedder and a fake file fetcher, so every route, status code and error shape is checked without MongoDB or API keys.

| File | Covers |
|---|---|
| `tests/health.test.js` | `/health` 200 / 503, JSON 404 for unknown routes |
| `tests/documents-api.test.js` | Auth, every `/documents` route, validation errors, pagination, error mapping |
| `tests/ingest-service.test.js` | Lifecycle `pending → processing → ready/failed`, batching, idempotent `/process`, retryable vs permanent failures |
| `tests/parsers.test.js` | PDF (generated on the fly by `tests/helpers/make-pdf.js`), Markdown, DOCX, TXT → sections with page/heading |
| `tests/chunker.test.js` | Chunk size, sentence boundaries, overlap, section boundaries |
| `tests/fetch-file.test.js` | Host allowlist, https-only, redirects refused, size limit, timeouts |
| `tests/embed.test.js` | OpenAI / Azure / Voyage request shapes, retries, error codes |
| `tests/config.test.js` | Env validation and defaults |
| `tests/indexes.test.js` | Atlas index definitions |
| `tests/logger.test.js` | Pretty / JSON request logs, levels by status |
| `tests/diagnostics.test.js` | `pnpm check` config diagnostics |

Run a single file or test:

```bash
pnpm vitest run tests/chunker.test.js
pnpm vitest run -t "requires the API key"
```

**Writing a new API test** — reuse the pattern from `tests/documents-api.test.js`:

```js
import { createApp } from '../src/api/app.js';
import { createIngestService } from '../src/core/ingest/service.js';
import { createMemoryRepo } from './helpers/memory-repo.js';

const ingest = createIngestService({
  repo: createMemoryRepo(),
  embedder: { dimensions: 1, embed: async (texts) => texts.map(() => [1]) },
  fetchFile: async () => new TextEncoder().encode('# Title\nHello there.'),
});
const app = createApp({ pingDb: async () => true, ingest, auth: { apiKey: 'test-key' } });

const res = await app.request('/documents', { headers: { authorization: 'Bearer test-key' } });
expect(res.status).toBe(200);
```

---

## 2. Config & connectivity check

Before testing against real services, make sure every credential works:

```bash
pnpm check            # config + MongoDB + indexes + embeddings + reranker + LLM
pnpm check --offline  # config only, no network calls
```

Each live check sends one tiny request (a few tokens) and prints ✓ / ! / ✗ with a hint for fixing it. Secrets are never printed. If MongoDB passes but the search indexes are missing, run `pnpm db:setup`.

---

## 3. Smoke test script

`scripts/smoke-test.sh` exercises the whole API against a **running** server: health, auth, validation errors, then it ingests a real document to `ready`, reads it, lists it and deletes it. It needs only `bash` and `curl`.

```bash
# terminal 1
pnpm dev

# terminal 2
BASE=http://localhost:3000 KEY=<your VERIDOC_API_KEY> ./scripts/smoke-test.sh
```

Example output:

```
VeriDoc smoke test → http://localhost:3000

✓ GET /health is 200 and db ok
✓ unknown route → 404 not_found (JSON)
✓ no API key → 401
✓ wrong API key → 401
✓ http:// url → 400 invalid_request
✓ missing fileName → 400 invalid_request
✓ unsupported extension → 415
✓ malformed JSON → 400
✓ limit=500 → 400 invalid_request
✓ unknown document id → 404
✓ malformed document id → 404
✓ POST /documents → 202 pending
    process #1 → processing 64/200
    process #2 → ready 200/200
✓ document processed to ready
✓ calling /process again is a no-op
✓ GET /documents/:id
✓ GET /documents?limit=1 (list + nextCursor)
✓ DELETE /documents/:id
✓ deleted document → 404

All 18 checks passed.
```

| Variable | Default | Notes |
|---|---|---|
| `BASE` | `http://localhost:3000` | Point it at a Vercel URL to test a deployment |
| `KEY` | `$VERIDOC_API_KEY` | If empty, the auth checks are skipped |
| `DOC_URL` | Hono's README on GitHub | Any https file the server is allowed to download |
| `DOC_NAME` | `hono-readme.md` | Its extension picks the parser |
| `MAX_POLLS` | `120` | Max `/process` calls before giving up |

The default `DOC_URL` is on `raw.githubusercontent.com`, so the server must allow that host. For local testing, put `SOURCE_URL_HOSTS=*` in `.env` (or `SOURCE_URL_HOSTS=raw.githubusercontent.com,*.public.blob.vercel-storage.com`). The script exits non-zero when any check fails, so you can use it in CI or after a deploy.

> The ingestion step makes real embedding calls, so it uses a small amount of your provider quota.

---

## 4. Manual requests (curl, REST Client, Postman)

### curl

```bash
export BASE=http://localhost:3000
export KEY=<your VERIDOC_API_KEY>

curl -s $BASE/health

curl -s -X POST $BASE/documents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://raw.githubusercontent.com/honojs/hono/main/README.md","fileName":"hono-readme.md"}'

export ID=<id from the response>
curl -s -X POST $BASE/documents/$ID/process -H "Authorization: Bearer $KEY"   # repeat until "ready"
curl -s $BASE/documents/$ID -H "Authorization: Bearer $KEY"
curl -s "$BASE/documents?limit=5" -H "Authorization: Bearer $KEY"
curl -s -X DELETE $BASE/documents/$ID -H "Authorization: Bearer $KEY"
```

Add `-i` to see status codes and the `X-Request-Id` header. Pipe into `jq` for pretty output.

### VS Code REST Client / JetBrains HTTP Client

Open [`docs/veridoc.http`](veridoc.http), set `@key` at the top, and click **Send Request** above each block. Running **Create document** stores its `id`, so **Process**, **Get** and **Delete** work without copy-pasting. The bottom of the file has one request for each common error.

### Postman / Insomnia / Bruno

Import [`docs/veridoc.postman_collection.json`](veridoc.postman_collection.json). Set the collection variables `baseUrl` and `apiKey`. **Create document** saves `docId` automatically, and every request has a status-code test, so **Run collection** gives you a pass/fail report. Run **Process next batch** a few times until the console shows `ready`.

---

## 5. Testing PDF, DOCX and other real files

**Option A — local folder, no API or uploads needed:**

```bash
mkdir -p ./sample-docs
cp ~/Documents/some-manual.pdf ~/Documents/notes.docx ./sample-docs/
pnpm ingest ./sample-docs           # skips files already ingested
pnpm ingest ./sample-docs --force   # re-ingest everything
```

**Option B — through the API.** The server downloads files from a URL, so host the file first:

- **Vercel Blob** (the production setup): upload in the Vercel dashboard under **Storage → your Blob store**, then copy the public `https://….public.blob.vercel-storage.com/…` URL. That host is allowed by default.
- **GitHub raw URL**: commit a file to a public repo and use its `https://raw.githubusercontent.com/...` URL (allow that host in `SOURCE_URL_HOSTS`).

Then run the smoke test with it:

```bash
DOC_URL=https://abc.public.blob.vercel-storage.com/manual.pdf DOC_NAME=manual.pdf \
  KEY=$KEY ./scripts/smoke-test.sh
```

**What to check afterwards** with `GET /documents/:id`:

| File | Expect |
|---|---|
| Text-based PDF | `pageCount` set, `status: ready` |
| Scanned PDF (images only) | `status: failed`, `error` mentions OCR — expected, OCR isn't supported yet |
| Markdown with `#` headings | `status: ready`; chunks carry the heading path |
| DOCX | Headings detected only from Word's built-in **Heading 1–6** styles |
| `.png`, `.xlsx`, … | `415 unsupported_type` at creation |
| File bigger than `MAX_FILE_MB` | `status: failed` on the first `/process` |

To look at the chunks themselves, open the `chunks` collection in MongoDB Atlas (Data Explorer or Compass) and filter by `{ docId: ObjectId("<id>") }`.

---

## Testing a Vercel deployment

```bash
curl -i https://<your-project>.vercel.app/health          # 200, "db":"ok"
curl -i https://<your-project>.vercel.app/does-not-exist  # JSON 404, not an HTML page
BASE=https://<your-project>.vercel.app KEY=<prod key> ./scripts/smoke-test.sh
```

If something fails, take the `X-Request-Id` from the response and search for it in **Vercel → Project → Logs**. With `LOG_FORMAT=json` (the default in production) every request is one JSON line you can filter by `requestId`, `status` or `error`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` → 503, `"db":"error"` | MongoDB unreachable | Check `MONGODB_URI`; in Atlas **Network Access**, allow your IP (or `0.0.0.0/0` for Vercel) |
| `400 invalid_request` with "expected string, received undefined" on a body you did send | Missing `Content-Type: application/json` header | Add the header |
| `400 invalid_input` on `POST /documents` | URL host not in `SOURCE_URL_HOSTS` | Add the host, or use `*` locally |
| `/process` → `500 config_error` | Embedding key not set | Set `OPENAI_API_KEY` (or `VOYAGE_API_KEY`) and restart / redeploy |
| `/process` → `502 provider_error` | Embedding API rate limit or outage | Call `/process` again; lower `EMBED_BATCH_SIZE` if it keeps happening |
| `/process` → `failed`, "redirected" | The URL redirects (short links, Drive/Dropbox share links) | Use the final, direct file URL |
| Document stuck in `processing` | Nobody is calling `/process` | `/process` only does work when called — keep calling it until `ready` |
| `401` even with a key | Missing `Bearer ` prefix, or the server has a different `VERIDOC_API_KEY` | Send `Authorization: Bearer <key>`; redeploy after changing env vars on Vercel |
| `pnpm start` fails on missing env vars | `start` doesn't load `.env` | Use `pnpm dev`, or `node --env-file=.env src/server.js` |
