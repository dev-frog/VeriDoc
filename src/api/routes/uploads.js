import { Hono } from 'hono';
import { handleUpload as vercelHandleUpload } from '@vercel/blob/client';
import { mimeTypeForFileName, SUPPORTED_EXTENSIONS, MIME } from '../../core/ingest/file-types.js';

/** Content types browsers report for supported files (unknown types are sent as octet-stream or ""). */
const ALLOWED_CONTENT_TYPES = [...Object.values(MIME), 'text/x-markdown', 'application/octet-stream'];

/**
 * POST /uploads — token route for Vercel Blob client uploads, so browsers can
 * upload files larger than the 4.5 MB function body limit straight to Blob:
 *
 *   import { upload } from '@vercel/blob/client';
 *   const blob = await upload(file.name, file, {
 *     access: 'public',
 *     handleUploadUrl: 'https://<veridoc>/uploads',
 *     headers: { authorization: `Bearer ${apiKey}` },
 *   });
 *   // then POST /documents { url: blob.url, fileName: file.name }
 *
 * The API key is checked by the app's auth middleware. No upload-completed
 * callback is registered, so Vercel never calls this route without a key.
 * @param {{ token?: string, maxBytes: number,
 *   handleUpload?: typeof vercelHandleUpload }} deps
 * @returns {Hono}
 */
export function uploadRoutes({ token, maxBytes, handleUpload = vercelHandleUpload }) {
  const r = new Hono();

  r.post('/', async (c) => {
    if (!token) {
      return c.json({ error: { code: 'config_error', message: 'BLOB_READ_WRITE_TOKEN is not set' } }, 500);
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'invalid_request', message: 'Body must be JSON from @vercel/blob/client upload()' } }, 400);
    }
    if (body?.type !== 'blob.generate-client-token') {
      return c.json({ error: { code: 'invalid_request', message: 'Only blob.generate-client-token requests are accepted' } }, 400);
    }
    try {
      const result = await handleUpload({
        body,
        request: c.req.raw,
        token,
        onBeforeGenerateToken: async (pathname) => {
          if (!mimeTypeForFileName(pathname)) {
            throw new Error(`Unsupported file type for "${pathname}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
          }
          return { allowedContentTypes: ALLOWED_CONTENT_TYPES, maximumSizeInBytes: maxBytes, addRandomSuffix: true };
        },
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: { code: 'invalid_request', message: err.message } }, 400);
    }
  });

  return r;
}
