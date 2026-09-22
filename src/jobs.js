/**
 * In-memory job registry with JSON persistence.
 *
 * A "job" is one grabbed album. Jobs survive a restart via `stateDir/jobs.json`
 * so a completed history entry (and its storage path) is not lost when the
 * container is recreated. Only a bounded history is retained.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUS = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const ACTIVE = new Set([STATUS.QUEUED, STATUS.DOWNLOADING]);

export function newId() {
  return `nzo_${crypto.randomBytes(8).toString('hex')}`;
}

export class JobStore {
  constructor({ stateDir, historyLimit = 200, log = () => {} } = {}) {
    this.stateDir = stateDir;
    this.historyLimit = historyLimit;
    this.log = log;
    this.jobs = new Map();
    this.file = stateDir ? path.join(stateDir, 'jobs.json') : '';
  }

  load() {
    if (!this.file) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const job of raw.jobs || []) {
        if (job && job.nzo_id) this.jobs.set(job.nzo_id, job);
      }
      // A job interrupted mid-download is retried at boot.
      for (const job of this.jobs.values()) {
        if (job.status === STATUS.DOWNLOADING) job.status = STATUS.QUEUED;
      }
      this.log(`loaded ${this.jobs.size} job(s) from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`could not load jobs: ${err.message}`);
    }
    return this;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      const body = JSON.stringify({ version: 1, jobs: [...this.jobs.values()] });
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`could not persist jobs: ${err.message}`);
    }
  }

  list() {
    return [...this.jobs.values()];
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  active() {
    return this.list().filter((j) => ACTIVE.has(j.status));
  }

  /** Idempotent: an active job for the same artist+album is reused. */
  findActive(spec) {
    const artist = String(spec.artist || '').toLowerCase();
    const album = String(spec.album || '').toLowerCase();
    return (
      this.active().find(
        (j) =>
          String(j.spec?.artist || '').toLowerCase() === artist &&
          String(j.spec?.album || '').toLowerCase() === album,
      ) || null
    );
  }

  create({ name, category, spec, size = 0 }) {
    const id = newId();
    const job = {
      nzo_id: id,
      name: name || spec?.album || 'Unknown Release',
      category: category || '',
      status: STATUS.QUEUED,
      storage: '',
      size: Number(size) || 0,
      spec: spec || {},
      resolution: null,
      progress: { percent: 0, filesTotal: 0, filesDone: 0, bytes: 0 },
      error: '',
      added_ts: Math.floor(Date.now() / 1000),
      started_ts: 0,
      completed_ts: 0,
    };
    this.jobs.set(id, job);
    this.prune();
    this.save();
    return job;
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    this.save();
    return job;
  }

  setProgress(id, progress) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = { ...job.progress, ...progress };
  }

  complete(id, { storage, size }) {
    return this.update(id, {
      status: STATUS.COMPLETED,
      storage: storage || '',
      size: Number(size) || 0,
      progress: { ...(this.get(id)?.progress || {}), percent: 100 },
      completed_ts: Math.floor(Date.now() / 1000),
    });
  }

  fail(id, error) {
    return this.update(id, {
      status: STATUS.FAILED,
      error: String(error || 'Download failed').slice(0, 500),
      completed_ts: Math.floor(Date.now() / 1000),
    });
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    this.jobs.delete(id);
    this.prune();
    this.save();
    return job;
  }

  prune() {
    if (this.jobs.size <= this.historyLimit) return;
    const terminal = this.list()
      .filter((j) => j.status === STATUS.COMPLETED || j.status === STATUS.FAILED)
      .sort((a, b) => (a.completed_ts || 0) - (b.completed_ts || 0));
    while (this.jobs.size > this.historyLimit && terminal.length) {
      this.jobs.delete(terminal.shift().nzo_id);
    }
  }
}
