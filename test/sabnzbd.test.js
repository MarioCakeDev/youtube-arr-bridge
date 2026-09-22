import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSabnzbd } from '../src/sabnzbd.js';
import { JobStore } from '../src/jobs.js';
import { buildNzb } from '../src/newznab.js';

const TOKEN = 'test-key';

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yab-sab-'));
  const config = {
    apiKey: TOKEN,
    reportedCompleteDir: '/sabnzbd-downloads',
    downloadDir: path.join(dir, 'downloads'),
    category: 'music',
    audioFormat: 'mp3',
    audioBitrate: '320',
    historyLimit: 50,
    ...overrides,
  };
  fs.mkdirSync(config.downloadDir, { recursive: true });
  const store = new JobStore({ stateDir: path.join(dir, 'state'), historyLimit: 50 });
  const enqueued = [];
  const engine = { enqueue: (job) => enqueued.push(job) };
  const sab = createSabnzbd({ config, store, engine, log: () => {} });
  return { config, store, engine, sab, enqueued };
}

const key = (extra) => new URLSearchParams({ apikey: TOKEN, ...extra });

test('version responds without an api key', async () => {
  const { sab } = setup();
  const res = await sab.handle(new URLSearchParams('mode=version'));
  assert.deepEqual(JSON.parse(res.body), { version: '4.2.0' });
});

test('wrong api key is rejected in SAB JSON form', async () => {
  const { sab } = setup();
  const res = await sab.handle(new URLSearchParams('mode=queue&apikey=nope'));
  assert.deepEqual(JSON.parse(res.body), { status: false, error: 'API Key Incorrect' });
});

test('get_config advertises the reported complete dir and category', async () => {
  const { sab } = setup();
  const res = await sab.handle(key({ mode: 'get_config' }));
  const body = JSON.parse(res.body);
  assert.equal(body.config.misc.complete_dir, '/sabnzbd-downloads');
  assert.deepEqual(body.config.categories.map((c) => c.name), ['*', 'music']);
});

test('get_cats lists the configured category', async () => {
  const { sab } = setup();
  const res = await sab.handle(key({ mode: 'get_cats' }));
  assert.deepEqual(JSON.parse(res.body), { categories: ['music'] });
});

test('addurl enqueues a job and returns an nzo_id', async () => {
  const { sab, store, enqueued } = setup();
  const url = 'http://bridge/api/newznab/get?artist=Radiohead&album=In%20Rainbows&year=2007';
  const res = await sab.handle(key({ mode: 'addurl', name: url, cat: 'music' }));
  const body = JSON.parse(res.body);
  assert.equal(body.status, true);
  assert.equal(body.nzo_ids.length, 1);
  assert.equal(store.list().length, 1);
  assert.equal(enqueued.length, 1);

  const queue = JSON.parse((await sab.handle(key({ mode: 'queue' }))).body);
  assert.equal(queue.queue.slots.length, 1);
  assert.equal(queue.queue.slots[0].status, 'Queued');
  assert.equal(queue.queue.slots[0].nzo_id, body.nzo_ids[0]);
});

test('addfile parses the NZB meta and enqueues', async () => {
  const { sab, store } = setup();
  const nzb = buildNzb({
    spec: { artist: 'Portishead', album: 'Dummy', year: '1994' },
    title: 'Portishead - Dummy (1994) WEB MP3 320',
    category: 'music',
    resolution: null,
  });
  const body = Buffer.from(nzb, 'utf8');
  const res = await sab.handle(key({ mode: 'addfile', cat: 'music' }), { body });
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, true);
  assert.equal(store.list()[0].spec.artist, 'Portishead');
  assert.equal(store.list()[0].spec.album, 'Dummy');
});

test('history reports Completed with the mapped storage path', async () => {
  const { sab, store } = setup();
  const job = store.create({ name: 'Artist - Album (2000) WEB MP3 320', category: 'music', spec: { artist: 'Artist', album: 'Album' } });
  store.update(job.nzo_id, { status: 'downloading', started_ts: 1 });
  store.complete(job.nzo_id, { storage: '/sabnzbd-downloads/Artist - Album', size: 123456 });
  const res = await sab.handle(key({ mode: 'history' }));
  const slot = JSON.parse(res.body).history.slots[0];
  assert.equal(slot.status, 'Completed');
  assert.equal(slot.storage, '/sabnzbd-downloads/Artist - Album');
  assert.equal(slot.bytes, 123456);
});

