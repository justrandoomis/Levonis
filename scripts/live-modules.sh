#!/usr/bin/env bash
# Read every JS module the deployed SPA can load — transitively.
#
#   scripts/live-modules.sh <origin> [start-path]
#
# Vite names only the entry modules in the HTML. Everything a route loads
# lazily is named from inside another chunk, and those names nest: the admin
# product form sits THREE hops from the entry (index -> admin shell ->
# AdminProducts -> ProductForm). A one-hop crawl therefore reads a strict
# subset of what a browser can load, and that subset lies in both directions:
# a shipped marker reads as "missing", and a marker that is still shipped in a
# deeper chunk reads as "gone". So walk the graph until it stops growing.
#
# Read-only: every request is an anonymous GET. --compressed on every fetch —
# the edge serves these gzipped, and a grep over compressed bytes finds
# nothing and calls it a miss.
#
# Leaves the modules in /tmp/mods and their names in /tmp/module-list.txt, and
# prints how many were read in how many hops. Callers grep /tmp/mods/*.
set -euo pipefail

ORIGIN="${1:?usage: live-modules.sh <origin> [start-path]}"
START="${2:-/}"
MODS=/tmp/mods
MAX_MODULES=600   # a runaway guard, far above the ~100 this app ships

html=$(curl -s --compressed --max-time 25 "$ORIGIN$START")
mkdir -p "$MODS"
printf '%s' "$html" | grep -oE '/assets/[A-Za-z0-9_.-]+\.js' | sed 's#.*/##' | sort -u > /tmp/mods-frontier
if [ ! -s /tmp/mods-frontier ]; then
  echo "  FAIL $START served no JS module. First 400 bytes:"
  printf '%s' "$html" | head -c 400
  exit 1
fi

: > /tmp/mods-seen
hops=0
capped=0
while [ -s /tmp/mods-frontier ] && [ "$hops" -lt 15 ]; do
  : > /tmp/mods-next
  while read -r c; do
    [ -n "$c" ] || continue
    if grep -qxF "$c" /tmp/mods-seen; then continue; fi
    if [ "$(wc -l < /tmp/mods-seen)" -ge "$MAX_MODULES" ]; then capped=1; break; fi
    printf '%s\n' "$c" >> /tmp/mods-seen
    code=$(curl -s --compressed --max-time 60 -o "$MODS/$c" -w '%{http_code}' "$ORIGIN/assets/$c" || echo 000)
    if [ "$code" != "200" ]; then rm -f "$MODS/$c"; continue; fi
    # The names a chunk mentions are the chunks it can pull in next.
    grep -oE '[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js' "$MODS/$c" >> /tmp/mods-next || true
  done < /tmp/mods-frontier
  if [ "$capped" = "1" ]; then
    echo "  NOTE stopped at $MAX_MODULES modules — the graph is larger than this crawl"
    break
  fi
  sort -u /tmp/mods-next > /tmp/mods-frontier
  hops=$((hops + 1))
done

ls "$MODS" > /tmp/module-list.txt
echo "  modules read: $(wc -l < /tmp/module-list.txt) in $hops hops"
