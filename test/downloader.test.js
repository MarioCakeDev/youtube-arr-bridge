import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildTrackArgs,
  buildPlaylistArgs,
  buildSearchArgs,
  buildTagArgs,
  parseTrackFilename,
  targetDir,
  downloadAlbum,
} from '../src/downloader.js';

function config(overrides = {}) {
  return {
    downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'yab-dl-')),
    incompleteDir: fs.mkdtempSync(path.join(os.tmpdir(), 'yab-inc-')),
    ytdlpPath: 'yt-dlp',
    ffmpegPath: '',
    jsRuntime: 'node',
    cookiesFile: '',
    cookiesFromBrowser: '',
    audioFormat: 'mp3',
    audioBitrate: '320',
    audioQuality: '',
    ytSearchResults: 3,
    downloadTimeoutMs: 60000,
    tagMetadata: false,
    ...overrides,
  };
}

const spec = { artist: 'Radiohead', album: 'In Rainbows', year: '2007' };

test('track args embed the codec, output template and js runtime', () => {
  const args = buildTrackArgs({ url: 'https://youtu.be/x', outDir: '/tmp/o', index: 3, spec, config: config() });
  assert.ok(args.includes('-x'));
  assert.ok(args.includes('--embed-thumbnail'));
  assert.ok(args.includes('--add-metadata'));
  const idx = args.indexOf('--audio-format');
  assert.equal(args[idx + 1], 'mp3');
  assert.ok(args.includes('--js-runtimes'));
  assert.equal(args[args.indexOf('--js-runtimes') + 1], 'node');
  assert.match(args.join(' '), /03 - %\(title\)s\.%\(ext\)s/);
  assert.equal(args[args.length - 1], 'https://youtu.be/x');
});

test('playlist args download the album playlist with a numbered template', () => {
  const args = buildPlaylistArgs({ url: 'https://music.youtube.com/playlist?list=X', outDir: '/tmp/o', config: config() });
  assert.ok(args.includes('--yes-playlist'));
  assert.match(args.join(' '), /%\(playlist_index\)02d - %\(title\)s/);
});

test('search args use ytsearch with the configured result count', () => {
  const args = buildSearchArgs({ query: 'Radiohead In Rainbows', outDir: '/tmp/o', config: config({ ytSearchResults: 5 }) });
  assert.ok(args.includes('--no-playlist'));
  assert.equal(args[args.length - 1], 'ytsearch5:Radiohead In Rainbows');
});

test('flac config produces a flac audio-format argument', () => {
  const args = buildTrackArgs({ url: 'u', outDir: '/tmp/o', index: 1, spec, config: config({ audioFormat: 'flac', audioBitrate: '' }) });
  const idx = args.indexOf('--audio-format');
  assert.equal(args[idx + 1], 'flac');
});

test('tag args carry album metadata and copy streams', () => {
  const args = buildTagArgs({ input: '/x/in.mp3', output: '/x/out.mp3', meta: { title: '15 Step', artist: 'Radiohead', album: 'In Rainbows', year: '2007', track: '1' } });
  const joined = args.join(' ');
  assert.ok(args.includes('-c') && args.includes('copy'));
  assert.match(joined, /-metadata title=15 Step/);
  assert.match(joined, /-metadata album=In Rainbows/);
  assert.match(joined, /-metadata album_artist=Radiohead/);
  assert.match(joined, /-metadata date=2007/);
  assert.match(joined, /-metadata track=1/);
  assert.equal(args[args.length - 1], '/x/out.mp3');
});

test('parseTrackFilename recovers track number and title', () => {
  assert.deepEqual(parseTrackFilename('/x/03 - 15 Step.mp3'), { track: '3', title: '15 Step' });
  assert.deepEqual(parseTrackFilename('/x/Loose Song.mp3'), { track: '', title: 'Loose Song' });
});

test('targetDir avoids clobbering an existing populated folder', () => {
  const cfg = config();
  const first = targetDir(cfg.downloadDir, 'A', 'B');
  fs.mkdirSync(first, { recursive: true });
  fs.writeFileSync(path.join(first, 'old.mp3'), 'x');
  const second = targetDir(cfg.downloadDir, 'A', 'B');
  assert.equal(second, `${first} (1)`);
});

test('downloadAlbum runs once per video id and reports size', async () => {
  const cfg = config();
  const created = [];
  const run = async ({ args }) => {
    const outTemplate = args[args.indexOf('-o') + 1];
    const file = outTemplate.replace('%(title)s', 'Track').replace('%(ext)s', 'mp3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(1024, 7));
    created.push(file);
  };
  const progress = [];
  const result = await downloadAlbum({
    spec,
    resolution: { videoIds: ['a', 'b'], trackCount: 2 },
    config: cfg,
    run,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(created.length, 2);
  assert.equal(result.files.length, 2);
  assert.equal(result.size, 2048);
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1).percent, 99);
});

test('downloadAlbum uses a single playlist invocation when a playlist url is present', async () => {
  const cfg = config();
  let invocations = 0;
  const run = async ({ args }) => {
    invocations += 1;
    const outTemplate = args[args.indexOf('-o') + 1];
    const file = outTemplate.replace('%(playlist_index)02d', '01').replace('%(title)s', 'Track').replace('%(ext)s', 'mp3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(10, 1));
  };
  await downloadAlbum({
    spec,
    resolution: { playlistUrl: 'https://music.youtube.com/playlist?list=X', trackCount: 1 },
    config: cfg,
    run,
  });
  assert.equal(invocations, 1);
});

test('downloadAlbum tags files via ffmpeg when tagMetadata is enabled', async () => {
  const cfg = config({ tagMetadata: true });
  const calls = [];
  const run = async ({ cmd, args }) => {
    calls.push({ cmd, args });
    if (args.includes('-o')) {
      const outTemplate = args[args.indexOf('-o') + 1];
      const file = outTemplate.replace('%(title)s', 'Track').replace('%(ext)s', 'mp3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(10, 1));
    } else {
      // ffmpeg tag pass: copy input bytes to the output path
      const input = args[args.indexOf('-i') + 1];
      const output = args[args.length - 1];
      fs.writeFileSync(output, fs.readFileSync(input));
    }
  };
  await downloadAlbum({
    spec,
    resolution: { videoIds: ['a'], trackCount: 1 },
    config: cfg,
    run,
  });
  const tagCalls = calls.filter((c) => c.args.includes('-metadata'));
  assert.equal(tagCalls.length, 1);
  assert.equal(tagCalls[0].cmd, 'ffmpeg');
});

test('downloadAlbum throws when no audio files are produced', async () => {
  const cfg = config();
  await assert.rejects(
    downloadAlbum({ spec, resolution: { query: 'x' }, config: cfg, run: async () => {} }),
    /no audio files/,
  );
});
