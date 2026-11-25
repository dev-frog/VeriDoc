import { createApp } from './app.js';
import { getConfig } from '../config.js';
import { pingDb } from '../db/client.js';
import { createServices } from '../services.js';

const config = getConfig();
const { ingest, search, answer } = createServices(config);

/** The production app wired to real dependencies. */
export const app = createApp({
  pingDb,
  ingest,
  search,
  answer,
  uploads: { token: config.BLOB_READ_WRITE_TOKEN, maxBytes: config.MAX_FILE_MB * 1024 * 1024 },
  auth: { apiKey: config.VERIDOC_API_KEY, required: config.NODE_ENV === 'production' },
  log: config.LOG_FORMAT === 'off' ? false : { format: config.LOG_FORMAT },
});
