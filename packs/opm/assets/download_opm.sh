#!/usr/bin/env bash
# Download the OPM Federal Workforce Data files for this analysis into the folder that holds this script.
# (macOS, Linux, Git Bash, WSL; on Windows PowerShell use download_opm.ps1.)
#
# Usage:  bash download_opm.sh
#
#   - The request is built into this script (written by the data-analyst skill; do not edit it).
#   - It lists the files OPM publishes now (data.opm.gov, no account or key), picks the months the
#     request asks for, and saves each one as <dataset>_<YYYYMM>_<version>.parquet.
#   - Employment files are 26-75 MB each; accession and separation files are under 4 MB.
#   - Needs only curl. Run it again after an interruption: files already saved are kept.

API="${OPM_API_BASE:-https://data.opm.gov/api/v1/files}"
API="${API%/}"
die() { echo "ERROR: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "curl is not installed. Install it (for example: sudo apt install curl) and run this script again."
HERE="$(cd "$(dirname "$0")" && pwd)"

# The request. Columns, tab-separated: dataset, then either
#   periods  YYYYMM,...  (or "latest")           the listed months
#   range    FROM|first  TO|latest  MONTHS        every month from FROM to TO in MONTHS (1-12)
#   pin      YYYYMM  VERSION                      use this version of one month instead of the current one
rules() {
cat <<'DATA_ANALYST_RULES'
@RULES@
DATA_ANALYST_RULES
}

# available DATASET: "YYYYMM VERSION" lines of the current files, oldest first
available() {
  curl -fsS -A "data-analyst/1.0" "$API/$1?current=true" | tr -d '\r\n' \
    | grep -o "\"filename\" *: *\"$1_[0-9]\{6\}_[0-9]*\"" \
    | sed 's/.*_\([0-9]\{6\}\)_\([0-9]*\)"$/\1 \2/' | sort -u
}

SAVED=(); FAILED=0; MISSING=()
for ds in $(rules | cut -f1 | sort -u); do
  [ -n "$ds" ] || continue
  echo "Listing the $ds files..."
  avail="$(available "$ds")" || die "Could not list the $ds files at $API. Check the connection, VPN and proxy, then run again."
  [ -n "$avail" ] || die "OPM listed no $ds files. Run again later."
  first="$(printf '%s\n' "$avail" | head -n 1 | cut -d' ' -f1)"
  latest="$(printf '%s\n' "$avail" | tail -n 1 | cut -d' ' -f1)"
  want=""
  while IFS=$'\t' read -r rds kind a b c; do
    [ "$rds" = "$ds" ] || continue
    case "$kind" in
      periods)
        for p in ${a//,/ }; do
          [ "$p" = latest ] && p="$latest"
          if printf '%s\n' "$avail" | grep -q "^$p "; then want="$want $p"; else MISSING+=("$ds $p"); fi
        done ;;
      range)
        lo="$a"; hi="$b"
        [ "$lo" = first ] && lo="$first"
        [ "$hi" = latest ] && hi="$latest"
        while read -r p v; do
          m=$((10#${p:4:2}))
          [ "$p" -ge "$lo" ] && [ "$p" -le "$hi" ] && case ",$c," in *",$m,"*) want="$want $p" ;; esac
        done <<< "$avail" ;;
    esac
  done < <(rules)
  for p in $(printf '%s\n' $want | sort -u); do
    v="$(rules | awk -F'\t' -v d="$ds" -v p="$p" '$1 == d && $2 == "pin" && $3 == p { print $4 }' | head -n 1)"
    [ -n "$v" ] || v="$(printf '%s\n' "$avail" | grep "^$p " | head -n 1 | cut -d' ' -f2)"
    name="${ds}_${p}_${v}.parquet"
    if [ -s "$HERE/$name" ]; then echo "already saved: $name"; SAVED+=("$HERE/$name"); continue; fi
    echo "Downloading $name ..."
    progress=-sS; [ -t 2 ] && progress=-#
    if curl "$progress" -fL -A "data-analyst/1.0" -o "$HERE/$name.part" "$API/$ds/${p:0:4}/${p:4:2}/$v/download"; then
      mv -f "$HERE/$name.part" "$HERE/$name"; SAVED+=("$HERE/$name")
    else
      rm -f "$HERE/$name.part"; echo "FAILED $name"; FAILED=$((FAILED + 1))
    fi
  done
done

echo
[ ${#MISSING[@]} -gt 0 ] && echo "Not published by OPM (skipped): ${MISSING[*]}"
if [ ${#SAVED[@]} -gt 0 ]; then
  echo "Done. Upload these files to the chat (zip them first if they are large; do not rename them):"
  for f in "${SAVED[@]}"; do echo "  $f"; done
fi
[ $FAILED -gt 0 ] && { echo "$FAILED file(s) failed: run this script again." >&2; exit 1; }
exit 0
