import { handle } from 'hono/vercel';
import { getConfig } from '../src/config.js';
import { app } from '../src/api/index.js';

// Fail fast at cold start: a ConfigError here shows up in the Vercel function logs.
getConfig();

const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