test('history reports Failed with a fail message', async () => {
  const { sab, store } = setup();
  const job = store.create({ name: 'X', category: 'music', spec: { artist: 'X', album: 'Y' } });
  store.fail(job.nzo_id, 'yt-dlp exploded');
  const res = await sab.handle(key({ mode: 'history' }));
  const slot = JSON.parse(res.body).history.slots[0];
  assert.equal(slot.status, 'Failed');
  assert.match(slot.fail_message, /yt-dlp exploded/);
});

test('idempotent grab: a second addurl for the same album reuses the job', async () => {
  const { sab, store } = setup();
  const url = 'http://bridge/api/newznab/get?artist=A&album=B';
  const first = JSON.parse((await sab.handle(key({ mode: 'addurl', name: url }))).body);
  const second = JSON.parse((await sab.handle(key({ mode: 'addurl', name: url }))).body);
  assert.equal(first.nzo_ids[0], second.nzo_ids[0]);
  assert.equal(store.list().length, 1);
});

test('history delete removes the job', async () => {
  const { sab, store } = setup();
  const job = store.create({ name: 'X', category: 'music', spec: { artist: 'X', album: 'Y' } });
  store.complete(job.nzo_id, { storage: '/sabnzbd-downloads/X', size: 1 });
  await sab.handle(key({ mode: 'history', name: 'delete', value: job.nzo_id, del_files: '0' }));
  assert.equal(store.list().length, 0);
});

test('addurl drops a non-YouTube youtube_url so the job re-resolves', async () => {
  const { sab, store } = setup();
  const url = 'http://bridge/api/newznab/get?artist=A&album=B&youtube_url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data';
  const res = JSON.parse((await sab.handle(key({ mode: 'addurl', name: url }))).body);
  const job = store.get(res.nzo_ids[0]);
  assert.equal(job.spec.youtubeUrl, '');
  assert.equal(job.resolution, null);
});

test('addurl keeps a valid music.youtube.com youtube_url as the resolution', async () => {
  const { sab, store } = setup();
  const url = 'http://bridge/api/newznab/get?artist=A&album=B&youtube_url=https%3A%2F%2Fmusic.youtube.com%2Fplaylist%3Flist%3DX';
  const res = JSON.parse((await sab.handle(key({ mode: 'addurl', name: url }))).body);
  const job = store.get(res.nzo_ids[0]);
  assert.equal(job.resolution.playlistUrl, 'https://music.youtube.com/playlist?list=X');
});

test('history exposes unix completed and time_added timestamps', async () => {
  const { sab, store } = setup();
  const job = store.create({ name: 'X', category: 'music', spec: { artist: 'X', album: 'Y' } });
  const added = job.added_ts;
  store.update(job.nzo_id, { status: 'downloading', started_ts: added + 1 });
  store.complete(job.nzo_id, { storage: '/sabnzbd-downloads/X', size: 10 });
  const slot = JSON.parse((await sab.handle(key({ mode: 'history' }))).body).history.slots[0];
  const done = store.get(job.nzo_id).completed_ts;
  assert.ok(done > 1_000_000_000, `completed_ts=${done}`);
  assert.equal(slot.completed, done);
  assert.equal(slot.time_added, added);
  assert.ok(slot.download_time >= 0);
});

test('wrong-length api key is rejected without throwing', async () => {
  const { sab } = setup();
  const res = await sab.handle(new URLSearchParams('mode=queue&apikey=x'));
  assert.deepEqual(JSON.parse(res.body), { status: false, error: 'API Key Incorrect' });
});

test('pause and resume are reflected on the queue', async () => {
  const { sab } = setup();
  await sab.handle(key({ mode: 'pause' }));
  assert.equal(JSON.parse((await sab.handle(key({ mode: 'queue' }))).body).queue.paused, true);
  await sab.handle(key({ mode: 'resume' }));
  assert.equal(JSON.parse((await sab.handle(key({ mode: 'queue' }))).body).queue.paused, false);
});
