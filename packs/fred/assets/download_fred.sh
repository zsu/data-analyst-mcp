#!/usr/bin/env bash
# Download the FRED files for one data-analyst request into the folder that holds this script.
# Needs only bash and curl. Run:  bash download_fred.sh
#
# Files marked key, bearer or group come from the FRED API and need your own free FRED API key
# (https://fredaccount.stlouisfed.org/apikeys). The script uses FRED_API_KEY when it is set,
# otherwise asks for it with hidden input; press Enter to skip those files. The key reaches curl
# on stdin (curl -K -), never on a command line, and is never written into the saved files.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

# file <TAB> kind <TAB> pages <TAB> url <TAB> then_file <TAB> then_url   ("-" = empty, pages 0 = unpaged)
# kind: plain (no key), key (key in the query), bearer (FRED API v2, key in a header, paged),
# group (GeoFRED series group; its fields fill the __GROUP_*__ placeholders of then_url)
manifest="$(cat <<'MANIFEST_END'
@MANIFEST@
MANIFEST_END
)"

key="${FRED_API_KEY:-}"
if [ -z "$key" ] && printf '%s\n' "$manifest" | cut -f2 | grep -qv '^plain$'; then
  echo "Some files need a FRED API key (https://fredaccount.stlouisfed.org/apikeys). Press Enter to skip them."
  if [ -t 0 ]; then
    printf 'FRED API key (hidden): '; IFS= read -rs key; echo
  else
    IFS= read -r key || true
  fi
fi
key="$(printf '%s' "$key" | tr -d '[:space:]')"

tmp="$(mktemp "${TMPDIR:-/tmp}/fred.XXXXXX")" || exit 1
trap 'rm -f "$tmp"' EXIT
saved=()

urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# json_str FILE NAME: the last string or number value of "NAME" in FILE
json_str() {
  grep -oE "\"$2\" *: *(\"[^\"]*\"|[-0-9.]+)" "$1" | tail -n 1 | sed -E 's/^[^:]*: *"?//; s/"$//'
}

# keyed_get URL BEARER: download URL into $tmp with the key from stdin config; prints the HTTP status
keyed_get() {
  if [ "$2" = "1" ]; then
    printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' "$1" "$key"
  else
    printf 'url = "%s"\n' "${1/__FRED_KEY__/$key}"
  fi | curl -sS -K - -A data-analyst/1.0 -o "$tmp" -w '%{http_code}'
}

# save_keyed FILE URL BEARER: download, wrap with the request URL (placeholder, not the key), save
save_keyed() {
  local code msg
  code="$(keyed_get "$2" "$3")" || { echo "$1: could not reach FRED; check the connection, then run again."; return 1; }
  if [ "$code" != "200" ]; then
    msg="$(head -c 200 "$tmp" | tr -d '\r\n')"
    echo "$1: HTTP $code ${msg//"$key"/[KEY]}"
    return 1
  fi
  { printf '{"request": "%s", "response": ' "$2"; cat "$tmp"; printf '}\n'; } > "$here/$1"
  saved+=("$here/$1")
  echo "saved $1"
}

while IFS=$'\t' read -r file kind pages url tfile turl; do
  [ -n "$file" ] || continue
  if [ "$kind" = "plain" ]; then
    curl -sS -f -A data-analyst/1.0 -o "$here/$file" "$url" || { echo "$file: download failed"; continue; }
    saved+=("$here/$file")
    echo "saved $file"
    sleep 0.6
    continue
  fi
  if [ -z "$key" ]; then echo "skipped (needs a key): $file"; continue; fi
  case "$kind" in
    key)
      save_keyed "$file" "$url" 0
      ;;
    bearer)                       # FRED API v2 release/observations: follow next_cursor up to pages
      n=1; u="$url"; f="$file"
      while save_keyed "$f" "$u" 1; do
        grep -qE '"has_more" *: *true' "$tmp" || break
        cur="$(json_str "$tmp" next_cursor)"
        [ -n "$cur" ] && [ "$n" -lt "$pages" ] || break
        n=$((n + 1))
        u="$url&next_cursor=$(urlencode "$cur")"
        f="${file%.json}__p$(printf '%02d' "$n").json"
        sleep 0.6
      done
      ;;
    group)                        # GeoFRED: the series group first, then the cross-section it names
      if save_keyed "$file" "$url" 0; then
        u="$turl"
        for k in series_group region_type season units frequency max_date; do
          v="$(json_str "$tmp" "$k")"
          [ "$k" = "frequency" ] && v="$(printf '%s' "${v:0:1}" | tr '[:upper:]' '[:lower:]')"
          kk="$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')"
          u="${u//__GROUP_${kk}__/$(urlencode "$v")}"
        done
        sleep 0.6
        save_keyed "$tfile" "$u" 0
      fi
      ;;
  esac
  sleep 0.6
done <<EOF
$manifest
EOF
key=""
echo
echo "Done. Upload these files to the chat:"
for p in "${saved[@]+"${saved[@]}"}"; do echo "  $p"; done
