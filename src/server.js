/**
 * HTTP server and routing.
 *
 * One listener exposes both protocol halves:
 *   GET  /api?t=caps|search|music|audio|album     -> Newznab indexer
 *   GET  /api/newznab/get?...                     -> Newznab grab (NZB)
 *   GET/POST /api?mode=version|queue|history|...  -> SABnzbd client
 *   GET  /health                                  -> healthcheck
 *
 * `/api/sabnzbd/api` and `/api/newznab/api` are accepted as aliases so either
 * half can be pointed at a distinct base path if a client requires it.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createNewznab } from './newznab.js';
import { createSabnzbd } from './sabnzbd.js';

const MAX_BODY = 16 * 1024 * 1024;

export function secureEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Merge urlencoded POST fields into the query params. */
function mergeForm(params, contentType, body) {
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) return params;
  const form = new URLSearchParams(body.toString('utf8'));
  for (const [key, value] of form) if (!params.has(key)) params.set(key, value);
  return params;
}

export function baseUrlFor(req, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

export function createServer({ config, store, engine, log = () => {}, resolveAlbum = null }) {
  const search = config.searchConfirm && resolveAlbum
    ? (spec) =>
        resolveAlbum(spec, {
          fetchImpl: config.fetchImpl,
          timeoutMs: config.searchTimeoutMs,
          log,
        })
    : null;
  const newznab = createNewznab({ config, log, search });
  const sabnzbd = createSabnzbd({ config, store, engine, log });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const params = url.searchParams;
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (pathname === '/health') {
        return send(res, 200, 'application/json', JSON.stringify({ status: 'ok' }));
      }

      const isNewznabPath = pathname === '/api/newznab/api' || pathname === '/api/newznab/get';
      const isSabPath = pathname === '/api/sabnzbd/api' || pathname === '/api/sabnzbd';
      const rootApi = pathname === '/api';

      if (!isNewznabPath && !isSabPath && !rootApi) {
        return send(res, 404, 'application/json', JSON.stringify({ status: false, error: 'not found' }));
      }

      let body = Buffer.alloc(0);
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await readBody(req);
        mergeForm(params, req.headers['content-type'], body);
      }

      const baseUrl = baseUrlFor(req, config);
      const apikey = params.get('apikey') || '';

      const wantsNewznab =
        isNewznabPath || (rootApi && (params.has('t') || !params.has('mode')));
      const wantsSab = isSabPath || (rootApi && params.has('mode'));

      let result;
      if (pathname === '/api/newznab/get') {
        result = await newznab.handle(new URLSearchParams([...params, ['t', 'get']]), { baseUrl, apikey });
      } else if (wantsSab) {
        result = await sabnzbd.handle(params, { body });
      } else if (wantsNewznab) {
        // Auth is enforced inside the Newznab handler (caps is allowed without a key).
        result = await newznab.handle(params, { baseUrl, apikey });
      } else {
        result = await sabnzbd.handle(params, { body });
      }

      return send(res, result.status || 200, result.contentType, result.body);
    } catch (err) {
      log(`request error: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, 500, 'application/json', JSON.stringify({ status: false, error: 'internal error' }));
    }
  });

  return server;
}

function send(res, status, contentType, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': payload.length });
  res.end(payload);
}
