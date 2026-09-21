/**
 * Synthetic release-name encoder / decoder.
 *
 * Lidarr-style quality parsers (and DroppedNeedle's Newznab release scorer) read
 * the quality from the release TITLE. We emit the canonical shape:
 *
 *     Artist - Album (Year) WEB MP3 320
 *     Artist - Album (Year) WEB FLAC
 *     Artist - Album (Year) WEB Opus
 *
 * `parseReleaseName` is the inverse; `roundTrip` proves the two agree, and the
 * test suite round-trips every supported codec.
 */

const FORMATS = {
  mp3: { token: 'MP3', bitrates: ['320', '256', '192', 'V0'] },
  flac: { token: 'FLAC', bitrates: [] },
  opus: { token: 'Opus', bitrates: [] },
  vorbis: { token: 'Vorbis', bitrates: [] },
  aac: { token: 'AAC', bitrates: [] },
  m4a: { token: 'AAC', bitrates: [] },
  ogg: { token: 'Vorbis', bitrates: [] },
};

// Tokens that may appear in the trailing quality block of a release name.
const SOURCE_TOKENS = new Set([
  'WEB', 'WEBRIP', 'CD', 'CDR', 'VINYL', 'V0', 'V2', 'V5', 'CBR', 'VBR',
  'MP3', 'FLAC', 'AAC', 'OPUS', 'VORBIS', 'OGG', 'M4A', 'ALAC', 'WAV',
  'LOSSLESS', '320', '256', '192', '128', '24BIT', '16BIT', 'HI-RES', 'HIRES',
]);

function cleanPart(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatToken(format, bitrate) {
  const entry = FORMATS[String(format).toLowerCase()];
  if (!entry) return 'MP3 320';
  if (entry.token === 'MP3') {
    const br = entry.bitrates.includes(String(bitrate)) ? String(bitrate) : '320';
    return `MP3 ${br}`;
  }
  return entry.token;
}

/**
 * @param {{artist?:string, album?:string, year?:string|number, format?:string,
 *          bitrate?:string|number, source?:string}} spec
 * @returns {string} e.g. `Radiohead - In Rainbows (2007) WEB MP3 320`
 */
export function encodeReleaseName(spec = {}) {
  const artist = cleanPart(spec.artist);
  const album = cleanPart(spec.album);
  const year = cleanPart(spec.year);
  const source = cleanPart(spec.source || 'WEB').toUpperCase();

  const head = artist && album ? `${artist} - ${album}` : artist || album || 'Unknown Release';
  const parts = [head];
  if (year) parts.push(`(${year})`);
  if (source) parts.push(source);
  parts.push(formatToken(spec.format || 'mp3', spec.bitrate));
  return parts.join(' ');
}

/**
 * Inverse of {@link encodeReleaseName}. Tolerant of real-world noise: the year
 * and source/quality tokens are optional, and quality is matched case-insensitively.
 *
 * @param {string} title
 * @returns {{artist:string, album:string, year:string, format:string, bitrate:string, source:string}}
 */
export function parseReleaseName(title) {
  const raw = cleanPart(title);
  let artist = '';
  let rest = raw;
  const dash = raw.match(/^(.*?)\s+-\s+(.*)$/);
  if (dash) {
    artist = cleanPart(dash[1]);
    rest = cleanPart(dash[2]);
  }

  let year = '';
  const yearMatch = rest.match(/\((\d{4})\)/);
  if (yearMatch) {
    year = yearMatch[1];
    rest = cleanPart(rest.replace(yearMatch[0], ' '));
  }

  // Real-world titles carry quality tags in square brackets (`[FLAC] [24BIT]`);
  // unwrap them so the trailing-token scan can read the codec/bitrate.
  rest = cleanPart(rest.replace(/\[([^\]]*)\]/g, ' $1 '));

  const tokens = rest.split(/\s+/).filter(Boolean);
  const quality = [];
  while (tokens.length > 0) {
    const candidate = tokens[tokens.length - 1];
    if (SOURCE_TOKENS.has(candidate.toUpperCase())) {
      quality.unshift(tokens.pop());
    } else {
      break;
    }
  }
  const album = cleanPart(tokens.join(' '));

  let format = '';
  let bitrate = '';
  let source = '';
  for (const token of quality) {
    const up = token.toUpperCase();
    if (['FLAC', 'ALAC', 'WAV', 'LOSSLESS'].includes(up)) { format = up === 'ALAC' ? 'aac' : 'flac'; continue; }
    if (up === 'MP3') { format = 'mp3'; continue; }
    if (up === 'AAC' || up === 'M4A') { format = 'aac'; continue; }
    if (up === 'OPUS') { format = 'opus'; continue; }
    if (up === 'VORBIS' || up === 'OGG') { format = 'vorbis'; continue; }
    if (['WEB', 'WEBRIP', 'CD', 'CDR', 'VINYL', 'CBR', 'VBR', '24BIT', '16BIT', 'HI-RES', 'HIRES'].includes(up)) {
      if (!source) source = up;
      continue;
    }
    if (/^(320|256|192|128|V0|V2|V5)$/.test(up)) { bitrate = up; continue; }
  }
  if (!format && bitrate) format = 'mp3';
  if (format === 'mp3' && !bitrate) bitrate = '320';
  if (!source) source = 'WEB';

  return { artist, album, year, format, bitrate, source };
}

/**
 * Encode then decode, returning both plus whether the re-encoded name is
 * identical. Used by the self-check test.
 */
export function roundTrip(spec) {
  const encoded = encodeReleaseName(spec);
  const parsed = parseReleaseName(encoded);
  const reencoded = encodeReleaseName(parsed);
  return { encoded, parsed, reencoded, stable: encoded === reencoded };
}
