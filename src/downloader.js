/**
 * yt-dlp download engine.
 *
 * Downloads an album (YouTube Music playlist, a list of video ids, or a
 * ytsearch fallback query) as tagged audio, including embedded cover art where
 * YouTube provides it.
 *
 * yt-dlp produces the audio + embedded thumbnail; a short ffmpeg pass then
 * writes accurate album metadata (artist/album/album_artist/year/track/title)
 * that YouTube's upload dates would otherwise get wrong.
 *
 * `run` is injectable so tests exercise the orchestration without a network or
 * a yt-dlp binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.opus', '.m4a', '.aac', '.ogg', '.oga', '.wav'];

function isAudioFile(name) {
  const ext = path.extname(name).toLowerCase();
  for (const candidate of AUDIO_EXTENSIONS) {
    if (candidate === ext) return true;
  }
  return false;
}

export function safeName(value, fallback = 'Unknown') {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || fallback;
}

export function extensionFor(format) {
  switch (format) {
    case 'flac': return '.flac';
    case 'opus': return '.opus';
    case 'm4a':
    case 'aac': return '.m4a';
    case 'ogg':
    case 'vorbis': return '.ogg';
    default: return '.mp3';
  }
}

function qualityArg(config) {
  if (config.audioQuality) return config.audioQuality;
  if (config.audioFormat === 'mp3') return `${config.audioBitrate || '320'}K`;
  if (config.audioFormat === 'opus') return '160K';
  return '0';
}

export function targetDir(downloadDir, artist, album) {
  const base = `${safeName(artist, 'Unknown Artist')} - ${safeName(album, 'Unknown Album')}`;
  let candidate = path.join(downloadDir, base);
  let n = 1;
  while (fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0) {
    candidate = path.join(downloadDir, `${base} (${n})`);
    n += 1;
  }
  return candidate;
}

function commonArgs(config) {
  const args = [
    '--no-mtime',
    '--newline',
    '--no-color',
    '--ignore-config',
    '-x',
    '--audio-format', config.audioFormat || 'mp3',
    '--audio-quality', qualityArg(config),
    '--embed-thumbnail',
    '--add-metadata',
    '--embed-metadata',
  ];
  if (config.incompleteDir) args.push('--paths', `temp:${config.incompleteDir}`);
  if (config.jsRuntime) args.push('--js-runtimes', config.jsRuntime);
  if (config.ffmpegPath) args.push('--ffmpeg-location', config.ffmpegPath);
  if (config.cookiesFile) args.push('--cookies', config.cookiesFile);
  if (config.cookiesFromBrowser) args.push('--cookies-from-browser', config.cookiesFromBrowser);
  return args;
}

export function buildTrackArgs({ url, outDir, index, config }) {
  const out = path.join(outDir, `${String(index).padStart(2, '0')} - %(title)s.%(ext)s`);
  return [...commonArgs(config), '-o', out, '--', url];
}

export function buildPlaylistArgs({ url, outDir, config }) {
  const out = path.join(outDir, '%(playlist_index)02d - %(title)s.%(ext)s');
  return [...commonArgs(config), '--yes-playlist', '-o', out, '--', url];
}

export function buildSearchArgs({ query, outDir, config }) {
  const out = path.join(outDir, '%(title)s.%(ext)s');
  return [...commonArgs(config), '--no-playlist', '-o', out, '--', `ytsearch${config.ytSearchResults || 1}:${query}`];
}

/** ffmpeg argument list that rewrites tags in place while copying streams. */
export function buildTagArgs({ input, output, meta }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy'];
  const set = (key, value) => {
    const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (clean !== '') args.push('-metadata', `${key}=${clean}`);
  };
  set('title', meta.title);
  set('artist', meta.artist);
  set('album', meta.album);
  set('album_artist', meta.artist);
  set('date', meta.year);
  if (meta.track) set('track', meta.track);
  args.push(output);
  return args;
}

function enumerateAudio(dir) {
  const out = [];
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > 20000) return out;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Derive a clean track number + title from our `<NN> - <title>.<ext>` naming. */
export function parseTrackFilename(file) {
  const base = path.basename(file, path.extname(file));
  const match = base.match(/^(\d+)\s*-\s*(.+)$/);
  if (match) return { track: String(Number.parseInt(match[1], 10)), title: match[2].trim() };
  return { track: '', title: base.trim() };
}

