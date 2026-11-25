/**
 * zod-validator hook that answers with VeriDoc's error format.
 * @type {Parameters<typeof import('@hono/zod-validator').zValidator>[2]}
 */
export const onInvalid = (result, c) => {
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return c.json({ error: { code: 'invalid_request', message } }, 400);
  }
};
