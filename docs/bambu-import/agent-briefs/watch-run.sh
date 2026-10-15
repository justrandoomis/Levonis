#!/bin/bash
# usage: watch-run.sh <run_id> [max_minutes]
run=$1; max=${2:-150}
for i in $(seq 1 $((max*2))); do
  j=$(gh api repos/justrandoomis/Levonis/actions/runs/$run 2>/dev/null)
  st=$(echo "$j" | jq -r .status); co=$(echo "$j" | jq -r .conclusion)
  if [ "$st" = "completed" ]; then
    echo "[\"$st\",\"$co\",\"$(date -u +%FT%TZ)\"]"
    gh api "repos/justrandoomis/Levonis/actions/runs/$run/jobs?per_page=100" 2>/dev/null | jq -r '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.id)\t\(.name)\t\(.conclusion)"'
    exit 0
  fi
  sleep 30
done
echo "timeout waiting for $run"
