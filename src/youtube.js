/**
 * YouTube Music album resolver.
 *
 * Uses YouTube Music's public InnerTube endpoint (no API key from the user, no
 * npm dependency) to find the album matching `artist/album[/year]`, then reads
 * the album page for its playlist id, track list and artwork. If anything
 * fails the caller falls back to a yt-dlp `ytsearch` query, so a YouTube Music
 * change degrades gracefully instead of breaking grabs.
 *
 * All network access goes through `deps.fetchImpl` so tests can inject a fake.
 */

const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const BASE_CONTEXT = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00',
    hl: 'en',
    gl: 'US',
  },
};

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node);
  for (const key of Object.keys(node)) walk(node[key], visit);
}

function collectText(node, out = []) {
  walk(node, (o) => {
    if (typeof o.text === 'string') out.push(o.text);
    if (o.simpleText) out.push(o.simpleText);
  });
  return out;
}

/** Return the first non-empty string value produced by `pick` over the tree. */
function firstValue(root, pick) {
  let found = '';
  walk(root, (o) => {
    if (found) return;
    const value = pick(o);
    if (typeof value === 'string' && value) found = value;
  });
  return found;
}

function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Pick the album candidate whose text best matches artist + album. */
function chooseAlbumCandidate(searchJson, { artist, album }) {
  const candidates = [];
  const seen = new Set();
  walk(searchJson, (node) => {
    if (!node || typeof node !== 'object') return;
    const browseIds = [];
    walk(node, (o) => {
      if (typeof o.browseId === 'string' && o.browseId.startsWith('MPREb_')) browseIds.push(o.browseId);
    });
    if (browseIds.length === 0) return;
    const text = collectText(node).join(' ');
    for (const browseId of browseIds) {
      if (seen.has(browseId)) continue;
      seen.add(browseId);
      candidates.push({ browseId, text });
    }
  });
  if (candidates.length === 0) return null;

  const wantArtist = norm(artist);
  const wantAlbum = norm(album);
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const text = norm(c.text);
    let score = 0;
    if (wantAlbum && text.includes(wantAlbum)) score += 10;
    if (wantArtist && text.includes(wantArtist)) score += 5;
    if (wantAlbum && !text.includes(wantAlbum)) score -= 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function innertube(fetchImpl, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://music.youtube.com/youtubei/v1/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ context: BASE_CONTEXT, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`innertube ${path} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseAlbumBrowse(browseJson, spec) {
  const playlistIds = [];
  walk(browseJson, (o) => {
    if (typeof o.playlistId === 'string' && o.playlistId.startsWith('OLAK5uy_')) playlistIds.push(o.playlistId);
  });
  // The album's own playlist id is repeated for every track row; the most
  // frequent OLAK5uy_ id is the album, related-album carousels contribute one-offs.
  const counts = new Map();
  for (const id of playlistIds) counts.set(id, (counts.get(id) || 0) + 1);
  let albumPlaylistId = '';
  let best = 0;
  for (const [id, count] of counts) {
    if (count > best) {
      best = count;
      albumPlaylistId = id;
    }
  }

  // Track rows: one musicResponsiveListItemRenderer per song.
  const videoIds = [];
  const titles = [];
  const rows = [];
  walk(browseJson, (o) => {
    if (o && typeof o === 'object' && o.musicResponsiveListItemRenderer) rows.push(o.musicResponsiveListItemRenderer);
  });
  for (const row of rows) {
    const videoId = firstValue(row, (o) => (typeof o.videoId === 'string' ? o.videoId : ''));
    const title = (row.flexColumns || [])
      .map((c) => collectText(c).join(' '))
      .join(' ')
      .trim();
    if (videoId && !videoIds.includes(videoId)) {
      videoIds.push(videoId);
      titles.push(title);
    }
  }

  // Header: title + "Artist • Album • Year" subtitle.
  let header = null;
  walk(browseJson, (o) => {
    if (!header && o && typeof o === 'object' && o.musicResponsiveHeaderRenderer) header = o.musicResponsiveHeaderRenderer;
  });
  let title = spec.album || '';
  let artist = spec.artist || '';
  let year = spec.year ? String(spec.year) : '';
  let thumbnail = '';
  if (header) {
    const headerTitleRuns = header.title?.runs;
    if (Array.isArray(headerTitleRuns) && headerTitleRuns.length) {
      title = headerTitleRuns.map((r) => r.text).join('').trim() || title;
    }
    // YouTube Music puts the album artist in `straplineTextOne` ("Radiohead"),
    // while the subtitle is "Album • <year>". Fall back to the first non-year
    // subtitle part for layouts that omit the strapline.
    const straplineRuns = header.straplineTextOne?.runs || header.strapline?.runs;
    if (Array.isArray(straplineRuns) && straplineRuns.length) {
      const value = straplineRuns.map((r) => r.text).join('').trim();
      if (value) artist = value;
    }
    const subtitleRuns = header.subtitle?.runs;
    if (Array.isArray(subtitleRuns) && subtitleRuns.length) {
      const parts = subtitleRuns
        .map((r) => r.text)
        .filter((t) => !/^\s*[•·]\s*$/.test(t))
        .map((t) => t.trim())
        .filter(Boolean);
      const yr = parts.find((p) => /^\d{4}$/.test(p));
      if (yr) year = yr;
      if (!artist) {
        const candidate = parts.find((p) => p.toLowerCase() !== 'album' && !/^\d{4}$/.test(p));
        if (candidate) artist = candidate;
      }
    }
    thumbnail = firstValue(header, (o) => (typeof o.url === 'string' && /googleusercontent|ggpht/.test(o.url) ? o.url : ''));
  }

  return {
    source: 'ytmusic',
    browseId: spec.browseId,
    playlistUrl: albumPlaylistId ? `https://music.youtube.com/playlist?list=${albumPlaylistId}` : '',
    videoIds,
    trackCount: videoIds.length,
    title,
    artist,
    year,
    thumbnail,
  };
}

/**
 * Resolve an album spec to a download target.
 *
 * @param {{artist?:string, album?:string, year?:string, query?:string}} spec
 * @param {{fetchImpl?:Function, timeoutMs?:number, log?:Function}} deps
 * @returns {Promise<object>} resolution; `source:'ytsearch'` means the downloader
 *   should fall back to a yt-dlp search query.
 */
export async function resolveAlbum(spec, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || 8000;
  const log = deps.log || (() => {});
  const artist = String(spec.artist || '').trim();
  const album = String(spec.album || '').trim();
  const year = String(spec.year || '').trim();
  const fallbackQuery = [artist, album].filter(Boolean).join(' ') || String(spec.query || '').trim();

  if (!artist && !album) {
    return { source: 'ytsearch', query: String(spec.query || '').trim(), videoIds: [], trackCount: 0 };
  }

  try {
    const query = [artist, album, year].filter(Boolean).join(' ');
    const searchJson = await innertube(fetchImpl, 'search', { query }, timeoutMs);
    const candidate = chooseAlbumCandidate(searchJson, { artist, album });
    if (!candidate) throw new Error('no album result');
    const browseJson = await innertube(fetchImpl, 'browse', { browseId: candidate.browseId }, timeoutMs);
    const result = parseAlbumBrowse(browseJson, { ...spec, browseId: candidate.browseId });
    if (!result.playlistUrl && result.videoIds.length === 0) throw new Error('album had no tracks');
    log(`ytmusic resolved "${artist} - ${album}" -> ${result.playlistUrl || result.videoIds.length + ' tracks'} (${result.trackCount})`);
    return result;
  } catch (err) {
    log(`ytmusic resolution failed (${err.message}); falling back to ytsearch`);
    return { source: 'ytsearch', query: fallbackQuery, videoIds: [], trackCount: 0, title: album, artist, year };
  }
}
