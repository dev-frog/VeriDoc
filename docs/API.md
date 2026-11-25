# VeriDoc API reference

Version `0.1.0` · [← Back to README](../README.md) · [Testing guide →](TESTING.md)

- **Base URL (local):** `http://localhost:3000`
- **Base URL (Vercel):** `https://<your-project>.vercel.app`
- **Format:** JSON in, JSON out. Send `Content-Type: application/json` on requests with a body.

## Contents

- [Authentication](#authentication)
- [Request IDs](#request-ids)
- [Errors](#errors)
- [The Document object](#the-document-object)
- Endpoints
  - [`GET /health`](#get-health)
  - [`POST /documents`](#post-documents)
  - [`POST /documents/:id/process`](#post-documentsidprocess)
  - [`GET /documents`](#get-documents)
  - [`GET /documents/:id`](#get-documentsid)
  - [`DELETE /documents/:id`](#delete-documentsid)
- [End-to-end example](#end-to-end-example)

---

## Authentication

Every `/documents` route needs the API key you set in `VERIDOC_API_KEY`:

```http
Authorization: Bearer <VERIDOC_API_KEY>
```

The `Bearer` keyword is case-insensitive. Keys are compared in constant time.

| Situation | Result |
|---|---|
| Key missing or wrong | `401 unauthorized`, with a `WWW-Authenticate: Bearer` header |
| `VERIDOC_API_KEY` not set, local dev | Requests are allowed through (handy for quick testing) |
| `VERIDOC_API_KEY` not set, `NODE_ENV=production` | `500 server_misconfigured` — production refuses to run without a key |

`GET /health` never needs a key.

## Request IDs

Every response has an `X-Request-Id` header. VeriDoc picks the ID like this:

1. If you send `X-Request-Id` and it's valid (up to 255 characters of `A–Z a–z 0–9 _ - =`), it's reused.
2. Otherwise, on Vercel, the `x-vercel-id` header is used.
3. Otherwise, a random UUID.

Server logs include the same ID, so when something fails, quote the ID and you can find the exact log line.

```bash
curl -i localhost:3000/health -H "X-Request-Id: my-test-123"
# X-Request-Id: my-test-123
```

## Errors

Every error uses the same shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "Document 6750c3f1a2b4c5d6e7f80912 not found"
  }
}
```

Errors that may succeed if you try again also carry `"retryable": true`. Unhandled `500`s include the `requestId` in the body.

| Code | HTTP | When | What to do |
|---|---|---|---|
| `invalid_request` | 400 | Body or query failed validation (e.g. non-https `url`, `limit=500`) | Fix the request; the message names each bad field |
| `http_error` | 400 | The body isn't valid JSON | Send valid JSON |
| `invalid_input` | 400 | `url` host isn't allowed by `SOURCE_URL_HOSTS` | Use an allowed host, or widen `SOURCE_URL_HOSTS` |
| `unauthorized` | 401 | Missing or wrong API key | Send `Authorization: Bearer <key>` |
| `not_found` | 404 | Unknown document ID (including malformed IDs) or unknown route | Check the ID / path |
| `unsupported_type` | 415 | `fileName` extension isn't `.pdf`, `.md`, `.markdown`, `.txt` or `.docx` | Use a supported file |
| `parse_failed` | 422 | The file couldn't be parsed | Usually the document is marked `failed` instead — see `/process` |
| `fetch_failed` | 502 | The file download failed with a network error, timeout, 408, 429 or 5xx (`retryable`) | Call `/process` again later |
| `provider_error` | 502 | The embedding API failed (`retryable` when it's a rate limit or 5xx) | Call `/process` again later |
| `config_error` | 500 | A provider key the request needs isn't configured (e.g. `EMBED_API_KEY`) | Set the variable and redeploy |
| `server_misconfigured` | 500 | `VERIDOC_API_KEY` missing in production | Set it and redeploy |
| `internal_error` | 500 | Unexpected bug | Report it with the `requestId` |

## The Document object

```json
{
  "id": "6750c3f1a2b4c5d6e7f80912",
  "fileName": "handbook.pdf",
  "mimeType": "application/pdf",
  "sourceUrl": "https://abc.public.blob.vercel-storage.com/handbook.pdf",
  "pageCount": 42,
  "status": "ready",
  "error": null,
  "chunkCount": 118,
  "processedCount": 118,
  "createdAt": "2026-11-25T12:30:00.000Z",
  "updatedAt": "2026-11-25T12:30:41.512Z"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | 24-character hex ID |
| `fileName` | string | Name you gave at creation. The extension decides the parser |
| `mimeType` | string | `application/pdf`, `text/markdown`, `text/plain` or `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `sourceUrl` | string | Where the file is downloaded from |
| `pageCount` | number \| null | Highest page number for PDFs; `null` for other formats or before parsing |
| `status` | string | `pending` → `processing` → `ready` or `failed` |
| `error` | string \| null | Why the document failed |
| `chunkCount` | number | Total chunks. `0` until the first `/process` call has parsed the file |
| `processedCount` | number | Chunks that have an embedding |
| `createdAt`, `updatedAt` | string | ISO 8601 timestamps |

### Status lifecycle

| Status | Meaning |
|---|---|
| `pending` | Registered. Nothing downloaded yet |
| `processing` | Being parsed and/or embedded. Keep calling `/process` |
| `ready` | Every chunk has an embedding. Final |
| `failed` | Permanent problem (unparseable, no text, 4xx download, redirect, too large). Final — delete and recreate to retry |

---

## `GET /health`

Checks that the server is running and MongoDB answers. **No auth.**

```bash
curl -i http://localhost:3000/health
```

**200 OK**

```json
{ "status": "ok", "version": "0.1.0", "db": "ok" }
```

**503 Service Unavailable** — MongoDB didn't answer:

```json
{ "status": "degraded", "version": "0.1.0", "db": "error" }
```

Use this for uptime checks and load-balancer probes.

---

## `POST /documents`

Registers a document by URL. **Nothing is downloaded yet** — that happens on the first `/process` call, so this request is fast.

Files have to be uploaded somewhere first (Vercel's request body limit is 4.5 MB). Vercel Blob is the default; you can allow other hosts with `SOURCE_URL_HOSTS`.

**Body**

| Field | Type | Rules |
|---|---|---|
| `url` | string | Must be `https://`, on a host allowed by `SOURCE_URL_HOSTS`. Redirects are refused at download time |
| `fileName` | string | 1–255 characters, trimmed. Must end in `.pdf`, `.md`, `.markdown`, `.txt` or `.docx` |

```bash
curl -s -X POST http://localhost:3000/documents \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://raw.githubusercontent.com/honojs/hono/main/README.md",
    "fileName": "hono-readme.md"
  }'
```

**202 Accepted** (with a `Location: /documents/<id>` header)

```json
{ "id": "6750c3f1a2b4c5d6e7f80912", "status": "pending" }
```

**Errors**

| Case | Response |
|---|---|
| `url` is `http://…` | `400 invalid_request` — `url: must be an https URL` |
| `fileName` missing | `400 invalid_request` — `fileName: …` |
| `fileName: "photo.png"` | `415 unsupported_type` |
| Host not allowed | `400 invalid_input` |
| No / wrong key | `401 unauthorized` |

---

## `POST /documents/:id/process`

Does **the next bounded slice of work** and reports progress. Call it repeatedly until `status` is `ready` or `failed`.

- **First call:** downloads the file, parses it into sections (with page and heading), splits them into chunks and stores them, then embeds the first batch.
- **Every later call:** embeds the next `INGEST_BATCH_SIZE` chunks (default 256) that don't have an embedding yet.
- **Once `ready` or `failed`:** returns the current state and does nothing.

Each call is small enough to fit inside a serverless time limit, and it's safe to repeat. Two calls at the same time may embed the same batch twice — that only wastes some API usage.

No body.

```bash
curl -s -X POST http://localhost:3000/documents/$ID/process \
  -H "Authorization: Bearer $KEY"
```

**200 OK** — still going:

```json
{ "status": "processing", "processed": 256, "total": 900 }
```

**200 OK** — done:

```json
{ "status": "ready", "processed": 900, "total": 900 }
```

**200 OK** — failed permanently (note: still 200, check `status`):

```json
{
  "status": "failed",
  "processed": 0,
  "total": 0,
  "error": "No extractable text found (scanned PDFs need OCR, which is not supported)"
}
```

**Errors**

| Case | Response | Document status after |
|---|---|---|
| Unknown ID | `404 not_found` | — |
| Download got a 5xx / 429 / timeout | `502 fetch_failed`, `retryable: true` | stays `processing` |
| Embedding API failed | `502 provider_error` | stays `processing` |
| Embedding key not set | `500 config_error` | stays `processing` |

**Polling loop (bash):**

```bash
until curl -s -X POST localhost:3000/documents/$ID/process -H "Authorization: Bearer $KEY" \
  | tee /dev/stderr | grep -qE '"status":"(ready|failed)"'; do sleep 1; done
```

**Polling loop (JavaScript):**

```js
async function ingest(base, key, id) {
  for (;;) {
    const res = await fetch(`${base}/documents/${id}/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json();
    if (!res.ok) {
      if (body.error?.retryable || res.status === 502) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw new Error(`${body.error.code}: ${body.error.message}`);
    }
    console.log(`${body.status} ${body.processed}/${body.total}`);
    if (body.status === 'ready' || body.status === 'failed') return body;
  }
}
```

---

## `GET /documents`

Lists documents, newest first, with cursor pagination.

**Query parameters**

| Param | Type | Default | Rules |
|---|---|---|---|
| `limit` | integer | `20` | 1–100 |
| `cursor` | string | | The `nextCursor` from the previous page |
| `status` | string | | `pending`, `processing`, `ready` or `failed` |

```bash
curl -s "http://localhost:3000/documents?limit=2&status=ready" \
  -H "Authorization: Bearer $KEY"
```

**200 OK**

```json
{
  "items": [
    { "id": "6750c3f1a2b4c5d6e7f80912", "fileName": "hono-readme.md", "status": "ready", "...": "..." },
    { "id": "6750c1aa0b1c2d3e4f506172", "fileName": "handbook.pdf",   "status": "ready", "...": "..." }
  ],
  "nextCursor": "6750c1aa0b1c2d3e4f506172"
}
```

`nextCursor` is `null` on the last page. To get the next page:

```bash
curl -s "http://localhost:3000/documents?limit=2&status=ready&cursor=6750c1aa0b1c2d3e4f506172" \
  -H "Authorization: Bearer $KEY"
```

**Errors:** `400 invalid_request` for `limit=0`, `limit=101`, `limit=abc` or an unknown `status`.

---

## `GET /documents/:id`

Returns one [Document](#the-document-object).

```bash
curl -s http://localhost:3000/documents/$ID -H "Authorization: Bearer $KEY"
```

**200 OK** — the Document object.

**Errors:** `404 not_found` for an unknown or malformed ID.

---

## `DELETE /documents/:id`

Deletes the document **and all its chunks**. Chunks are removed first, so a half-finished delete never leaves orphaned chunks searchable. This can't be undone.

```bash
curl -s -X DELETE http://localhost:3000/documents/$ID -H "Authorization: Bearer $KEY"
```

**200 OK**

```json
{ "id": "6750c3f1a2b4c5d6e7f80912", "deleted": true }
```

**Errors:** `404 not_found` if the document doesn't exist (including a second delete of the same ID).

---

## End-to-end example

```bash
BASE=http://localhost:3000
KEY=your-veridoc-api-key

# Register
ID=$(curl -s -X POST $BASE/documents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://raw.githubusercontent.com/honojs/hono/main/README.md","fileName":"hono-readme.md"}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "Created $ID"

# Process until finished
until curl -s -X POST $BASE/documents/$ID/process -H "Authorization: Bearer $KEY" \
  | tee /dev/stderr | grep -qE '"status":"(ready|failed)"'; do sleep 1; done

# Inspect, list, delete
curl -s $BASE/documents/$ID -H "Authorization: Bearer $KEY"
curl -s "$BASE/documents?limit=5" -H "Authorization: Bearer $KEY"
curl -s -X DELETE $BASE/documents/$ID -H "Authorization: Bearer $KEY"
```

Want to run all of this (plus the error cases) automatically? Use [`scripts/smoke-test.sh`](../scripts/smoke-test.sh) — see the [testing guide](TESTING.md).
