#!/usr/bin/env bash
# Download an IPUMS extract with the IPUMS API: submit it, wait for it, and download the data file
# and the codebook. (macOS, Linux, Git Bash, WSL; on Windows PowerShell use download_ipums.ps1.)
#
# Usage:  bash download_ipums.sh [EXTRACT_NUMBER | --new]
#
#   - Asks for your IPUMS API key (hidden input), or uses $IPUMS_API_KEY when it is set.
#     The key is never shown, saved, or put on a command line.
#   - Submits the extract defined in this file, waits until IPUMS has built it
#     (minutes for CPS, NHIS or MEPS, up to about 30 minutes for multi-year ACS), and downloads
#     the data file (.csv.gz) and the DDI codebook (.xml) into the folder that holds this script.
#   - Run it again after an interruption: it continues with the same extract instead of submitting
#     a new one. EXTRACT_NUMBER overrides that number; --new submits a new extract.
#   - Needs only curl, which macOS and most Linux systems have.
#
# Get a key at https://account.ipums.org/api_keys (the account must be registered for @COLLECTION_UPPER@).
set -euo pipefail

COLLECTION="@COLLECTION@"
BAKED_NUMBER="@NUMBER@"
SPEC_ID="@SPEC_ID@"                             # names the saved-number file, so another extract's file is ignored
API="${IPUMS_API_BASE:-https://api.ipums.org}"
API="${API%/}"
POLL_SECONDS=15
MAX_WAIT=14400                                  # 4 hours

# The extract definition (the request body for the IPUMS API). Do not edit it by hand.
write_spec() {
cat <<'IPUMS_EXTRACT_SPEC'
@SPEC_JSON@
IPUMS_EXTRACT_SPEC
}

NEW=0
case "${1:-}" in
  -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --new) NEW=1; shift ;;
esac

die() { echo "ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is not installed. Install it (for example: sudo apt install curl) and run this script again."

HERE="$(cd "$(dirname "$0")" && pwd)"
NUMBER_FILE="$HERE/extract_number_${COLLECTION}_${SPEC_ID}.txt"
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/ipums_spec.XXXXXX")"
trap 'rm -f "$BODY_FILE"' EXIT
write_spec > "$BODY_FILE"

# --------------------------------------------------------------------------- API key
KEY="${IPUMS_API_KEY:-}"
if [ -n "$KEY" ]; then
  echo "Using the IPUMS API key in \$IPUMS_API_KEY."
elif [ -t 0 ]; then
  printf 'Paste your IPUMS API key (input is hidden), then press Enter: '
  IFS= read -rs KEY; echo
else
  IFS= read -r KEY || true
fi
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[ -n "$KEY" ] || die "No key entered. Get one at https://account.ipums.org/api_keys"
KEY="${KEY//\\/\\\\}"; KEY="${KEY//\"/\\\"}"    # escape for the curl config line

# The key reaches curl as a config file on stdin (-K -), never as a command-line argument.
auth_config() { printf 'header = "Authorization: %s"\n' "$KEY"; }

# --------------------------------------------------------------------------- HTTP helpers
# api METHOD URL [curl args...]: sets BODY and CODE. Retries network errors, 429 and 5xx.
api() {
  local method="$1" url="$2" tries=0 out rc
  shift 2
  while :; do
    tries=$((tries + 1))
    set +e
    out="$(auth_config | curl -sS -K - -X "$method" -w '\n%{http_code}' "$@" "$url")"
    rc=$?
    set -e
    if [ $rc -eq 0 ]; then
      CODE="${out##*$'\n'}"
      BODY="${out%$'\n'*}"
      case "$CODE" in 429|5??) ;; *) return 0 ;; esac
    fi
    if [ $tries -ge 5 ]; then
      [ $rc -eq 0 ] && return 0
      die "Could not reach IPUMS ($API). Check the internet connection, VPN and proxy, then run this script again."
    fi
    sleep $((tries * 10))
  done
}

# check_http WHAT: stop with a clear message unless the last reply was 2xx.
check_http() {
  case "$CODE" in
    2??) ;;
    401|403) die "IPUMS rejected the API key (HTTP $CODE). Check the key, and that your account is registered for $(printf '%s' "$COLLECTION" | tr '[:lower:]' '[:upper:]') at https://account.ipums.org/api_keys" ;;
    404) die "IPUMS has no $COLLECTION extract number $NUMBER for this account. Check the number; to submit a new extract instead, run: bash \"$0\" --new" ;;
    *) echo "IPUMS replied (HTTP $CODE):" >&2
       printf '%s\n' "$BODY" >&2
       die "$1 failed. Send the reply above to the analyst. Do not change the extract by hand." ;;
  esac
}

