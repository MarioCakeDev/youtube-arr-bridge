import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeReleaseName, parseReleaseName, roundTrip } from '../src/release.js';

test('encodes the canonical Lidarr-readable shape', () => {
  assert.equal(
    encodeReleaseName({ artist: 'Radiohead', album: 'In Rainbows', year: 2007, format: 'mp3', bitrate: '320' }),
    'Radiohead - In Rainbows (2007) WEB MP3 320',
  );
  assert.equal(
    encodeReleaseName({ artist: 'Radiohead', album: 'In Rainbows', year: '2007', format: 'flac' }),
    'Radiohead - In Rainbows (2007) WEB FLAC',
  );
  assert.equal(
    encodeReleaseName({ artist: 'Massive Attack', album: 'Mezzanine', year: 1998, format: 'opus' }),
    'Massive Attack - Mezzanine (1998) WEB Opus',
  );
});

test('parses the canonical shape back into a spec', () => {
  const parsed = parseReleaseName('Radiohead - In Rainbows (2007) WEB MP3 320');
  assert.deepEqual(parsed, {
    artist: 'Radiohead',
    album: 'In Rainbows',
    year: '2007',
    format: 'mp3',
    bitrate: '320',
    source: 'WEB',
  });
});

test('round-trips every supported codec stably', () => {
  const specs = [
    { artist: 'A', album: 'B', year: 2001, format: 'mp3', bitrate: '320' },
    { artist: 'A', album: 'B', year: 2001, format: 'mp3', bitrate: '256' },
    { artist: 'A', album: 'B', year: 2001, format: 'flac' },
    { artist: 'A', album: 'B', year: 2001, format: 'opus' },
    { artist: 'A', album: 'B', year: 2001, format: 'aac' },
    { artist: 'A', album: 'B', year: 2001, format: 'vorbis' },
  ];
  for (const spec of specs) {
    const result = roundTrip(spec);
    assert.equal(result.stable, true, `${result.encoded} did not round-trip`);
    assert.equal(result.parsed.artist, 'A');
    assert.equal(result.parsed.album, 'B');
    assert.equal(result.parsed.year, '2001');
  }
});

test('tolerates real-world title noise', () => {
  const parsed = parseReleaseName('Some Artist - Some Album (2019) [FLAC] [24BIT]');
  assert.equal(parsed.artist, 'Some Artist');
  assert.equal(parsed.album, 'Some Album');
  assert.equal(parsed.year, '2019');
  assert.equal(parsed.format, 'flac');
});

test('quality parser agreement: MP3 320 yields the mp3_320 tier', () => {
  const parsed = parseReleaseName(encodeReleaseName({ artist: 'X', album: 'Y', year: 2000, format: 'mp3', bitrate: '320' }));
  assert.equal(parsed.format, 'mp3');
  assert.equal(parsed.bitrate, '320');
});
