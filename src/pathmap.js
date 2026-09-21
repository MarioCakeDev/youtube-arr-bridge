/**
 * Path mapping: translate a container-internal path into the path the SABnzbd
 * client (DroppedNeedle) sees on its own host.
 *
 * DroppedNeedle mounts the SAME host directory at `/sabnzbd-downloads`. It
 * remaps `storage` by stripping the `complete_dir` prefix we advertise and
 * appending the remainder under its mount. Reporting a path already in the
 * DroppedNeedle namespace keeps both sides consistent even when the container
 * mount differs (e.g. host `/mnt/media/downloads` -> container `/downloads`).
 */

import path from 'node:path';

function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * @param {string} internal absolute path inside this container
 * @param {Array<[string,string]>} pairs internal:external prefix pairs
 * @returns {string} the path as DroppedNeedle sees it
 */
export function toReported(internal, pairs) {
  const target = norm(internal);
  for (const [from, to] of pairs) {
    const base = norm(from);
    if (target === base) return to;
    if (base !== '/' && target.startsWith(base + '/')) {
      const rest = target.slice(base.length + 1);
      return `${to}/${rest}`;
    }
  }
  return target;
}

/** Join a reported root with a relative folder name (posix). */
export function reportedJoin(root, name) {
  const cleanRoot = norm(root);
  const cleanName = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  return cleanName ? `${cleanRoot === '/' ? '' : cleanRoot}/${cleanName}` : cleanRoot;
}

/** Force an absolute, separator-normalised path for filesystem use. */
export function asLocal(p) {
  return path.resolve(p);
}
