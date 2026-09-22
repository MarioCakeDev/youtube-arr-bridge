/**
 * Environment-only configuration.
 *
 * Secrets (the shared API key, yt-dlp cookies) are read from the environment
 * and never logged or committed. Every knob has a safe default so the service
 * boots with only API_KEY set.
 */

const AUDIO_FORMATS = new Set(['mp3', 'flac', 'opus', 'm4a', 'aac', 'ogg']);

function normalizePrefix(p) {
  if (!p) return '';
  let out = String(p).replace(/\\/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Parse `internal:external` prefix pairs, comma separated. */
export function parsePathMap(raw) {
  const source = raw === undefined || raw === null ? '' : String(raw);
  const pairs = [];
  for (const entry of source.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const internal = normalizePrefix(entry.slice(0, idx).trim());
    const external = normalizePrefix(entry.slice(idx + 1).trim());
    if (internal && external) pairs.push([internal, external]);
  }
  // Longest internal prefix first so nested mounts resolve deterministically.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

export function loadConfig(env = process.env) {
  const get = (name, fallback) => {
    const v = env[name];
    return v === undefined || v === '' ? fallback : v;
  };
  const num = (name, fallback) => {
    const v = Number.parseInt(get(name, ''), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const flag = (name, fallback) => {
    const v = String(get(name, '')).toLowerCase();
    if (v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v);
  };

  const downloadDir = normalizePrefix(get('DOWNLOAD_DIR', '/downloads'));
  const pathMap = parsePathMap(get('PATH_MAP', `${downloadDir}:/sabnzbd-downloads`));

  // The path DroppedNeedle sees for the completed-downloads root. Defaults to
  // the external side of the path map for DOWNLOAD_DIR.
  let reportedCompleteDir = get('REPORTED_COMPLETE_DIR', '');
  if (!reportedCompleteDir) {
    const hit = pathMap.find(([internal]) => internal === downloadDir);
    reportedCompleteDir = hit ? hit[1] : downloadDir;
  }
  reportedCompleteDir = normalizePrefix(reportedCompleteDir);

  let format = String(get('AUDIO_FORMAT', 'mp3')).toLowerCase();
  if (!AUDIO_FORMATS.has(format)) format = 'mp3';

  return {
    port: num('PORT', 8484),
    host: get('HOST', '0.0.0.0'),
    apiKey: get('API_KEY', ''),
    logLevel: String(get('LOG_LEVEL', 'info')).toLowerCase(),

    // Paths (internal to this container).
    downloadDir,
    incompleteDir: normalizePrefix(get('INCOMPLETE_DIR', '/incomplete')),
    stateDir: normalizePrefix(get('STATE_DIR', '/data')),
    pathMap,
    reportedCompleteDir,
    // Public URL used in Newznab enclosure URLs. Empty => derive from Host header.
    publicBaseUrl: get('PUBLIC_BASE_URL', '').replace(/\/$/, ''),

    // Download engine.
    ytdlpPath: get('YTDLP_PATH', 'yt-dlp'),
    ffmpegPath: get('FFMPEG_PATH', ''),
    // JS runtime for yt-dlp's EJS challenge solver. Node ships in this image,
    // so it is the default; set to `deno` if a Deno binary is provided.
    jsRuntime: get('YT_JS_RUNTIME', 'node'),
    // Rewrite tags with a short ffmpeg pass after yt-dlp (accurate album year).
    tagMetadata: flag('TAG_METADATA', true),
    cookiesFile: get('COOKIES_FILE', ''),
    cookiesFromBrowser: get('YT_COOKIES_FROM_BROWSER', ''),
    concurrency: Math.max(1, num('CONCURRENCY', 1)),
    audioFormat: format,
    audioBitrate: format === 'mp3' ? String(num('AUDIO_BITRATE', 320)) : '',
    audioQuality: get('AUDIO_QUALITY', ''),
    ytSearchResults: Math.max(1, num('YT_SEARCH_RESULTS', 5)),
    // Best-effort YouTube confirmation during indexer search. When false the
    // search returns the synthetic release immediately without a network call.
    searchConfirm: flag('SEARCH_CONFIRM', true),
    searchTimeoutMs: Math.max(1000, num('SEARCH_TIMEOUT_MS', 8000)),
    downloadTimeoutMs: Math.max(60000, num('DOWNLOAD_TIMEOUT_MS', 45 * 60 * 1000)),

    // SABnzbd surface.
    category: get('CATEGORY', 'music'),
    historyLimit: Math.max(1, num('HISTORY_LIMIT', 200)),
  };
}
