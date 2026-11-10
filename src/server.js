import { serve } from '@hono/node-server';
import { getConfig, ConfigError } from './config.js';
import { closeClient } from './db/client.js';

let config;
try {
  config = getConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { app } = await import('./api/index.js');

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`VeriDoc listening on http://localhost:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await closeClient().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
