import { createApp } from './app.js';
import { pingDb } from '../db/client.js';

/** The production app wired to real dependencies. */
export const app = createApp({ pingDb });
