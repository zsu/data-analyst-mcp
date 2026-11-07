#!/usr/bin/env bash
# Download the files for this analysis into the folder that holds this script.
# (macOS, Linux, Git Bash, WSL; on Windows PowerShell use @STEM@.ps1.)
#
# Usage:  bash @STEM@.sh
#
#   - The requests are built into this script (written by the data-analyst skill; do not edit them).
#   - Files that need an API key: the script uses the key's environment variable when it is set,
#     otherwise asks for the key with hidden input (press Enter to skip those files). The key is never
#     shown, saved, or put on a command line.
#   - Needs only curl, which macOS and most Linux systems have.
#   - At the end it prints the files to upload to the chat.

die() { echo "ERROR: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "curl is not installed. Install it (for example: sudo apt install curl) and run this script again."

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/data_analyst.XXXXXX")" || die "Cannot create a temporary folder."
trap 'rm -rf "$TMP"' EXIT
umask 077

# Values the requests need. Columns, tab-separated: variable, kind (secret = an API key, asked with
# hidden input; plain = asked with visible input), where to get it.
values() {
cat <<'DATA_ANALYST_VALUES'
@VALUES@
DATA_ANALYST_VALUES
}

# The requests. Columns, tab-separated ("-" = empty): file, method, optional (1 = may fail), key
# variable, key placement (query, header, body or none), header or body field name, header prefix,
# other variables (comma-separated), URL, JSON body.
items() {
cat <<'DATA_ANALYST_ITEMS'
@ITEMS@
DATA_ANALYST_ITEMS
}

# escape for a double-quoted curl config value or a JSON string
esc() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# subst TEXT PLACEHOLDER VALUE: every PLACEHOLDER replaced literally (the same in bash 3.2 and 5.x)
subst() {
  local s="$1" out=""
  [ -n "$2" ] || { printf '%s' "$s"; return; }
  while [[ "$s" == *"$2"* ]]; do out+="${s%%"$2"*}$3"; s="${s#*"$2"}"; done
  printf '%s' "$out$s"
}

# --------------------------------------------------------------------------- keys and other values
while IFS=$'\t' read -r var kind where <&3; do
  [ -n "$var" ] || continue
  val="${!var:-}"
  if [ -n "$val" ]; then
    echo "Using \$$var."
  else
    if [ "$kind" = secret ]; then
      echo "Some files need your $var ($where). Press Enter to skip them."
      if [ -t 0 ]; then printf '%s (input is hidden): ' "$var"; IFS= read -rs val; echo
      else IFS= read -r val || true; fi
    else
      if [ -t 0 ]; then printf '%s (%s): ' "$var" "$where"; fi
      IFS= read -r val || true
    fi
  fi
  if [ "$kind" = secret ]; then val="$(printf '%s' "$val" | tr -d '[:space:]')"
  else val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"; fi
  printf -v "V_$var" '%s' "$val"
done 3< <(values)

# --------------------------------------------------------------------------- download
SAVED=(); FAILED=0; SKIPPED=0
while IFS=$'\t' read -r file method optional kvar place kname kprefix extras url body <&3; do
  [ -n "$file" ] && [ "$file" != "-" ] || continue
  key=""
  if [ "$kvar" != "-" ]; then
    v="V_$kvar"; key="${!v:-}"
    if [ -z "$key" ]; then echo "skipped (needs $kvar): $file"; SKIPPED=$((SKIPPED + 1)); continue; fi
  fi
  miss=""
  if [ "$extras" != "-" ]; then
    for x in ${extras//,/ }; do
      v="V_$x"; val="${!v:-}"
      [ -n "$val" ] || { miss="$x"; break; }
      url="$(subst "$url" "{$x}" "$val")"
    done
  fi
  if [ -n "$miss" ]; then echo "skipped (needs $miss): $file"; SKIPPED=$((SKIPPED + 1)); continue; fi
  [ "$place" = query ] && url="$(subst "$url" "{API_KEY}" "$key")"

  # The URL and any key header reach curl as a config file on stdin (-K -), never as arguments.
  cfg() {
    printf 'url = "%s"\n' "$(esc "$url")"
    [ "$place" = header ] && printf 'header = "%s: %s%s"\n' "$(esc "$kname")" "$(esc "$kprefix")" "$(esc "$key")"
    return 0
  }
  args=(-sS -K - -A "data-analyst/1.0" -o "$HERE/$file.part" -w '%{http_code}')
  # curl -L forwards custom headers (the key) to any host a redirect names: follow redirects only without one
  [ "$place" = header ] || args+=(-L)
  if [ "$body" != "-" ]; then
    [ "$place" = body ] && body="$(subst "$body" "{API_KEY}" "$(esc "$key")")"
    printf '%s' "$body" > "$TMP/body"
    args+=(-H "Content-Type: application/json" --data-binary "@$TMP/body")
  fi
  [ "$method" = GET ] || args+=(-X "$method")

  tries=0
  while :; do
    tries=$((tries + 1))
    code="$(cfg | curl "${args[@]}")"
    rc=$?
    [ $rc -eq 0 ] && case "$code" in 429|5??) ;; *) break ;; esac
    [ $tries -ge 4 ] && break
    sleep $((tries * 10))
  done
  rm -f "$TMP/body"
  if [ $rc -eq 0 ] && case "$code" in 2??) true ;; *) false ;; esac; then
    mv -f "$HERE/$file.part" "$HERE/$file"
    SAVED+=("$HERE/$file")
    echo "saved $file"
  else
    msg=""
    [ -f "$HERE/$file.part" ] && msg="$(head -c 300 "$HERE/$file.part" | tr -d '\r\n')"
    [ -n "$key" ] && msg="$(subst "$msg" "$key" "[KEY]")"
    rm -f "$HERE/$file.part"
    if [ "$optional" = 1 ]; then
      echo "not available (optional, HTTP ${code:-none}): $file"
    else
      case "$code" in 3??) msg="a redirect: the key is never sent past one; open the URL in a browser instead" ;; esac
      [ $rc -eq 0 ] && echo "FAILED $file: HTTP $code $msg" || echo "FAILED $file: could not reach the server (check the connection, VPN and proxy)"
      FAILED=$((FAILED + 1))
    fi
  fi
done 3< <(items)

echo
if [ ${#SAVED[@]} -gt 0 ]; then
  echo "Done. Upload these files to the chat (do not rename or edit them):"
  for p in "${SAVED[@]}"; do echo "  $p"; done
fi
[ $SKIPPED -gt 0 ] && echo "$SKIPPED file(s) skipped: run again and enter the value asked for."
[ $FAILED -gt 0 ] && { echo "$FAILED file(s) failed: send the messages above to the analyst." >&2; exit 1; }
exit 0
