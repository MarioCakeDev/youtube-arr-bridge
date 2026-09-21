import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNewznab,
  capsXml,
  buildEnclosureUrl,
  estimatedSize,
  parseNzbSpec,
  escapeXml,
} from '../src/newznab.js';

function baseConfig(overrides = {}) {
  return {
    apiKey: 'secret',
    audioFormat: 'mp3',
    audioBitrate: '320',
    category: 'music',
    ...overrides,
  };
}

test('caps advertises audio categories and music-search params', () => {
  const xml = capsXml();
  assert.match(xml, /<category id="3000"/);
  assert.match(xml, /<subcat id="3010"/);
  assert.match(xml, /<subcat id="3040"/);
  assert.match(xml, /music-search available="yes" supportedParams="q,artist,album,year"/);
  assert.match(xml, /audio-search available="yes"/);
});

test('caps is served without an api key', async () => {
  const nz = createNewznab({ config: baseConfig() });
  const res = await nz.handle(new URLSearchParams('t=caps'), { baseUrl: 'http://h', apikey: '' });
  assert.match(res.body, /<caps>/);
});

test('wrong api key is rejected with a Newznab error', async () => {
  const nz = createNewznab({ config: baseConfig() });
  const res = await nz.handle(new URLSearchParams('t=search&q=x'), { baseUrl: 'http://h', apikey: 'nope' });
  assert.match(res.body, /<error code="100"/);
});

test('music search returns exactly one item per requested album', async () => {
  const nz = createNewznab({
    config: baseConfig(),
    search: async () => ({ source: 'ytmusic', title: 'In Rainbows', artist: 'Radiohead', year: '2007', trackCount: 10 }),
  });
  const res = await nz.handle(new URLSearchParams('t=music&artist=Radiohead&album=In+Rainbows&year=2007'), {
    baseUrl: 'http://bridge:8484',
    apikey: 'secret',
  });
  const items = res.body.match(/<item>/g) || [];
  assert.equal(items.length, 1);
  assert.match(res.body, /Radiohead - In Rainbows \(2007\) WEB MP3 320/);
  assert.match(res.body, /type="application\/x-nzb"/);
  assert.match(res.body, /http:\/\/bridge:8484\/api\/newznab\/get\?/);
  assert.match(res.body, /newznab:attr name="category" value="3010"/);
});

test('free-text search with a dashed query is split into artist and album', async () => {
  const nz = createNewznab({ config: baseConfig() });
  const spec = nz.buildSpec(new URLSearchParams('t=search&q=Portishead - Dummy'));
  assert.equal(spec.artist, 'Portishead');
  assert.equal(spec.album, 'Dummy');
});

test('get returns a real NZB carrying the grab spec', async () => {
  const nz = createNewznab({ config: baseConfig() });
  const res = await nz.handle(
    new URLSearchParams('t=get&artist=Radiohead&album=In+Rainbows&year=2007'),
    { baseUrl: 'http://h', apikey: 'secret' },
  );
  assert.equal(res.contentType, 'application/x-nzb');
  assert.match(res.body, /^<\?xml/);
  assert.match(res.body, /<nzb /);
  const { spec, meta } = parseNzbSpec(res.body);
  assert.equal(spec.artist, 'Radiohead');
  assert.equal(spec.album, 'In Rainbows');
  assert.equal(spec.year, '2007');
  assert.equal(meta.release, 'Radiohead - In Rainbows (2007) WEB MP3 320');
});

test('get by stable guid works after a search', async () => {
  const nz = createNewznab({ config: baseConfig() });
  const searchRes = await nz.handle(
    new URLSearchParams('t=music&artist=Radiohead&album=In+Rainbows'),
    { baseUrl: 'http://h', apikey: 'secret' },
  );
  const guid = searchRes.body.match(/<guid[^>]*>([^<]+)<\/guid>/)[1];
  const getRes = await nz.handle(new URLSearchParams(`t=get&id=${guid}`), { baseUrl: 'http://h', apikey: 'secret' });
  const { spec } = parseNzbSpec(getRes.body);
  assert.equal(spec.artist, 'Radiohead');
  assert.equal(spec.album, 'In Rainbows');
});

test('flac format advertises lossless category 3040', async () => {
  const nz = createNewznab({ config: baseConfig({ audioFormat: 'flac' }) });
  const res = await nz.handle(new URLSearchParams('t=music&artist=A&album=B'), { baseUrl: 'http://h', apikey: 'secret' });
  assert.match(res.body, /newznab:attr name="category" value="3040"/);
  assert.match(res.body, /WEB FLAC/);
});

test('enclosure url carries the grab query and apikey', () => {
  const url = buildEnclosureUrl('http://h:8484', { artist: 'A', album: 'B', year: '2000' }, baseConfig());
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/api/newznab/get');
  assert.equal(parsed.searchParams.get('artist'), 'A');
  assert.equal(parsed.searchParams.get('album'), 'B');
  assert.equal(parsed.searchParams.get('apikey'), 'secret');
});

test('size estimate is plausible for mp3 and flac', () => {
  const mp3 = estimatedSize(10, baseConfig());
  const flac = estimatedSize(10, baseConfig({ audioFormat: 'flac' }));
  assert.ok(mp3 > 50 * 1024 * 1024 && mp3 < 200 * 1024 * 1024, `mp3=${mp3}`);
  assert.ok(flac > mp3, 'flac should be larger than mp3');
});

test('xml escaping handles ampersands in names', () => {
  assert.equal(escapeXml('Simon & Garfunkel <live>'), 'Simon &amp; Garfunkel &lt;live&gt;');
});
