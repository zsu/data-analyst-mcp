#!/usr/bin/env bash
# Download BLS time series with the BLS Public Data API: send the requests built into this script and
# save the replies as response_*.json next to it. (macOS, Linux, Git Bash, WSL; on Windows PowerShell
# use download_bls.ps1.)
#
# Usage:  bash download_bls.sh      (for example: bash ~/Downloads/download_bls.sh)
#
#   - Needs no other file: the requests are inside this script.
#   - When the requests need a BLS registration key (API v2), it uses $BLS_API_KEY when it is set and
#     otherwise asks for the key (hidden input). The key is only sent to api.bls.gov, in the request
#     body on curl's standard input: it is never shown, saved, or put on a command line. With a key
#     set, keyless requests also go through API v2.
#   - Saves response_01.json, response_02.json, ... next to this script, each with the request it
#     answers (without the key), and prints their full paths at the end.
#   - Needs only bash and curl, which macOS and most Linux systems have.
#
# Get a free key at https://data.bls.gov/registrationEngine/ (BLS emails it within minutes).
set -euo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

die() { echo "ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is not installed. Install it (for example: sudo apt install curl) and run this script again."

HERE="$(cd "$(dirname "$0")" && pwd)"

# --------------------------------------------------------------------------- the requests
# manifest.json and query_NN.json are built into this script; they go to a temporary folder that is
# removed when the script ends.
REQ="$(mktemp -d "${TMPDIR:-/tmp}/download_bls.XXXXXX")" || die "Could not create a temporary folder."
trap 'rm -rf "$REQ"' EXIT
# @QUERIES@
MANIFEST="$REQ/manifest.json"
[ -f "$MANIFEST" ] || die "This script has no requests built in. Use the download_bls.sh from the analyst's download files."

# flat FILE: the JSON file on one line (CR and LF removed)
flat() { tr -d '\r\n' < "$1"; }

MAN="$(flat "$MANIFEST")"
json_str() {    # json_str TEXT NAME: the first "NAME": "value" in TEXT
  printf '%s' "$1" | grep -o "\"$2\" *: *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"//; s/"$//' || true
}
API_VERSION="$(json_str "$MAN" api_version)"
URL_V1="$(json_str "$MAN" v1)"
URL_V2="$(json_str "$MAN" v2)"
# "annualaverage": true, "catalog": true  (or nothing)
V2_OPTIONS="$(printf '%s' "$MAN" | grep -o '"v2_options" *: *{[^}]*}' | sed 's/^[^{]*{//; s/}$//; s/^ *//; s/ *$//' || true)"
[ -n "$URL_V1" ] || die "The requests built into this script have no API addresses. Do not edit the script."

QUERIES=()
for q in "$REQ"/query_*.json; do
  [ -f "$q" ] && QUERIES+=("$q")
done
[ ${#QUERIES[@]} -gt 0 ] || die "This script has no requests built in. Use the download_bls.sh from the analyst's download files."

NEED_KEY=0
[ "$API_VERSION" = v2 ] && NEED_KEY=1
for q in "${QUERIES[@]}"; do
  if grep -q '"registrationkey"' "$q"; then NEED_KEY=1; fi
done

# --------------------------------------------------------------------------- API key
KEY="${BLS_API_KEY:-}"
if [ -n "$KEY" ]; then
  echo "Using the BLS key in \$BLS_API_KEY."
elif [ $NEED_KEY -eq 1 ]; then
  echo "These requests need a free BLS registration key (https://data.bls.gov/registrationEngine/)."
  if [ -t 0 ]; then
    printf 'Paste your BLS key (input is hidden), then press Enter: '
    IFS= read -rs KEY || true; echo
  else
    IFS= read -r KEY || true
  fi
fi
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[ $NEED_KEY -eq 0 ] || [ -n "$KEY" ] || die "No key entered. Get one at https://data.bls.gov/registrationEngine/"
case "$KEY" in
  *'"'*|*'\'*) die "The key contains a quote or a backslash; BLS keys are letters and digits only. Check it." ;;
esac

VERSION=v1; URL="$URL_V1"
if [ -n "$KEY" ] && [ -n "$URL_V2" ]; then VERSION=v2; URL="$URL_V2"; fi

# hide TEXT: TEXT with the key removed (BLS repeats a rejected key in its error message)
hide() {
  local t="$1"
  if [ -n "$KEY" ]; then t="${t//"$KEY"/[REDACTED]}"; fi
  printf '%s' "$t" | sed -E 's/([Tt]he [Kk]ey:? *)[0-9A-Fa-f]{20,}/\1[REDACTED]/g'
}

# request FILE: the request body on one line, without any key, with the v2 options when using v2
request() {
  local b
  b="$(flat "$1" | sed -E 's/"registrationkey" *: *"[^"]*" *,? *//; s/, *}$/}/; s/ *$//')"
  if [ "$VERSION" = v2 ] && [ -n "$V2_OPTIONS" ]; then
    b="$(printf '%s' "$b" | sed -E 's/, *"(annualaverage|calculations|catalog|aspects)" *: *(true|false)//g')"
    b="${b%\}}, $V2_OPTIONS}"
  fi
  printf '%s' "$b"
}

# --------------------------------------------------------------------------- send each request
echo "Sending ${#QUERIES[@]} request(s) to BLS API $VERSION ..."
SAVED=(); REFUSED=()
total=${#QUERIES[@]}
n=0
for q in "${QUERIES[@]}"; do
  n=$((n + 1))
  name="$(basename "$q")"
  dest="$HERE/response_${name#query_}"
  req="$(request "$q")"
  send="$req"
  if [ "$VERSION" = v2 ]; then send="${req%\}}, \"registrationkey\": \"$KEY\"}"; fi   # in memory only

  tries=0
  while :; do
    tries=$((tries + 1))
    set +e
    # printf is a shell builtin: the body (and the key in it) reaches curl on stdin, not on a command line
    out="$(printf '%s' "$send" | curl -sS -X POST -H 'Content-Type: application/json' -A 'data-analyst/1.0' \
             --max-time 120 --data-binary @- -w '\n%{http_code}' "$URL" 2>&1)"
    rc=$?
    set -e
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [ $rc -eq 0 ]; then
      case "$code" in 5??|429) ;; *) break ;; esac
    fi
    if [ $tries -ge 4 ]; then
      [ $rc -eq 0 ] && die "BLS replied with HTTP $code for $name. Run this script again later; if it happens again, tell the analyst."
      die "$name: the request to api.bls.gov failed ($(hide "$body")). Check the internet connection, VPN and proxy, then run this script again."
    fi
    sleep $((tries * 5))
  done
  send=""

  body="$(printf '%s' "$body" | sed -e 's/[[:space:]]*$//')"
  status="$(json_str "$body" status)"
  case "$body" in
    *'}') ;;
    *) die "$name: BLS did not answer with JSON (HTTP $code). The reply began: $(hide "${body:0:200}")" ;;
  esac
  [ -n "$status" ] || die "$name: BLS did not answer with JSON (HTTP $code). The reply began: $(hide "${body:0:200}")"

  # Keep the reply exactly as BLS sent it and add the request it answers, like download_bls.ps1.
  hide "${body%\}}"$',\n "_request": '"$req"$'\n}\n' > "$dest.part"
  mv -f "$dest.part" "$dest"
  SAVED+=("$dest")
  msg="$(printf '%s' "$body" | grep -o '"message" *: *\[[^]]*\]' | head -n 1 | sed 's/^[^[]*\[//; s/\]$//' || true)"
  msg="$(hide "$msg")"
  echo "[$n/$total] $(basename "$dest") $status ${msg:0:200}"
  [ "$status" = REQUEST_SUCCEEDED ] || REFUSED+=("$(basename "$dest") ($status)")
  if [ $n -lt $total ]; then sleep 0.5; fi
done
KEY=""

echo
if [ ${#REFUSED[@]} -gt 0 ]; then
  echo "BLS refused some requests (the message above says why, often the daily limit or the key)."
  echo "Upload those files anyway:"
  for w in "${REFUSED[@]}"; do echo "  $w"; done
  echo
fi
echo "Done. Upload these files to the chat (do not edit them):"
for f in "${SAVED[@]}"; do echo "  $f"; done
