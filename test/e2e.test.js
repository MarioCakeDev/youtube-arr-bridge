import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs.js';
import { createEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { roundTrip } from '../src/release.js';

const BOUNDARY = '----youtube-arr-bridge-test';

function multipart(nzb) {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"; filename="job.nzb"\r\nContent-Type: application/x-nzb\r\n\r\n${nzb}\r\n--${BOUNDARY}--\r\n`,
    'utf8',
  );
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
}

test('end-to-end: indexer search -> NZB -> addfile -> download -> completed history with mapped storage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yab-e2e-'));
  const downloads = path.join(root, 'downloads');
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    API_KEY: 'secret',
    DOWNLOAD_DIR: downloads,
    INCOMPLETE_DIR: path.join(root, 'incomplete'),
    STATE_DIR: path.join(root, 'state'),
    PATH_MAP: `${downloads}:/sabnzbd-downloads`,
    CONCURRENCY: '1',
    SEARCH_CONFIRM: 'true',
    LOG_LEVEL: 'error',
  });

  const resolvedAlbum = {
    source: 'ytmusic',
    playlistUrl: 'https://music.youtube.com/playlist?list=FAKE',
    trackCount: 2,
    title: 'In Rainbows',
    artist: 'Radiohead',
    year: '2007',
  };
  const resolveAlbum = async () => resolvedAlbum;
  const downloadAlbum = async ({ spec }) => {
    const dir = path.join(downloads, `${spec.artist} - ${spec.album}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = ['01 - 15 Step.mp3', '02 - Bodysnatchers.mp3'].map((name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.alloc(2048, 1));
      return file;
    });
    return { dir, files, size: 4096 };
  };

  const store = new JobStore({ stateDir: config.stateDir, historyLimit: 50 }).load();
  const engine = createEngine({ config, store, log: () => {}, resolveAlbum, downloadAlbum });
  const server = createServer({ config, store, engine, log: () => {}, resolveAlbum });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. caps
    const caps = await (await fetch(`${base}/api?t=caps`)).text();
    assert.match(caps, /<caps>/);

    // 2. indexer search -> one release
    const searchRes = await fetch(
      `${base}/api?t=music&artist=Radiohead&album=In%20Rainbows&year=2007&apikey=secret`,
    );
    const searchXml = await searchRes.text();
    assert.match(searchXml, /Radiohead - In Rainbows \(2007\) WEB MP3 320/);
    const enclosure = searchXml.match(/<enclosure url="([^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.ok(enclosure.includes('/api/newznab/get'));

    // 3. grab the NZB from the enclosure URL
    const nzbRes = await fetch(enclosure);
    assert.equal(nzbRes.headers.get('content-type'), 'application/x-nzb');
    const nzb = await nzbRes.text();
    assert.match(nzb, /<meta type="artist">Radiohead<\/meta>/);

    // 4. hand the NZB to SABnzbd addfile (multipart, as DroppedNeedle does)
    const addRes = await fetch(`${base}/api?mode=addfile&cat=music&apikey=secret&output=json`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipart(nzb),
    });
    const add = await addRes.json();
    assert.equal(add.status, true);
    const nzoId = add.nzo_ids[0];

    // 5. poll history until Completed
    const slot = await waitFor(async () => {
      const hist = await (await fetch(`${base}/api?mode=history&apikey=secret&output=json&nzo_ids=${nzoId}`)).json();
      const found = hist.history.slots.find((s) => s.nzo_id === nzoId);
      return found && found.status === 'Completed' ? found : null;
    });
    assert.equal(slot.storage, '/sabnzbd-downloads/Radiohead - In Rainbows');
    assert.ok(fs.existsSync(path.join(downloads, 'Radiohead - In Rainbows', '01 - 15 Step.mp3')));

    // 6. SAB config advertises the same remap root DroppedNeedle strips
    const cfg = await (await fetch(`${base}/api?mode=get_config&apikey=secret&output=json`)).json();
    assert.equal(cfg.config.misc.complete_dir, '/sabnzbd-downloads');

    // 7. release-name encoder round-trip self-check
    const rt = roundTrip({ artist: 'Radiohead', album: 'In Rainbows', year: 2007, format: 'mp3', bitrate: '320' });
    assert.equal(rt.stable, true);
    assert.equal(rt.encoded, 'Radiohead - In Rainbows (2007) WEB MP3 320');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('failed job surfaces as Failed in history with a fail message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yab-e2e-fail-'));
  const downloads = path.join(root, 'downloads');
  const config = loadConfig({
    API_KEY: 'secret',
    DOWNLOAD_DIR: downloads,
    INCOMPLETE_DIR: path.join(root, 'incomplete'),
    STATE_DIR: path.join(root, 'state'),
    PATH_MAP: `${downloads}:/sabnzbd-downloads`,
    SEARCH_CONFIRM: 'false',
  });
  const store = new JobStore({ stateDir: config.stateDir, historyLimit: 50 }).load();
  const engine = createEngine({
    config,
    store,
    log: () => {},
    downloadAlbum: async () => {
      throw new Error('yt-dlp produced no audio files');
    },
  });
  const server = createServer({ config, store, engine, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const add = await (
      await fetch(`${base}/api?mode=addurl&name=${encodeURIComponent('http://x/get?artist=A&album=B')}&apikey=secret&output=json`)
    ).json();
    const nzoId = add.nzo_ids[0];
    const slot = await waitFor(async () => {
      const hist = await (await fetch(`${base}/api?mode=history&apikey=secret&nzo_ids=${nzoId}`)).json();
      const found = hist.history.slots.find((s) => s.nzo_id === nzoId);
      return found && found.status === 'Failed' ? found : null;
    });
    assert.match(slot.fail_message, /no audio files/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
