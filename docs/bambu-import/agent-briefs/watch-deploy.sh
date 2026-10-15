#!/bin/bash
# usage: watch-deploy.sh <run_id>: waits for workflow 7, prints the deploy job's steps and live health
run=$1
for i in $(seq 1 300); do
  j=$(gh api repos/justrandoomis/Levonis/actions/runs/$run 2>/dev/null)
  st=$(echo "$j" | jq -r .status); co=$(echo "$j" | jq -r .conclusion)
  if [ "$st" = "completed" ]; then
    echo "[\"$st\",\"$co\",\"$(date -u +%FT%TZ)\"]"
    jobs=$(gh api "repos/justrandoomis/Levonis/actions/runs/$run/jobs?per_page=100" 2>/dev/null)
    echo "$jobs" | jq -r '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.id)\t\(.name)\t\(.conclusion)"'
    did=$(echo "$jobs" | jq -r '.jobs[] | select(.name=="deploy") | .id')
    echo "deploy job $did"
    echo "$jobs" | jq -r '.jobs[] | select(.name=="deploy") | .steps[] | "\(.number)\t\(.name)\t\(.conclusion)"' | tail -14
    curl -s --max-time 25 https://levonis-iq.com/api/health | jq -c .schema
    exit 0
  fi
  sleep 30
done
echo "timeout"
