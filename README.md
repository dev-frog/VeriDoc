# VeriDoc

> Every answer, traced to its source.

VeriDoc is an open-source RAG engine backend. You upload documents (PDF, Markdown, DOCX, TXT). VeriDoc chunks them and stores the embeddings and text in MongoDB Atlas. It answers questions with hybrid search: BM25 full-text and vector search, fused with `$rankFusion`, then reranked. The LLM must cite every claim as `[Source N]`, and each citation is checked against the chunks that were actually retrieved.

**Status:** Steps 1–3 are done (project setup, data model and indexes, ingestion). Search and generation come in later steps.

## Tech stack

- JavaScript (ESM), Node.js 20.10+, pnpm
- [Hono](https://hono.dev): `@hono/node-server` for local dev, Vercel for deployment
- MongoDB Atlas 8.1+ with the official `mongodb` driver (Vector Search, Atlas Search, `$rankFusion`)
- zod and `@hono/zod-validator` for validation
- vitest for tests
- External AI providers called with `fetch`: OpenAI or Voyage for embeddings, Cohere, Voyage or Jina for reranking, and any OpenAI-compatible LLM

## Project layout

```
veridoc/
├── src/
│   ├── core/          # the engine (no Hono or HTTP code here)
│   ├── api/           # Hono app and routes (app.js, index.js)
│   ├── db/            # cached MongoClient (client.js)
│   ├── config.js      # env validation with zod
│   └── server.js      # local dev entry
├── api/index.js       # Vercel entry (hono/vercel handle)
├── scripts/           # setup-indexes, ingest-cli, eval (later steps)
├── tests/
├── .env.example
└── vercel.json
```

## Run locally

Requirements: Node.js 20.10+ and pnpm.

```bash
pnpm install
cp .env.example .env        # set MONGODB_URI at minimum
pnpm test
pnpm dev                    # node --watch --env-file=.env src/server.js
```

Check that the server is up:

```bash
curl -i http://localhost:3000/health
# 200 {"status":"ok","version":"0.1.0","db":"ok"}
```

If MongoDB can't be reached, the response is `503 {"status":"degraded","version":"0.1.0","db":"error"}`.

| Script | What it does |
|---|---|
| `pnpm dev` | Starts the dev server and restarts it when files change. Loads `.env`, so that file must exist |
| `pnpm start` | Starts the server once. Does **not** load `.env`; the variables must already be set in the environment |
| `pnpm test` | Runs the test suite once |
| `pnpm test:watch` | Runs vitest in watch mode |
| `pnpm db:setup` | Creates collections and indexes (skips any that already exist), then waits until the search indexes are ready. Add `--update` to replace existing search index definitions |
| `pnpm ingest <folder>` | Ingests every `.pdf`, `.md`, `.txt` and `.docx` file in a local folder (including subfolders), straight into MongoDB. Skips files already ingested; `--force` re-ingests them |

If the config is invalid, the server stops at startup and lists every problem, for example:

```
Invalid environment configuration:
  - MONGODB_URI: is required
```

## Environment variables

Only `MONGODB_URI` is required right now. Each provider checks for its own API key when it's first used, so `/health` works before you add any AI keys.

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | (required) | `mongodb://` or `mongodb+srv://` |
| `MONGODB_DB` | `veridoc` | |
| `EMBED_PROVIDER` | `openai` | `openai` or `voyage` |
| `EMBED_MODEL` | `text-embedding-3-small` | |
| `EMBED_DIMENSIONS` | `1536` | |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL for OpenAI embeddings. Can point at Azure (see below) |
| `OPENAI_API_KEY` | | |
| `VOYAGE_API_KEY` | | |
| `RERANK_PROVIDER` | `cohere` | `cohere`, `voyage`, `jina` or `none` |
| `COHERE_API_KEY` | | |
| `JINA_API_KEY` | | |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API |
| `LLM_API_KEY` | | |
| `LLM_MODEL` | `gpt-4o-mini` | |
| `VERIDOC_API_KEY` | | Protects VeriDoc's own endpoints |
| `BLOB_READ_WRITE_TOKEN` | | Vercel Blob (filled in for you when you connect a Blob store) |
| `CHUNK_TOKENS` | `600` | Minimum 50 |
| `CHUNK_OVERLAP` | `0.12` | Fraction between 0 and 0.5 |
| `TOP_K` | `30` | Candidates retrieved before reranking |
| `TOP_N` | `5` | Chunks kept after reranking. Must be ≤ `TOP_K` |
| `SOURCE_URL_HOSTS` | `*.public.blob.vercel-storage.com` | Comma-separated hosts that `POST /documents` may download from: `*`, `*.example.com` or exact hosts. Only https is allowed |
| `MAX_FILE_MB` | `50` | Largest file that will be downloaded |
| `INGEST_BATCH_SIZE` | `256` | Chunks embedded per `POST /documents/:id/process` call |
| `EMBED_BATCH_SIZE` | `64` | Texts per embedding API request |
| `LOG_FORMAT` | `pretty` in dev, `json` in production | Request log format: `pretty`, `json` or `off` |
| `PORT` | `3000` | Local dev only |

Empty values (for example `OPENAI_API_KEY=`) count as not set.

### Using Azure OpenAI

Azure OpenAI has an OpenAI-compatible v1 API at `https://<resource>.openai.azure.com/openai/v1`. You don't need an `api-version` for it. Point both the embeddings and the LLM at it, and use your **deployment names** as the model names:

```bash
EMBED_PROVIDER=openai
OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1
OPENAI_API_KEY=<azure key>
EMBED_MODEL=text-embedding-3-small     # embedding deployment name
EMBED_DIMENSIONS=1536

LLM_BASE_URL=https://<resource>.openai.azure.com/openai/v1
LLM_API_KEY=<azure key>
LLM_MODEL=gpt-5-chat                   # chat deployment name
```

For `*.openai.azure.com` hosts, VeriDoc sends the key in the `api-key` header instead of `Authorization: Bearer`. Check that both deployments answer:

```bash
curl -s "$OPENAI_BASE_URL/embeddings" -H "api-key: $OPENAI_API_KEY" \
  -H "Content-Type: application/json" -d '{"model":"text-embedding-3-small","input":"hello"}' | head -c 300
curl -s "$LLM_BASE_URL/chat/completions" -H "api-key: $LLM_API_KEY" \
  -H "Content-Type: application/json" -d '{"model":"gpt-5-chat","messages":[{"role":"user","content":"Say hi"}]}'
```

Docs: https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle

## Deploy to Vercel

### 1. Prepare MongoDB Atlas

- Under **Network Access**, allow `0.0.0.0/0`. Vercel functions don't have fixed IP addresses unless you pay for the static IP add-on.
- Create a database user with a strong password.
- Copy the `mongodb+srv://…` connection string from **Connect → Drivers**.

### 2. Install the CLI and link the project

```bash
pnpm add -g vercel
vercel login
vercel link          # framework preset "Other", no build command
```

### 3. Set environment variables

Each command asks you for the value:

```bash
vercel env add MONGODB_URI production
vercel env add MONGODB_DB production          # veridoc
vercel env add VERIDOC_API_KEY production
# needed in later steps:
vercel env add OPENAI_API_KEY production
vercel env add COHERE_API_KEY production
vercel env add LLM_API_KEY production
```

Run the same commands with `preview` instead of `production`, and with `development` if you use `vercel dev`. You can also set the variables in the dashboard under **Project → Settings → Environment Variables**.

To get `BLOB_READ_WRITE_TOKEN`, create a Blob store under **Storage → Create → Blob** and connect it to the project. Vercel adds the token for you.

### 4. Deploy

```bash
vercel            # preview deployment
vercel --prod     # production
curl -i https://<your-project>.vercel.app/health
```

Env vars only apply to deployments made after you set them. If you change one, redeploy.

### 5. Check the deployment

- `/health` returns 200 with `"db":"ok"`.
- `/anything` returns `{"error":{"code":"not_found",...}}`. A 404 that isn't JSON means the routing to `/api` isn't working.
- In **Settings → Functions**, Fluid compute is on. Without it, Hobby functions may be limited to 60s instead of the 300s set in `vercel.json`.

### Vercel notes

- `vercel.json` sends every path to `api/index.js` and sets `maxDuration: 300`.
- `api/index.js` exports one handler per HTTP method (`GET`, `POST`, …). If the deploy fails or routes don't match, compare with:
  - https://hono.dev/docs/getting-started/vercel
  - https://vercel.com/docs/functions/runtimes/node-js
  - https://vercel.com/docs/functions/configuring-functions/duration
- The MongoClient is cached on `globalThis`, so warm requests reuse one connection pool. Vercel's `attachDatabasePool` (from `@vercel/functions`) may be added later.

## Limits (Vercel serverless)

- Each function call can run for at most about 300s, so long work is split into batches.
- Request bodies are limited to 4.5 MB, so files are uploaded to Vercel Blob first and the API receives the URL.
- No ML models run locally; embeddings, reranking and the LLM are all external APIs.
- No in-memory state is kept between requests.

## Data model

Typedefs are in `src/core/types.js`.

**`documents`**: `{ _id, fileName, mimeType, sourceUrl, pageCount, status, error, chunkCount, processedCount, parsedAt, createdAt, updatedAt }`, where `status` is `pending`, `processing`, `ready` or `failed`.

**`chunks`**: `{ _id, docId, chunkIndex, text, embedding, page, heading, tokenCount, createdAt }`. `embedding` is missing until the chunk has been embedded.

| Collection | Index | Type |
|---|---|---|
| `chunks` | `docId_chunkIndex` (`{ docId: 1, chunkIndex: 1 }`, unique) | Regular |
| `chunks` | `chunks_vector`: `embedding` (cosine, `EMBED_DIMENSIONS`), filter field `docId` | Atlas Vector Search |
| `chunks` | `chunks_text`: `text`, `heading` (lucene.standard), plus `docId` for filtering | Atlas Search (BM25) |
| `documents` | `createdAt_desc` | Regular |

Run this once per database, and again whenever `EMBED_DIMENSIONS` changes:

```bash
pnpm db:setup
```

Search indexes need an Atlas cluster; the free M0 tier allows up to 3 of them. If you change `EMBED_DIMENSIONS`, run `pnpm db:setup --update` and re-embed every document, because existing vectors won't match the new size.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status, version, db }`: 200 when MongoDB answers, 503 when it doesn't. No auth |
| `POST` | `/documents` | Body `{ url, fileName }`. Registers a document and returns `202 { id, status: "pending" }` |
| `POST` | `/documents/:id/process` | Does the next batch of work and returns `{ status, processed, total }`. Call it until `status` is `ready` or `failed` |
| `GET` | `/documents` | Lists documents, newest first. Query: `limit` (1–100, default 20), `cursor`, `status`. Returns `{ items, nextCursor }` |
| `GET` | `/documents/:id` | A single document |
| `DELETE` | `/documents/:id` | Deletes the document and its chunks. Returns `{ id, deleted: true }` |

Every `/documents` route needs `Authorization: Bearer $VERIDOC_API_KEY`. If `VERIDOC_API_KEY` isn't set, local dev lets requests through, and production (`NODE_ENV=production`) answers 500.

Errors always use the shape `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status. Errors that are worth retrying also include `"retryable": true`.

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | The body or query failed validation |
| `invalid_input` | 400 | The URL host isn't in `SOURCE_URL_HOSTS` |
| `unauthorized` | 401 | Missing or wrong API key |
| `not_found` | 404 | Unknown document or route |
| `unsupported_type` | 415 | The file extension isn't `.pdf`, `.md`, `.markdown`, `.txt` or `.docx` |
| `provider_error` / `fetch_failed` | 502 | The embedding API or file download failed. Call `/process` again |
| `config_error` | 500 | A required provider key is missing |

### Request logs

Every request writes one log line. Responses with status ≥ 500 go to stderr, everything else to stdout.

```
16:01:37 GET /health 200 921ms  req=8a08e008-…
16:01:37 GET /documents 401 0ms  req=a2a01b6f-…
16:02:10 POST /documents/66f…/process 502 3120ms provider_error  req=1796be18-…
```

With `LOG_FORMAT=json` (the default on Vercel), each line is a JSON object you can filter in **Vercel → Project → Logs**:

```json
{"level":"error","time":"2026-11-11T16:02:10.512Z","requestId":"fra1::abc","method":"POST","path":"/documents/66f…/process","status":502,"durationMs":3120,"error":"provider_error"}
```

**How the request ID is chosen:**
- **Your own ID:** if the request sends a valid `X-Request-Id` header, that value is used.
- **On Vercel:** otherwise the `x-vercel-id` header is used.
- **Otherwise:** a new random UUID.

The ID is returned in the `X-Request-Id` response header. For 5xx errors, the error details are logged with `[req=<id>]`, so you can find the full error from the ID a client reports.

Headers and request bodies are never logged, so API keys and document contents stay out of the logs.

### How ingestion works

1. `POST /documents` only stores the URL. Nothing is downloaded yet.
2. The first `POST /documents/:id/process` downloads the file and parses it into sections with page and heading. It then splits them into chunks and stores the chunks **without** embeddings.
3. Each call (including the first) embeds the next `INGEST_BATCH_SIZE` chunks that don't have an embedding yet. When every chunk has one, the status becomes `ready`.

Because each call does a bounded amount of work, it fits within Vercel's time limit. Calling it repeatedly is safe:
- Chunks are unique per `(docId, chunkIndex)`.
- Each call only picks up chunks that don't have an embedding yet.
- Once a document is `ready` or `failed`, further calls do nothing.

Two calls at the same moment can embed the same batch twice. That wastes some API usage but gives the same result.

**Which problems fail the document:**
- **The document is marked `failed`** if the file can't be parsed, has no extractable text (scanned PDFs need OCR, which isn't supported), or the download returns a 4xx error. To try again, delete it and create it again.
- **The document stays `processing`** if the download returns a 5xx error or the embedding API fails. The call returns 502; call `/process` again later.

**What the chunks look like:**
- **Chunk size:** about `CHUNK_TOKENS` tokens, counted with js-tiktoken `cl100k_base`.
- **Boundaries:** chunks contain whole sentences. A sentence is only split if it alone is longer than `CHUNK_TOKENS`.
- **Overlap:** each chunk repeats whole trailing sentences from the previous one, up to `CHUNK_OVERLAP`.
- **Sections:** a chunk never spans two sections, so each chunk has exactly one page and one heading path (for example `Guide > Install > Linux`).
- **Embedding input:** the heading path is added in front of the text that gets embedded. The stored chunk text stays unchanged.

**What each parser keeps:**

| Format | `page` | `heading` |
|---|---|---|
| PDF | Page number | Always null |
| Markdown | Null | Heading path from `#` headings |
| DOCX | Null | Heading path from Word's built-in **Heading 1–6** styles. Bold text formatted to look like a heading isn't recognized |
| TXT | Null | Null |

### Try it

```bash
pnpm dev
export KEY=<your VERIDOC_API_KEY>

# 1. register (url must be https on an allowed host; set SOURCE_URL_HOSTS=* in .env for local testing)
curl -s -X POST localhost:3000/documents -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://raw.githubusercontent.com/honojs/hono/main/README.md","fileName":"hono-readme.md"}'
# -> {"id":"<id>","status":"pending"}

# 2. process until ready
ID=<id>
until curl -s -X POST localhost:3000/documents/$ID/process -H "Authorization: Bearer $KEY" | tee /dev/stderr | grep -qE '"status":"(ready|failed)"'; do sleep 1; done

# 3. inspect, list, delete
curl -s localhost:3000/documents/$ID -H "Authorization: Bearer $KEY"
curl -s "localhost:3000/documents?limit=5" -H "Authorization: Bearer $KEY"
curl -s -X DELETE localhost:3000/documents/$ID -H "Authorization: Bearer $KEY"
```

To ingest a local folder without the API:

```bash
pnpm ingest ./my-docs
```

## License

MIT
