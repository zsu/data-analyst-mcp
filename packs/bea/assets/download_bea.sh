#!/usr/bin/env bash
# Download the BEA data for one analysis: BEA's public files and the BEA Data API replies.
# (macOS, Linux, Git Bash, WSL; on Windows PowerShell use download_bea.ps1.)
#
# Usage:  bash download_bea.sh
#
#   - Downloads every file listed at the bottom of this file into the folder that holds this script.
#   - When some files come from the API, it asks for your BEA API key (hidden input), or uses
#     $BEA_API_KEY when it is set. The key is never shown, saved, or put on a command line, and it is
#     removed from each API reply before the reply is saved (BEA repeats the key in every reply).
#   - Run it again after an interruption: files already downloaded are skipped.
#   - Needs only curl, which macOS and most Linux systems have.
#
# Get a free key at https://apps.bea.gov/API/signup/ (BEA emails it; click the activation link first).
set -euo pipefail

PAUSE_SECONDS=1                                 # between API calls: BEA allows 100 a minute per key

# The files to download, one per line: "bulk NAME URL" (public, no key) or "api NAME URL" (the key is
# added when the script runs). Do not edit them by hand.
file_list() {
cat <<'BEA_FILES'
@FILES@
BEA_FILES
}

case "${1:-}" in
  -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

die() { echo "ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is not installed. Install it (for example: sudo apt install curl) and run this script again."

HERE="$(cd "$(dirname "$0")" && pwd)"
KINDS=(); NAMES=(); URLS=()
NEED_KEY=0
while read -r kind name url; do
  [ -n "${kind:-}" ] || continue
  KINDS+=("$kind"); NAMES+=("$name"); URLS+=("$url")
  [ "$kind" = api ] && NEED_KEY=1
done < <(file_list)
[ ${#NAMES[@]} -gt 0 ] || die "The file list is missing from this script."

# --------------------------------------------------------------------------- API key (only when needed)
KEY=""
if [ $NEED_KEY -eq 1 ]; then
  KEY="${BEA_API_KEY:-}"
  if [ -n "$KEY" ]; then
    echo "Using the BEA API key in \$BEA_API_KEY."
  elif [ -t 0 ]; then
    printf 'Paste your BEA API key (input is hidden), then press Enter: '
    IFS= read -rs KEY; echo
  else
    IFS= read -r KEY || true
  fi
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  [ -n "$KEY" ] || die "No key entered. Get one at https://apps.bea.gov/API/signup/"
fi

# The key goes into the URL (BEA's design), but the URL reaches curl as a config file on stdin
# (-K -), never as a command-line argument.
url_config() {
  local u="$1"
  u="${u//\\/\\\\}"; u="${u//\"/\\\"}"
  printf 'url = "%s"\n' "$u"
}

# redact TEXT: the reply with the key removed (the key itself, any 36-character key, and the echoed USERID)
GUID='[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
redact() {
  local t="$1"
  [ -n "$KEY" ] && t="${t//"$KEY"/[REDACTED]}"
  printf '%s' "$t" | sed -E -e "s/$GUID/[REDACTED]/g" \
    -e 's/("ParameterName" *: *"[Uu][Ss][Ee][Rr][Ii][Dd]" *, *"ParameterValue" *: *")[^"]*/\1[REDACTED]/g'
}

api_error() {   # api_error TEXT: BEA's APIErrorCode, or nothing
  printf '%s' "$1" | tr -d '\r\n' | grep -o '"APIErrorCode" *: *"\{0,1\}[0-9]*' | head -n 1 | grep -o '[0-9]*$' || true
}

# --------------------------------------------------------------------------- downloads
SAVED=(); WARN=()
progress=-sS
[ -t 2 ] && progress=-#
total=${#NAMES[@]}
for i in "${!NAMES[@]}"; do
  kind="${KINDS[$i]}"; name="${NAMES[$i]}"; url="${URLS[$i]}"; dest="$HERE/$name"
  n=$((i + 1))
  if [ -s "$dest" ] && ! grep -q '"APIErrorCode"' "$dest" 2>/dev/null; then
    echo "[$n/$total] $name: already downloaded, skipped."
    SAVED+=("$dest"); continue
  fi

  if [ "$kind" = bulk ]; then
    echo "[$n/$total] Downloading $name (public file, no key) ..."
    curl "$progress" -fL --retry 3 -o "$dest.part" "$url" \
      || { rm -f "$dest.part"; die "The download of $name failed. Check the connection and run this script again (finished files are kept)."; }
    mv -f "$dest.part" "$dest"
    SAVED+=("$dest"); continue
  fi

  echo "[$n/$total] Requesting $name from the BEA API ..."
  tries=0
  while :; do
    tries=$((tries + 1))
    set +e
    out="$(url_config "$url&UserID=$KEY" | curl -sS -K - -w '\n%{http_code}')"
    rc=$?
    set -e
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [ $rc -eq 0 ]; then
      case "$code" in 5??) ;; *) break ;; esac
    fi
    [ $tries -lt 4 ] || die "Could not reach BEA (apps.bea.gov). Check the internet connection, VPN and proxy, then run this script again (finished files are kept)."
    sleep $((tries * 10))
  done
  if [ "$code" = 429 ]; then
    die "BEA has blocked the key for about an hour (HTTP 429: too many requests). Wait an hour, then run this script again; it continues where it stopped. Retrying sooner makes the block longer."
  fi
  err="$(api_error "$body")"
  case "$err" in
    1|3|4) die "BEA rejected the API key (error $err). Check that it is typed correctly and that you clicked the activation link in BEA's email: https://apps.bea.gov/API/signup/" ;;
  esac
  case "$code" in
    2??) ;;
    *) [ -n "$err" ] || die "BEA replied with HTTP $code for $name. Run this script again later; if it happens again, tell the analyst." ;;
  esac
  redact "$body" > "$dest.part"
  mv -f "$dest.part" "$dest"
  [ -n "$err" ] && WARN+=("$name (BEA error $err)")
  SAVED+=("$dest")
  sleep "$PAUSE_SECONDS"
done
KEY=""

echo
if [ ${#WARN[@]} -gt 0 ]; then
  echo "BEA answered some requests with an error. Upload those files anyway; the analyst will fix the request:"
  for w in "${WARN[@]}"; do echo "  $w"; done
  echo
fi
echo "Done. Upload these files to the chat (do not unzip or edit them):"
for f in "${SAVED[@]}"; do echo "  $f"; done
