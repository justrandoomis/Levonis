#!/bin/bash
# usage: waitrun.sh <run_id>  — waits until the run completes, prints conclusion and failed jobs
run=$1
while true; do
  s=$(curl -sS --max-time 30 "https://api.github.com/repos/justrandoomis/Levonis/actions/runs/$run" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('conclusion'))" 2>/dev/null)
  case "$s" in completed*) break;; esac
  sleep 60
done
echo "run $run: $s"
curl -sS --max-time 30 "https://api.github.com/repos/justrandoomis/Levonis/actions/runs/$run/jobs?per_page=100" | python3 -I -c "
import json,sys
d=json.load(sys.stdin)
js=d.get('jobs',[])
from collections import Counter
print(Counter(j.get('conclusion') for j in js))
for j in js:
  if j.get('conclusion') not in ('success','skipped'):
    print(j['id'], j['name'], j.get('conclusion'))
"
