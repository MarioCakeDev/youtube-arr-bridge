# youtube-arr-bridge

A standalone **YouTube → *arr bridge** for the homelab: it presents itself to a
music request/library app as **two** protocol surfaces at once —

- a **Newznab indexer** (`GET /api?t=...`), and
- a **SABnzbd download client** (`GET/POST /api?mode=...`),

and behind them resolves albums on **YouTube Music** and downloads the tracks
with **yt-dlp** + **ffmpeg** as tagged audio with embedded cover art.

It has **no Lidarr dependency** and no database. The indexer is keyed by
`artist`/`album` search (not a Lidarr wanted-cache or album id). It was built for
[DroppedNeedle](https://github.com/DroppedNeedle/DroppedNeedle) but speaks enough
of both protocols to also work as a Generic Newznab indexer + SABnzbd client in
Lidarr, Prowlarr, etc.

```
DroppedNeedle
  ├─ Newznab indexer search  ──►  GET /api?t=music&artist=..&album=..
  │                               (one synthetic release:
  │                                "Artist - Album (Year) WEB MP3 320")
  ├─ fetch enclosure NZB     ──►  GET /api/newznab/get?artist=..&album=..
  └─ SABnzbd addfile/addurl  ──►  POST/GET /api?mode=addfile|addurl
                                   └─ yt-dlp album download + tagging
                                      into the downloads directory
  ◄─ SABnzbd history (Completed + mapped `storage`)
  ◄─ DroppedNeedle imports the files
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api?t=caps` | Newznab capabilities (categories 3000/3010/3040, `q,artist,album,year`) |
| `GET` | `/api?t=search\|music\|audio\|album` | Newznab search → one RSS item per requested album |
| `GET` | `/api/newznab/get?artist=&album=&year=&apikey=` | Grab URL → minimal NZB carrying the grab spec |
| `GET/POST` | `/api?mode=version\|get_config\|get_cats\|fullstatus\|queue\|history\|addurl\|addfile` | SABnzbd client |
| `GET/POST` | `/api?mode=queue\|history&name=delete&value=` | Remove queue/history entries |
| `GET/POST` | `/api?mode=pause\|resume` | Pause/resume the queue |
| `GET` | `/health` | Healthcheck |

`/api/newznab/api` and `/api/sabnzbd/api` are accepted as aliases of `/api` for
each half.

**Auth:** a single `apikey` query parameter (or POST field), checked in constant
time. `t=caps` and `mode=version` are answered without a key so client "Test"
buttons work.

## Path contract (important)

The completed-downloads directory inside this container is `DOWNLOAD_DIR`
(default `/downloads`). The **same host directory must be mounted by
DroppedNeedle at `/sabnzbd-downloads`**, and this service reports paths in that
namespace via `PATH_MAP`.

Defaults:

| Setting | Value |
|---|---|
| Container download dir | `/downloads` |
| Host dir (example) | `/mnt/media/downloads` |
| DroppedNeedle mount | `/sabnzbd-downloads` |
| `PATH_MAP` | `/downloads:/sabnzbd-downloads` |
| `REPORTED_COMPLETE_DIR` (advertised as `complete_dir`, and what `storage` starts with) | `/sabnzbd-downloads` |

So a finished job is reported as
`storage = /sabnzbd-downloads/<Artist> - <Album>`. DroppedNeedle strips the
advertised `complete_dir` prefix and resolves the remainder under its own mount,
then imports the audio files. Set `PATH_MAP`/`REPORTED_COMPLETE_DIR` if your
mounts differ — but the reported root and DroppedNeedle's mount must line up.

> Files must be readable by DroppedNeedle and the container runs as the
> non-root `node` user (uid/gid 1000). Make the host downloads directory
> writable by uid 1000 (or deploy with a matching user).

## Configuration (environment only)

No secrets are committed; everything is read from the environment.

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | _(empty)_ | **Required.** Shared key for both protocol halves. |
| `PORT` | `8484` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `DOWNLOAD_DIR` | `/downloads` | Completed-downloads root (container path). |
| `INCOMPLETE_DIR` | `/incomplete` | yt-dlp scratch space. |
| `STATE_DIR` | `/data` | Job-history persistence (`jobs.json`). |
| `PATH_MAP` | `/downloads:/sabnzbd-downloads` | `internal:external` prefix map(s), comma separated. |
| `REPORTED_COMPLETE_DIR` | derived from `PATH_MAP` | Root reported to the client. |
| `AUDIO_FORMAT` | `mp3` | `mp3`, `flac`, `opus`, `m4a`. |
| `AUDIO_BITRATE` | `320` | MP3 bitrate (`128`/`192`/`256`/`320`). |
| `AUDIO_QUALITY` | _(empty)_ | Raw yt-dlp `--audio-quality` override. |
| `CATEGORY` | `music` | SABnzbd category advertised/accepted. |
| `CONCURRENCY` | `1` | Albums downloaded in parallel. |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp binary. |
| `FFMPEG_PATH` | _(PATH lookup)_ | ffmpeg binary or directory; only set if not on `PATH`. |
| `YT_JS_RUNTIME` | `node` | JS runtime yt-dlp uses for the EJS challenge solver. |
| `COOKIES_FILE` | _(empty)_ | Netscape cookies file for age/region-locked content. |
| `YT_COOKIES_FROM_BROWSER` | _(empty)_ | e.g. `firefox` or `chrome`. |
| `YT_SEARCH_RESULTS` | `5` | Results for the yt-dlp fallback search. |
| `SEARCH_CONFIRM` | `true` | Resolve the album on YouTube Music during indexer search. |
| `SEARCH_TIMEOUT_MS` | `8000` | Per-request resolver timeout. |
| `DOWNLOAD_TIMEOUT_MS` | `2700000` | Per-album download timeout (45 min). |
| `TAG_METADATA` | `true` | Run the ffmpeg tag pass after yt-dlp. |
| `HISTORY_LIMIT` | `200` | Retained terminal jobs. |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug`. |
| `PUBLIC_BASE_URL` | _(derived from Host)_ | Base URL used in enclosure links. |

## Add it to DroppedNeedle

1. **Indexer → Add → Generic Newznab**
   - URL: `http://<bridge-host>:8484/api`
   - API key: your `API_KEY`
   - Categories: Audio (`3000`, incl. `3010`/`3040`)
   - Test: the caps request returns the advertised categories.

2. **Download client → Add → SABnzbd**
   - URL: `http://<bridge-host>:8484` (host only; the client appends `/api`)
   - API key: the same `API_KEY`
   - Category: `music` (matches `CATEGORY`)
   - Downloads mount: the host dir that is `DOWNLOAD_DIR` here.

3. Grab an album. The indexer returns a release such as
   `Radiohead - In Rainbows (2007) WEB MP3 320`; the grab is handed to
   `addfile`; when yt-dlp finishes, history shows `Completed` with
   `storage = /sabnzbd-downloads/Radiohead - In Rainbows`, and DroppedNeedle
   imports the tagged files.

## Deploy (Coolify worker, Debian + Docker)

The image is a standard `node:22-bookworm-slim` base and ships `yt-dlp` and
`ffmpeg`; it runs as the non-root `node` user and exposes `8484`.

- **Build:** Coolify builds `Dockerfile` from this repo. For the multi-arch
  `yt-dlp` binary the build relies on the Docker `TARGETARCH` build arg
  (`amd64`→`yt-dlp_linux`, `arm64`→`yt-dlp_linux_aarch64`).
- **Image reference:** `ghcr.io/mariocakedev/youtube-arr-bridge:latest`
  (or the Coolify-built image for the deployed commit).
- **Port:** `8484`.
- **Volumes:** mount the downloads host dir at `/downloads` and a small state
  dir at `/data`.
- **Healthcheck:** `GET /health` (baked into the image).
- **Required env:** `API_KEY`, and `DOWNLOAD_DIR`/`PATH_MAP`/
  `REPORTED_COMPLETE_DIR` if not using the defaults.

`docker-compose.example.yml` is a runnable reference. Note that only
`infra` deploys to the shared worker; use the reference above for the Coolify
resource and hand off the deploy.

## Local development

```bash
npm test          # node:test, zero dependencies
PORT=8484 API_KEY=devkey DOWNLOAD_DIR=$PWD/downloads \
  INCOMPLETE_DIR=$PWD/incomplete STATE_DIR=$PWD/state \
  node src/index.js
```

Against a running instance:

```bash
./scripts/smoke.sh http://localhost:8484 "$API_KEY"
```

## How a grab is built

1. **Search.** `t=music`/`t=search` is split into `artist`/`album`. The service
   asks YouTube Music (InnerTube) for the best album match; the release title is
   synthesised as `Artist - Album (Year) <SOURCE> <CODEC> <BITRATE>`, which the
   Newznab quality parsers in DroppedNeedle/Lidarr understand. `WEB FLAC` maps
   to category `3040`, everything else to `3010`.
2. **Grab.** The enclosure URL is this service's `t=get`, which serves a minimal
   NZB whose `<meta>` tags carry `artist`/`album`/`year`, plus the resolved
   YouTube Music playlist URL when known.
3. **Download.** `addfile` (or `addurl`) parses the NZB and queues a job. yt-dlp
   downloads the album playlist (falling back to per-track video ids, then to a
   `ytsearch` query), embeds the thumbnail and writes the format; an ffmpeg pass
   then stamps accurate `artist`/`album`/`album_artist`/`date`/`track`/`title`.
4. **Report.** `queue` shows in-progress jobs (`nzo_id`, `filename`, `cat`,
   `status`, `mb`, `mbleft`, `percentage`); `history` shows terminal jobs with
   `status` `Completed`/`Failed` and the mapped `storage` directory.

## Tests

`npm test` runs `node:test` with no external dependencies: release-name
encoder/decoder round-trips, path mapping, both protocol halves, the yt-dlp
argument builder, the YouTube Music resolver (with an injected fetch), and a
full in-process round-trip (indexer search → NZB → `addfile` → download →
`Completed` history with the mapped `storage`).

## Limitations

- YouTube is not a lossless source; `AUDIO_FORMAT=flac` transcodes to FLAC and
  the release is advertised as lossless/family `3040`. Prefer MP3/Opus unless
  you specifically want FLAC containers.
- Album matching depends on YouTube Music having the release; no match falls
  back to a free-text `ytsearch` download.
- Age/region-restricted content may require `COOKIES_FILE`.
