#!/usr/bin/env bash
# Smoke-check a running youtube-arr-bridge instance.
#
#   ./scripts/smoke.sh http://localhost:8484 "$API_KEY"
#
# Verifies both protocol halves: Newznab caps/search/grab and the SABnzbd
# version/get_config/history surface.
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url> <api-key>}"
KEY="${2:?usage: smoke.sh <base-url> <api-key>}"

say() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

say 'health'
curl -fsS "$BASE/health" | grep -q '"status":"ok"' || fail 'health endpoint'

say 'newznab caps'
curl -fsS "$BASE/api?t=caps" | grep -q '<category id="3000"' || fail 'caps'

say 'newznab search'
XML="$(curl -fsS "$BASE/api?t=music&artist=Radiohead&album=In%20Rainbows&year=2007&apikey=$KEY")"
echo "$XML" | grep -q 'application/x-nzb' || fail 'search enclosure'
ENCLOSURE="$(printf '%s' "$XML" | sed -n 's/.*<enclosure url="\([^"]*\)".*/\1/p' | head -1 | sed 's/&amp;/\&/g')"
[ -n "$ENCLOSURE" ] || fail 'no enclosure url'

say 'newznab grab (NZB)'
curl -fsS "$ENCLOSURE" | grep -q '<nzb ' || fail 'nzb body'

say 'sabnzbd version'
curl -fsS "$BASE/api?mode=version&output=json&apikey=$KEY" | grep -q '"version"' || fail 'sab version'

say 'sabnzbd get_config'
curl -fsS "$BASE/api?mode=get_config&output=json&apikey=$KEY" | grep -q 'complete_dir' || fail 'sab config'

say 'sabnzbd history'
curl -fsS "$BASE/api?mode=history&output=json&apikey=$KEY" | grep -q '"history"' || fail 'sab history'

printf '\nAll smoke checks passed.\n'
