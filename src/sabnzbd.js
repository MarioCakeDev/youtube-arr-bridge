/**
 * SABnzbd-compatible download-client half.
 *
 * Implements the subset DroppedNeedle (and Lidarr) poll: `version`,
 * `get_config`, `get_cats`, `fullstatus`, `queue`, `history`, `addurl`,
 * `addfile`, plus queue/history delete and pause/resume. Responses are JSON
 * (`output=json`). The `storage` reported in history is the path mapped into the
 * client's namespace by `PATH_MAP`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { encodeReleaseName } from './release.js';
import { parseNzbSpec, estimatedSize } from './newznab.js';
import { STATUS } from './jobs.js';

const PARENT_STATUS = {
  [STATUS.QUEUED]: 'Queued',
  [STATUS.DOWNLOADING]: 'Downloading',
};

function mb(bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(2);
}

function slotFromJob(job, index) {
  const percent = job.status === STATUS.DOWNLOADING ? Math.round(job.progress?.percent || 0) : 0;
  const size = Number(job.size) || 0;
  const left = size * (1 - percent / 100);
  return {
    index,
    nzo_id: job.nzo_id,
    filename: job.name,
    cat: job.category,
    status: PARENT_STATUS[job.status] || 'Queued',
    mb: mb(size),
    mbleft: mb(left),
    size: `${mb(size)} MB`,
    sizeleft: `${mb(left)} MB`,
    percentage: String(percent),
    timeleft: '0:00:00',
    priority: 'Normal',
  };
}

function historySlotFromJob(job) {
  const completed = job.status === STATUS.COMPLETED;
  return {
    nzo_id: job.nzo_id,
    name: job.name,
    nzb_name: `${job.name}.nzb`,
    category: job.category,
    status: completed ? 'Completed' : 'Failed',
    storage: job.storage || '',
    path: job.storage || '',
    bytes: Number(job.size) || 0,
    fail_message: completed ? '' : job.error || 'Download failed',
    download_time: Math.max(0, (job.completed_ts || 0) - (job.started_ts || job.added_ts || 0)),
    completed: completed ? 1 : 0,
  };
}

export function createSabnzbd({ config, store, engine, log = () => {} }) {
  let paused = false;

  function configPayload() {
    return {
      config: {
        misc: {
          complete_dir: config.reportedCompleteDir,
          pre_check: false,
          enable_tv_sorting: false,
          enable_movie_sorting: false,
          enable_date_sorting: false,
          history_retention: '',
          history_retention_option: 'all',
          history_retention_number: 0,
          my_home: config.reportedCompleteDir,
        },
        categories: [
          { name: '*', dir: '' },
          { name: config.category, dir: '' },
        ],
        sorters: [],
      },
    };
  }

  function enqueueFromSpec(spec, category) {
    if (!spec.artist && !spec.album && !spec.query) {
      return { status: false, error: 'Could not determine artist/album from grab' };
    }
    const existing = store.findActive(spec);
    if (existing) return { status: true, nzo_ids: [existing.nzo_id] };
    const title = encodeReleaseName({
      artist: spec.artist,
      album: spec.album,
      year: spec.year,
      format: config.audioFormat,
      bitrate: config.audioBitrate,
    });
    const job = store.create({
      name: title,
      category: category || config.category,
      spec,
      size: estimatedSize(10, config),
    });
    if (spec.youtubeUrl) {
      store.update(job.nzo_id, { resolution: { source: 'ytmusic', playlistUrl: spec.youtubeUrl } });
    }
    log(`enqueued job ${job.nzo_id} (${title})`);
    engine.enqueue(store.get(job.nzo_id));
    return { status: true, nzo_ids: [job.nzo_id] };
  }

  function addUrl(params) {
    const raw = String(params.get('name') || '');
    const category = params.get('cat') || config.category;
    let spec;
    try {
      const url = new URL(raw);
      spec = {
        artist: url.searchParams.get('artist') || '',
        album: url.searchParams.get('album') || '',
        year: url.searchParams.get('year') || '',
        query: url.searchParams.get('q') || '',
        youtubeUrl: url.searchParams.get('youtube_url') || '',
      };
    } catch {
      spec = { artist: '', album: '', query: raw };
    }
    return enqueueFromSpec(spec, category);
  }

  function addFile(params, body) {
    const category = params.get('cat') || config.category;
    const { spec } = parseNzbSpec(body);
    return enqueueFromSpec(spec, category);
  }

  function deleteJob(id, deleteFiles) {
    const job = store.get(id);
    if (!job) return true;
    if (deleteFiles && job.storage) safeRemove(job.storage);
    store.remove(id);
    return true;
  }

  function safeRemove(storagePath) {
    // job.storage is the reported (external) path; only remove if it resolves
    // inside the container's download dir.
    const local = path.resolve(config.downloadDir, path.basename(storagePath));
    const root = path.resolve(config.downloadDir);
    if (local === root || !local.startsWith(root + path.sep)) return;
    try {
      fs.rmSync(local, { recursive: true, force: true });
    } catch (err) {
      log(`could not delete ${local}: ${err.message}`);
    }
  }

  /**
   * @returns {Promise<{status:number, contentType:string, body:string}>}
   */
  async function handle(params, { body = Buffer.alloc(0) } = {}) {
    const mode = String(params.get('mode') || '').toLowerCase();

    if (mode === 'version') return json({ version: '4.2.0' });
    if (mode === 'auth') return json({ auth: 'apikey' });

    const provided = String(params.get('apikey') || '');
    if (!config.apiKey || provided !== config.apiKey) {
      return json({ status: false, error: 'API Key Incorrect' });
    }

    switch (mode) {
      case 'get_config':
        return json(configPayload());
      case 'get_cats':
        return json({ categories: config.category ? [config.category] : [] });
      case 'fullstatus':
        return json({
          status: {
            completedir: config.reportedCompleteDir,
            pause_int: paused ? '1' : '0',
            paused: paused,
          },
        });
      case 'queue':
        return queue(params);
      case 'history':
        return history(params);
      case 'addurl':
        return json(addUrl(params));
      case 'addfile':
        return json(addFile(params, body));
      case 'pause':
        paused = true;
        return json({ status: true });
      case 'resume':
        paused = false;
        return json({ status: true });
      case 'change_cat':
      case 'switch':
      case 'config':
      case 'retry':
      case 'rss':
        return json({ status: true });
      default:
        return json({ status: false, error: `Unknown mode: ${mode}` });
    }
  }

  function queue(params) {
    const name = String(params.get('name') || '').toLowerCase();
    if (name === 'delete') {
      const value = String(params.get('value') || '');
      const delFiles = ['1', 'true'].includes(String(params.get('del_files') || '0'));
      if (value === 'all' || value === '') {
        for (const job of store.active()) deleteJob(job.nzo_id, delFiles);
      } else {
        deleteJob(value, delFiles);
      }
      return json({ status: true });
    }
    const slots = store.active().map((job, index) => slotFromJob(job, index));
    return json({
      queue: {
        status: slots.some((s) => s.status === 'Downloading') ? 'Downloading' : slots.length ? 'Paused' : 'Idle',
        paused: paused,
        speed: '0',
        kbpersec: '0.0',
        mbleft: mb(slots.reduce((sum, s) => sum + Number(s.mbleft) * 1024 * 1024, 0)),
        noofslots: slots.length,
        slots,
      },
    });
  }

  function history(params) {
    const name = String(params.get('name') || '').toLowerCase();
    if (name === 'delete') {
      const value = String(params.get('value') || '');
      const delFiles = ['1', 'true'].includes(String(params.get('del_files') || '0'));
      const terminal = store.list().filter((j) => j.status === STATUS.COMPLETED || j.status === STATUS.FAILED);
      const victims = value === 'all' || value === '' ? terminal : terminal.filter((j) => j.nzo_id === value);
      for (const job of victims) deleteJob(job.nzo_id, delFiles);
      return json({ status: true });
    }
    const nzoFilter = String(params.get('nzo_ids') || '');
    const search = String(params.get('search') || '');
    let jobs = store.list().filter((j) => j.status === STATUS.COMPLETED || j.status === STATUS.FAILED);
    if (nzoFilter) {
      const ids = new Set(nzoFilter.split(',').map((s) => s.trim()));
      jobs = jobs.filter((j) => ids.has(j.nzo_id));
    } else if (search) {
      jobs = jobs.filter((j) => j.name.includes(search));
    }
    const slots = jobs.map(historySlotFromJob);
    return json({ history: { noofslots: slots.length, slots } });
  }

  return { handle, queue, history, configPayload };
}

function json(obj) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