export function defaultRun({ cmd, args, timeoutMs, log, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handle = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      else stdout += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line, isErr);
    };
    child.stdout?.on('data', (c) => handle(c, false));
    child.stderr?.on('data', (c) => handle(c, true));
    child.on('error', (err) => {
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

function parsePercent(line, fallback) {
  const match = line.match(/\[download\]\s+([\d.]+)%/);
  if (match) return Number.parseFloat(match[1]);
  return fallback;
}

/**
 * Download an album.
 *
 * @returns {Promise<{dir:string, files:string[], size:number}>}
 */
export async function downloadAlbum({
  spec,
  resolution,
  config,
  log = () => {},
  onProgress = () => {},
  run = defaultRun,
}) {
  fs.mkdirSync(config.incompleteDir, { recursive: true });
  const outDir = targetDir(config.downloadDir, spec.artist, spec.album);
  fs.mkdirSync(outDir, { recursive: true });

  const timeoutMs = config.downloadTimeoutMs;
  const target = resolution || {};
  let lastPercent = 0;

  if (target.playlistUrl) {
    const args = buildPlaylistArgs({ url: target.playlistUrl, outDir, config });
    const total = target.trackCount || 0;
    await run({
      cmd: config.ytdlpPath,
      args,
      timeoutMs,
      log,
      onLine: (line) => {
        lastPercent = parsePercent(line, lastPercent);
        const m = line.match(/Downloading item (\d+) of (\d+)/) || [];
        const done = Number.parseInt(m[1] || '0', 10);
        const all = total || Number.parseInt(m[2] || '0', 10) || 0;
        const percent = all ? ((Math.max(0, done - 1) + lastPercent / 100) / all) * 100 : lastPercent;
        onProgress({ filesTotal: all || total, filesDone: Math.max(0, done - 1), percent: Math.min(99, percent) });
      },
    });
  } else if (target.videoIds && target.videoIds.length) {
    const total = target.videoIds.length;
    for (let i = 0; i < total; i += 1) {
      const url = `https://www.youtube.com/watch?v=${target.videoIds[i]}`;
      const args = buildTrackArgs({ url, outDir, index: i + 1, config });
      lastPercent = 0;
      await run({
        cmd: config.ytdlpPath,
        args,
        timeoutMs,
        log,
        onLine: (line) => {
          lastPercent = parsePercent(line, lastPercent);
          onProgress({ filesTotal: total, filesDone: i, percent: Math.min(99, ((i + lastPercent / 100) / total) * 100) });
        },
      });
      onProgress({ filesTotal: total, filesDone: i + 1, percent: Math.min(99, ((i + 1) / total) * 100) });
    }
  } else {
    const query = target.query || [spec.artist, spec.album].filter(Boolean).join(' ');
    const args = buildSearchArgs({ query, outDir, config });
    await run({
      cmd: config.ytdlpPath,
      args,
      timeoutMs,
      log,
      onLine: (line) => {
        lastPercent = parsePercent(line, lastPercent);
        onProgress({ filesTotal: 1, filesDone: 0, percent: Math.min(99, lastPercent) });
      },
    });
  }

  const files = enumerateAudio(outDir);
  if (files.length === 0) {
    throw new Error('yt-dlp produced no audio files');
  }

  if (config.tagMetadata !== false) {
    for (const file of files) {
      const parsed = parseTrackFilename(file);
      const tmp = `${file}.tagtmp${path.extname(file)}`;
      const args = buildTagArgs({
        input: file,
        output: tmp,
        meta: {
          title: parsed.title,
          artist: target.artist || spec.artist,
          album: target.title || spec.album,
          year: spec.year || target.year,
          track: parsed.track,
        },
      });
      try {
        await run({ cmd: config.ffmpegPath || 'ffmpeg', args, timeoutMs: 120000, log });
        fs.renameSync(tmp, file);
      } catch (err) {
        log(`tagging ${path.basename(file)} failed: ${err.message}`);
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  const size = files.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);

  return { dir: outDir, files, size };
}
