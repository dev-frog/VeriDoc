# VeriDoc

> Every answer, traced to its source.

VeriDoc is an open-source RAG engine backend. You upload documents (PDF, Markdown, DOCX, TXT). VeriDoc chunks them and stores the embeddings and text in MongoDB Atlas. It answers questions with hybrid search: BM25 full-text and vector search, fused with `$rankFusion`, then reranked. The LLM must cite every claim as `[Source N]`, and each citation is checked against the chunks that were actually retrieved.

**Status:** Step 1 is done (project setup, config, MongoDB client, `/health`). Ingestion, search and generation come in later steps.

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
| `PORT` | `3000` | Local dev only |

Empty values (for example `OPENAI_API_KEY=`) count as not set.

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

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status, version, db }`: 200 when MongoDB answers, 503 when it doesn't |

Errors always use the shape `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status.

## License

MIT
