/**
 * Newznab indexer half.
 *
 * `t=caps` advertises audio categories 3000/3010/3040 and the
 * q,artist,album,year music-search parameters. `t=search|music|audio|album`
 * returns one RSS <item> per requested album whose title encodes the quality
 * (`Artist - Album (Year) WEB MP3 320`). The enclosure URL points back at
 * `t=get`, which serves a minimal NZB carrying the grab spec the SABnzbd half
 * consumes.
 */

import crypto from 'node:crypto';
import { encodeReleaseName } from './release.js';

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attr(value) {
  return escapeXml(value).replace(/\n/g, ' ');
}

function hashSpec(spec) {
  return crypto
    .createHash('sha1')
    .update(`${spec.artist}|${spec.album}|${spec.year || ''}`.toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

const AVG_TRACK_SECONDS = 240;

function nominalKbps(config) {
  switch (config.audioFormat) {
    case 'flac': return 900;
    case 'opus': return 160;
    case 'm4a':
    case 'aac': return 256;
    case 'ogg':
    case 'vorbis': return 256;
    default: return Number.parseInt(config.audioBitrate || '320', 10) || 320;
  }
}

export function estimatedSize(trackCount, config) {
  const tracks = Math.max(1, Number(trackCount) || 10);
  return Math.round((tracks * (nominalKbps(config) * 1000 / 8) * AVG_TRACK_SECONDS));
}

function categoryId(config) {
  return config.audioFormat === 'flac' ? 3040 : 3010;
}

export function capsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="YouTube *arr Bridge" version="0.1.0"/>
  <limits max="100" default="50"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <music-search available="yes" supportedParams="q,artist,album,year"/>
    <audio-search available="yes" supportedParams="q,artist,album,year"/>
  </searching>
  <categories>
    <category id="3000" name="Audio">
      <subcat id="3010" name="Audio/MP3"/>
      <subcat id="3040" name="Audio/Lossless"/>
    </category>
  </categories>
</caps>`;
}

export function errorXml(code, description) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<error code="${attr(code)}" description="${attr(description)}"/>`;
}

function splitQuery(q) {
  const text = String(q || '').trim();
  if (!text) return { artist: '', album: '' };
  const match = text.match(/^(.*?)\s+-\s+(.*)$/);
  if (match) return { artist: match[1].trim(), album: match[2].trim() };
  return { artist: '', album: text };
}

export function buildEnclosureUrl(baseUrl, spec, config) {
  const params = new URLSearchParams();
  if (spec.artist) params.set('artist', spec.artist);
  if (spec.album) params.set('album', spec.album);
  if (spec.year) params.set('year', String(spec.year));
  if (spec.query) params.set('q', spec.query);
  const format = (spec.format || config.audioFormat || 'mp3');
  params.set('format', format);
  if (spec.bitrate || config.audioBitrate) params.set('bitrate', String(spec.bitrate || config.audioBitrate));
  params.set('apikey', config.apiKey);
  return `${baseUrl}/api/newznab/get?${params.toString()}`;
}

export function buildSearchXml(items, channelTitle = 'YouTube *arr Bridge') {
  const rendered = items.map((item) => {
    const cat = item.categoryId;
    const attrs = [
      `<newznab:attr name="category" value="3000"/>`,
      `<newznab:attr name="category" value="${cat}"/>`,
      `<newznab:attr name="size" value="${item.size}"/>`,
      `<newznab:attr name="files" value="${item.files}"/>`,
      `<newznab:attr name="grabs" value="0"/>`,
      `<newznab:attr name="usenetdate" value="${attr(item.pubDate)}"/>`,
    ].join('\n      ');
    return `  <item>
    <title>${escapeXml(item.title)}</title>
    <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
    <link>${escapeXml(item.url)}</link>
    <pubDate>${attr(item.pubDate)}</pubDate>
    <size>${item.size}</size>
    <category>${cat}</category>
    <enclosure url="${attr(item.url)}" length="${item.size}" type="application/x-nzb"/>
    ${attrs}
  </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel>
  <title>${escapeXml(channelTitle)}</title>
  ${rendered.join('\n  ')}
</channel>
</rss>`;
}

export function buildNzb({ spec, title, category, resolution }) {
  const metas = [
    ['type', 'youtube-arr-bridge'],
    ['artist', spec.artist || ''],
    ['album', spec.album || ''],
    ['year', spec.year || ''],
    ['query', spec.query || ''],
    ['category', category || ''],
    ['release', title || ''],
  ];
  if (resolution?.playlistUrl) metas.push(['youtube_url', resolution.playlistUrl]);
  const metaXml = metas
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `    <meta type="${attr(k)}">${escapeXml(v)}</meta>`)
    .join('\n');
  const subject = `${title || 'release'} [youtube-arr-bridge]`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head>
${metaXml}
  </head>
  <file poster="youtube-arr-bridge@localhost" date="${Math.floor(Date.now() / 1000)}" subject="${attr(subject)}">
    <groups><group>alt.binaries.youtube</group></groups>
    <segments>
      <segment bytes="1" number="1">placeholder@localhost</segment>
    </segments>
  </file>
</nzb>`;
}

/** Extract embedded meta tags from NZB bytes (or any body containing them). */
export function parseNzbSpec(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
  const meta = {};
  const re = /<meta\s+type="([^"]+)"\s*>([\s\S]*?)<\/meta>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    meta[match[1]] = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
  const spec = {
    artist: meta.artist || '',
    album: meta.album || '',
    year: meta.year || '',
    query: meta.query || '',
    youtubeUrl: meta.youtube_url || '',
  };
  return { spec, meta };
}

/**
 * Factory for the Newznab handler.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} deps.log
 * @param {Function} [deps.search] async (spec) => resolution; best-effort YouTube confirmation
 */
export function createNewznab({ config, log = () => {}, search = null }) {
  // guid -> { spec, resolution } so `t=get&id=` also works.
  const registry = new Map();

  function buildSpec(params) {
    const artist = String(params.get('artist') || '').trim();
    const album = String(params.get('album') || '').trim();
    const q = String(params.get('q') || '').trim();
    const year = String(params.get('year') || '').trim();
    if (!artist && !album && q) {
      const split = splitQuery(q);
      return { artist: split.artist, album: split.album, year, query: q };
    }
    return { artist, album, year, query: q };
  }

  async function handleSearch(params, { baseUrl }) {
    const spec = buildSpec(params);
    if (!spec.artist && !spec.album) {
      return { contentType: 'application/rss+xml', body: buildSearchXml([]) };
    }

    let resolution = null;
    if (search) {
      try {
        resolution = await search(spec);
      } catch (err) {
        log(`search confirmation failed: ${err.message}`);
      }
    }

    const trackCount = resolution?.trackCount || 0;
    const size = estimatedSize(trackCount, config);
    const title = encodeReleaseName({
      artist: resolution?.artist || spec.artist,
      album: resolution?.title || spec.album,
      year: resolution?.year || spec.year,
      format: config.audioFormat,
      bitrate: config.audioBitrate,
      source: 'WEB',
    });
    const guid = `yab-${hashSpec(spec)}-${Math.floor(Date.now() / 86400000)}`;
    const url = buildEnclosureUrl(baseUrl, spec, config);
    const pubDate = new Date().toUTCString();
    registry.set(guid, { spec, resolution, title });
    const item = {
      title,
      guid,
      url,
      size,
      files: Math.max(1, trackCount || 1),
      categoryId: categoryId(config),
      pubDate,
    };
    return { contentType: 'application/rss+xml', body: buildSearchXml([item]) };
  }

  function handleGet(params, { baseUrl }) {
    const id = String(params.get('id') || '').trim();
    let spec;
    let resolution = null;
    let title = '';
    if (id && registry.has(id)) {
      ({ spec, resolution, title } = registry.get(id));
    } else {
      spec = buildSpec(params);
      if (!spec.artist && !spec.album && !spec.query) {
        return { status: 200, contentType: 'application/xml', body: errorXml(200, 'Missing id or artist/album') };
      }
      title = encodeReleaseName({
        artist: spec.artist,
        album: spec.album,
        year: spec.year,
        format: String(params.get('format') || config.audioFormat),
        bitrate: String(params.get('bitrate') || config.audioBitrate),
      });
    }
    const nzb = buildNzb({ spec, title, category: config.category, resolution });
    return { status: 200, contentType: 'application/x-nzb', body: nzb };
  }

  /**
   * @returns {Promise<{status:number, contentType:string, body:string}>}
   */
  async function handle(params, { baseUrl, apikey }) {
    const t = String(params.get('t') || '').toLowerCase();
    if (t === 'caps' || t === '') {
      if (t === '') {
        // No `t`: still useful for a client probe.
        return { status: 200, contentType: 'application/xml', body: capsXml() };
      }
      return { status: 200, contentType: 'application/xml', body: capsXml() };
    }
    if (!config.apiKey || apikey !== config.apiKey) {
      return { status: 200, contentType: 'application/xml', body: errorXml(100, 'Incorrect user credentials') };
    }
    if (t === 'get') return handleGet(params, { baseUrl });
    if (['search', 'music', 'audio', 'album', 'tvsearch', 'movie'].includes(t)) {
      return { ...(await handleSearch(params, { baseUrl })), status: 200 };
    }
    return { status: 200, contentType: 'application/xml', body: errorXml(202, `No such function: ${t}`) };
  }

  return { handle, capsXml, registry, buildSpec };
}
