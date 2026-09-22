import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePathMap, loadConfig } from '../src/config.js';
import { toReported, reportedJoin } from '../src/pathmap.js';

test('parses a single path-map pair', () => {
  assert.deepEqual(parsePathMap('/downloads:/sabnzbd-downloads'), [['/downloads', '/sabnzbd-downloads']]);
});

test('parses multiple pairs and orders longest prefix first', () => {
  const pairs = parsePathMap('/mnt/media:/media, /downloads:/sabnzbd-downloads');
  assert.equal(pairs[0][0].length >= pairs[1][0].length, true);
});

test('maps a completed job dir into the client namespace', () => {
  const pairs = parsePathMap('/downloads:/sabnzbd-downloads');
  assert.equal(
    toReported('/downloads/Radiohead - In Rainbows', pairs),
    '/sabnzbd-downloads/Radiohead - In Rainbows',
  );
  assert.equal(toReported('/downloads', pairs), '/sabnzbd-downloads');
});

test('leaves unmapped paths untouched', () => {
  const pairs = parsePathMap('/downloads:/sabnzbd-downloads');
  assert.equal(toReported('/other/place', pairs), '/other/place');
});

test('reportedJoin builds a posix storage path', () => {
  assert.equal(reportedJoin('/sabnzbd-downloads', 'Artist - Album'), '/sabnzbd-downloads/Artist - Album');
});

test('config derives the reported complete dir from the path map', () => {
  const config = loadConfig({
    DOWNLOAD_DIR: '/downloads',
    PATH_MAP: '/downloads:/sabnzbd-downloads',
    API_KEY: 'k',
  });
  assert.equal(config.downloadDir, '/downloads');
  assert.equal(config.reportedCompleteDir, '/sabnzbd-downloads');
  assert.deepEqual(config.pathMap, [['/downloads', '/sabnzbd-downloads']]);
});

test('config honours an explicit REPORTED_COMPLETE_DIR', () => {
  const config = loadConfig({
    DOWNLOAD_DIR: '/downloads',
    PATH_MAP: '/downloads:/sabnzbd-downloads',
    REPORTED_COMPLETE_DIR: '/custom/reported',
  });
  assert.equal(config.reportedCompleteDir, '/custom/reported');
});
