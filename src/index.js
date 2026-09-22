#!/usr/bin/env node
/**
 * youtube-arr-bridge entrypoint.
 */

import fs from 'node:fs';
import { loadConfig } from './config.js';
import { JobStore } from './jobs.js';
import { createEngine } from './engine.js';
import { createServer } from './server.js';
import { resolveAlbum } from './youtube.js';

function makeLogger(level) {
  const order = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = order[level] ?? 2;
  return (...args) => {
    if (threshold >= 2) console.log(`[${new Date().toISOString()}]`, ...args);
  };
}

const config = loadConfig();
const log = makeLogger(config.logLevel);

for (const dir of [config.downloadDir, config.incompleteDir, config.stateDir]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log(`could not create ${dir}: ${err.message}`);
  }
}

if (!config.apiKey) {
  log('WARNING: API_KEY is empty - the indexer and download client will reject all authenticated requests.');
}

const store = new JobStore({ stateDir: config.stateDir, historyLimit: config.historyLimit, log }).load();
const engine = createEngine({ config, store, log, resolveAlbum });
const server = createServer({ config, store, engine, log, resolveAlbum });

server.listen(config.port, config.host, () => {
  log(`youtube-arr-bridge listening on ${config.host}:${config.port}`);
  log(`downloads: ${config.downloadDir} -> reported as ${config.reportedCompleteDir}`);
  engine.resume();
});

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
