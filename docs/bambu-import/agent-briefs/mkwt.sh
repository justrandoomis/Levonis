#!/bin/bash
# usage: mkwt.sh <worktree path> <branch> <base commit>
set -euo pipefail
wt=$1; br=$2; base=$3
cd /home/user/Levonis
git worktree add -q -b "$br" "$wt" "$base"
mkdir -p "$wt/node_modules/@levonis"
for e in /home/user/Levonis/node_modules/* /home/user/Levonis/node_modules/.[a-z]*; do
  n=$(basename "$e"); [ "$n" = "@levonis" ] && continue
  ln -s "$e" "$wt/node_modules/$n"
done
for l in /home/user/Levonis/node_modules/@levonis/*; do
  n=$(basename "$l"); tgt=$(readlink "$l"); tgt=${tgt#../../}
  ln -s "$wt/$tgt" "$wt/node_modules/@levonis/$n"
done
[ -d /home/user/Levonis/studio/node_modules ] && ln -s /home/user/Levonis/studio/node_modules "$wt/studio/node_modules"
echo "worktree $wt on $br at $(git -C "$wt" rev-parse --short HEAD)"
