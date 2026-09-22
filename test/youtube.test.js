import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlbum } from '../src/youtube.js';

function searchJson() {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicShelfRenderer: {
                        contents: [
                          {
                            musicResponsiveListItemRenderer: {
                              flexColumns: [
                                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'In Rainbows' }] } } },
                              ],
                              navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_TEST' } },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

function browseJson() {
  const row = (videoId, title) => ({
    musicResponsiveListItemRenderer: {
      flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } }],
      overlay: {
        musicItemThumbnailOverlayRenderer: {
          content: {
            musicPlayButtonRenderer: {
              playNavigationEndpoint: { watchEndpoint: { videoId, playlistId: 'OLAK5uy_ALBUM' } },
            },
          },
        },
      },
    },
  });
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicResponsiveHeaderRenderer: {
                        title: { runs: [{ text: 'In Rainbows' }] },
                        straplineTextOne: { runs: [{ text: 'Radiohead' }] },
                        subtitle: {
                          runs: [{ text: 'Album' }, { text: ' • ' }, { text: '2007' }],
                        },
                        thumbnail: {
                          musicThumbnailRenderer: {
                            thumbnail: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/abc' }] },
                          },
                        },
                      },
                    },
                    {
                      musicShelfRenderer: {
                        contents: [row('v1', '15 Step'), row('v2', 'Bodysnatchers')],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

test('resolves an album via YouTube Music search + browse', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const isSearch = url.includes('/search');
    return { ok: true, json: async () => (isSearch ? searchJson() : browseJson()) };
  };
  const result = await resolveAlbum({ artist: 'Radiohead', album: 'In Rainbows', year: '2007' }, { fetchImpl });
  assert.equal(result.source, 'ytmusic');
  assert.equal(result.playlistUrl, 'https://music.youtube.com/playlist?list=OLAK5uy_ALBUM');
  assert.equal(result.trackCount, 2);
  assert.equal(result.title, 'In Rainbows');
  assert.equal(result.artist, 'Radiohead');
  assert.equal(result.year, '2007');
  assert.equal(result.thumbnail, 'https://lh3.googleusercontent.com/abc');
  assert.equal(calls.length, 2);
});

test('reads the album artist from the header strapline', async () => {
  const fetchImpl = async (url) => {
    const isSearch = url.includes('/search');
    return { ok: true, json: async () => (isSearch ? searchJson() : browseJson()) };
  };
  const result = await resolveAlbum({ album: 'In Rainbows', year: '2007' }, { fetchImpl });
  assert.equal(result.artist, 'Radiohead');
  assert.equal(result.year, '2007');
});

test('falls back to a ytsearch query when YouTube Music fails', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await resolveAlbum({ artist: 'Radiohead', album: 'In Rainbows' }, { fetchImpl });
  assert.equal(result.source, 'ytsearch');
  assert.equal(result.query, 'Radiohead In Rainbows');
});

test('falls back when the album has no tracks', async () => {
  const fetchImpl = async (url) => {
    const isSearch = url.includes('/search');
    return { ok: true, json: async () => (isSearch ? searchJson() : { contents: {} }) };
  };
  const result = await resolveAlbum({ artist: 'Radiohead', album: 'In Rainbows' }, { fetchImpl });
  assert.equal(result.source, 'ytsearch');
});