# --------------------------------------------------------------------------- JSON helpers (no jq needed)
flat() { printf '%s' "$1" | tr -d '\r\n' | sed 's#\\/#/#g'; }
json_number() { flat "$1" | grep -o '"number" *: *[0-9][0-9]*' | head -n 1 | grep -o '[0-9][0-9]*$' || true; }
json_status() { flat "$1" | grep -o '"status" *: *"[a-z_]*"' | head -n 1 | sed 's/.*"\([a-z_]*\)"$/\1/' || true; }
# json_link JSON OBJECT FIELD: FIELD ("url" or "sha256") of downloadLinks.OBJECT
json_link() { flat "$1" | sed -n "s/.*\"$2\" *: *{[^}]*\"$3\" *: *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }

# --------------------------------------------------------------------------- 1. submit (or reuse a number)
NUMBER="${1:-}"
if [ "$NEW" = 0 ]; then
  if [ -z "$NUMBER" ] && [ -s "$NUMBER_FILE" ]; then
    NUMBER="$(tr -cd '0-9' < "$NUMBER_FILE")"
    [ -n "$NUMBER" ] && echo "Continuing with extract $NUMBER (saved in $NUMBER_FILE by an earlier run)."
  fi
  [ -n "$NUMBER" ] || NUMBER="$BAKED_NUMBER"
fi
if [ -n "$NUMBER" ]; then
  case "$NUMBER" in *[!0-9]*) die "The extract number must be a whole number, not '$NUMBER'." ;; esac
  echo "Using $COLLECTION extract $NUMBER (already submitted)."
else
  [ -s "$BODY_FILE" ] || die "The extract definition is missing from this script."
  cp "$BODY_FILE" "$HERE/extract_spec.json" 2>/dev/null || true   # for the curl steps: always this extract's definition
  echo "Submitting the extract to IPUMS ($COLLECTION)..."
  api POST "$API/extracts?collection=$COLLECTION&version=2" \
      -H "Content-Type: application/json" --data-binary "@$BODY_FILE"
  check_http "Submitting the extract"
  NUMBER="$(json_number "$BODY")"
  [ -n "$NUMBER" ] || { printf '%s\n' "$BODY" >&2; die "IPUMS accepted the request but sent no extract number."; }
  printf '%s\n' "$NUMBER" > "$NUMBER_FILE" 2>/dev/null || true
  echo "Submitted: $COLLECTION extract $NUMBER."
fi

# --------------------------------------------------------------------------- 2. wait until it is built
echo "Waiting for IPUMS to build the extract (checked every $POLL_SECONDS seconds; Ctrl+C is safe, run again to continue)."
START=$(date +%s)
while :; do
  api GET "$API/extracts/$NUMBER?collection=$COLLECTION&version=2"
  check_http "Checking the extract status"
  STATUS="$(json_status "$BODY")"
  ELAPSED=$(( $(date +%s) - START ))
  case "$STATUS" in
    completed) printf '\r  status: %-10s (%d min %02d s)\n' "$STATUS" $((ELAPSED / 60)) $((ELAPSED % 60)); break ;;
    failed|canceled)
      echo
      echo "IPUMS replied:" >&2
      printf '%s\n' "$BODY" >&2
      die "The extract $STATUS. Send the reply above to the analyst. Do not resubmit or change it by hand." ;;
  esac
  printf '\r  status: %-10s (%d min %02d s)' "${STATUS:-unknown}" $((ELAPSED / 60)) $((ELAPSED % 60))
  [ "$ELAPSED" -lt "$MAX_WAIT" ] || { echo; die "Still not ready after $((MAX_WAIT / 3600)) hours. Run this script again later: it continues with extract $NUMBER."; }
  sleep "$POLL_SECONDS"
done

# --------------------------------------------------------------------------- 3. download the two files
DATA_URL="$(json_link "$BODY" data url)"
DDI_URL="$(json_link "$BODY" ddiCodebook url)"
if [ -z "$DATA_URL" ] || [ -z "$DDI_URL" ]; then
  die "Extract $NUMBER is complete but has no download links: IPUMS deletes extract files after about 72 hours. To submit a new extract, run: bash \"$0\" --new"
fi
DATA_SHA="$(json_link "$BODY" data sha256)"

# download URL: saves under the name IPUMS gave the file; prints the path
download() {
  local url="$1" name dest progress=-sS
  name="${url%%\?*}"; name="${name##*/}"
  dest="$HERE/$name"
  [ -t 2 ] && progress=-#
  echo "Downloading $name ..." >&2
  auth_config | curl "$progress" -fL -K - -o "$dest" "$url" \
    || die "The download of $name failed. Run this script again (it reuses extract $NUMBER)."
  printf '%s' "$dest"
}

DATA_FILE="$(download "$DATA_URL")"
DDI_FILE="$(download "$DDI_URL")"

if [ -n "$DATA_SHA" ]; then
  SUM=""
  if command -v sha256sum >/dev/null 2>&1; then SUM="$(sha256sum "$DATA_FILE" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then SUM="$(shasum -a 256 "$DATA_FILE" | cut -d' ' -f1)"; fi
  if [ -n "$SUM" ]; then
    [ "$SUM" = "$DATA_SHA" ] || die "The data file is damaged (checksum mismatch). Delete it and run this script again."
    echo "Checksum OK."
  fi
fi

echo
echo "Done. Upload these two files to the chat (do not unzip or edit them):"
echo "  $DATA_FILE"
echo "  $DDI_FILE"
