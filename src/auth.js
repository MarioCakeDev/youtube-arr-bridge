/**
 * Constant-time API key comparison.
 *
 * Lives in its own module so both protocol halves (Newznab and SABnzbd) can use
 * it without importing `server.js`, which imports them. `server.js` re-exports
 * `secureEqual` so the existing public surface is unchanged.
 */

import crypto from 'node:crypto';

/** timingSafeEqual with a length guard so unequal inputs never throw. */
export function secureEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
