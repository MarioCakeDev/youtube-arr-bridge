# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ARG TARGETARCH

# ffmpeg is used for audio conversion, thumbnail embedding and the tag pass.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Self-contained yt-dlp binary (no Python runtime needed).
RUN case "${TARGETARCH}" in \
      arm64) YTDLP=yt-dlp_linux_aarch64 ;; \
      *)     YTDLP=yt-dlp_linux ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP}" \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /downloads /incomplete /data \
 && chown -R node:node /app /downloads /incomplete /data

ENV NODE_ENV=production \
    PORT=8484 \
    DOWNLOAD_DIR=/downloads \
    INCOMPLETE_DIR=/incomplete \
    STATE_DIR=/data \
    REPORTED_COMPLETE_DIR=/sabnzbd-downloads \
    PATH_MAP=/downloads:/sabnzbd-downloads \
    AUDIO_FORMAT=mp3 \
    AUDIO_BITRATE=320 \
    YT_JS_RUNTIME=node \
    CATEGORY=music

USER node
EXPOSE 8484

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
