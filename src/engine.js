/**
 * Download orchestrator.
 *
 * Owns a bounded-concurrency queue in front of the YouTube resolver and the
 * yt-dlp downloader, and writes the mapped `storage` path onto each job when it
 * finishes. `resolveAlbum` / `downloadAlbum` are injectable for tests.
 */

import { STATUS } from './jobs.js';
import { toReported } from './pathmap.js';
import { resolveAlbum as defaultResolve } from './youtube.js';
import { downloadAlbum as defaultDownload } from './downloader.js';

export function createEngine({
  config,
  store,
  log = () => {},
  resolveAlbum = defaultResolve,
  downloadAlbum = defaultDownload,
} = {}) {
  const pending = [];
  let running = 0;

  function enqueue(job) {
    pending.push(job.nzo_id);
    pump();
  }

  function pump() {
    while (running < config.concurrency && pending.length > 0) {
      const id = pending.shift();
      const job = store.get(id);
      if (!job) continue;
      if (job.status !== STATUS.QUEUED) continue;
      running += 1;
      runJob(job)
        .catch(() => {})
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  async function runJob(job) {
    store.update(job.nzo_id, { status: STATUS.DOWNLOADING, started_ts: Math.floor(Date.now() / 1000) });
    const spec = job.spec || {};
    log(`job ${job.nzo_id} start: ${spec.artist || '?'} - ${spec.album || '?'}`);
    try {
      const resolution =
        job.resolution ||
        (await resolveAlbum(spec, {
          fetchImpl: config.fetchImpl,
          timeoutMs: config.searchTimeoutMs,
          log,
        }));
      store.update(job.nzo_id, { resolution });

      const result = await downloadAlbum({
        spec,
        resolution,
        config,
        log,
        onProgress: (progress) => store.setProgress(job.nzo_id, progress),
      });

      const storage = toReported(result.dir, config.pathMap);
      store.complete(job.nzo_id, { storage, size: result.size });
      log(`job ${job.nzo_id} completed: ${result.files.length} file(s), storage=${storage}`);
    } catch (err) {
      store.fail(job.nzo_id, err && err.message ? err.message : String(err));
      log(`job ${job.nzo_id} failed: ${err && err.message ? err.message : err}`);
    }
  }

  /** Re-queue jobs left in `queued` after a restart. */
  function resume() {
    for (const job of store.list()) {
      if (job.status === STATUS.QUEUED) pending.push(job.nzo_id);
    }
    pump();
  }

  return { enqueue, resume, size: () => pending.length };
}
