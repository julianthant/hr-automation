#!/usr/bin/env bash
# dashboard-cli.sh — Rapid CLI helper for hr-automation dashboard API (:3838)
set -euo pipefail

BASE_URL="${HRAUTO_DASHBOARD_URL:-http://localhost:3838}"

get_token() {
  local res
  res=$(curl -s -f "${BASE_URL}/api/operator/session" 2>/dev/null) || {
    echo "Error: Dashboard backend not responding at ${BASE_URL}. Is 'npm run dashboard' running?" >&2
    exit 1
  }
  python3 -c "import sys, json; print(json.loads(sys.argv[1]).get('token', ''))" "$res"
}

cmd_token() {
  get_token
}

cmd_status() {
  local wf="${1:-}"
  local url="${BASE_URL}/api/daemons"
  if [ -n "$wf" ]; then
    url="${url}?workflow=${wf}"
  fi
  echo "=== Dashboard Connectivity ==="
  curl -s -f "${BASE_URL}/api/health" 2>/dev/null && echo "Health: OK" || echo "Health: Server up (no /api/health)"
  echo ""
  echo "=== Active Daemons ==="
  local res
  res=$(curl -s "${url}")
  python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    if not isinstance(data, list):
        data = data.get('daemons', [])
    if not data:
        print('No active daemons.')
    for d in data:
        print(f\"[{d.get('workflow')}] phase={d.get('phase')} item={d.get('currentItem')} processed={d.get('itemsProcessed')} pidAlive={d.get('pidAlive')} instance={d.get('instance')}\")
except Exception as e:
    print('Failed to parse daemons:', e)
" "$res"
}

cmd_enqueue() {
  local wf="${1:?Workflow required (e.g. onboarding, separations, crm-doc-download)}"
  local raw_inputs="${2:?Inputs JSON array required (e.g. '[{\"email\":\"user@ucsd.edu\"}]')}"
  local parallel="${3:-}"
  local dry_run="${4:-false}"

  local token
  token=$(get_token)

  # Build JSON payload using python to avoid escaping bugs
  local payload
  payload=$(python3 -c "
import sys, json
wf = sys.argv[1]
inputs = json.loads(sys.argv[2])
parallel = sys.argv[3]
dry = sys.argv[4].lower() in ('true', '1', 'yes')

if dry:
    for item in inputs:
        if isinstance(item, dict):
            item['dryRun'] = True

body = {'workflow': wf, 'inputs': inputs}
if parallel and parallel != 'auto':
    try:
        body['parallelWorkers'] = int(parallel)
    except ValueError:
        body['parallelWorkers'] = parallel
print(json.dumps(body))
" "$wf" "$raw_inputs" "$parallel" "$dry_run")

  echo "Enqueueing ${wf} (${BASE_URL}/api/enqueue)..."
  local res
  res=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/enqueue" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "$payload")

  local http_code
  http_code=$(echo "$res" | tail -n1)
  local body
  body=$(echo "$res" | sed '$d')

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    echo "Success (${http_code}): ${body}"
  else
    echo "Failed (${http_code}): ${body}" >&2
    exit 1
  fi
}

cmd_entries() {
  local wf="${1:?Workflow required}"
  local res
  res=$(curl -s "${BASE_URL}/api/entries?workflow=${wf}")
  python3 -c "
import sys, json
try:
    entries = json.loads(sys.argv[1])
    print(f'=== Recent Entries for {sys.argv[2]} ({len(entries)}) ===')
    for e in entries[:25]:
        d = e.get('data') or {}
        st = e.get('status') or d.get('status')
        step = e.get('step') or d.get('step') or ''
        name = d.get('name') or d.get('__name') or e.get('id')
        err = (e.get('error') or d.get('error') or '')[:80]
        print(f\"#{e.get('id'):<20} {st:<12} step={step:<20} name={name:<25} {err}\")
except Exception as e:
    print('Failed to parse entries:', e)
" "$res" "$wf"
}

cmd_not_this_person() {
  local wf="${1:?Workflow required (e.g. onboarding)}"
  local id="${2:?Item ID/Email required}"
  local rejected_eid="${3:?Rejected EID required}"
  local run_id="${4:-}"

  local token
  token=$(get_token)

  local payload
  payload=$(python3 -c "
import sys, json
body = {
    'workflow': sys.argv[1],
    'id': sys.argv[2],
    'eid': sys.argv[3]
}
if len(sys.argv) > 4 and sys.argv[4]:
    body['runId'] = sys.argv[4]
print(json.dumps(body))
" "$wf" "$id" "$rejected_eid" "$run_id")

  echo "Marking ${rejected_eid} as NOT this person for ${id} in ${wf}..."
  curl -s -X POST "${BASE_URL}/api/eid-approval/not-this-person" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "$payload" | python3 -m json.tool
}

cmd_approve_eid() {
  local wf="${1:?Workflow required (e.g. onboarding, separations)}"
  local id="${2:?Item ID/Email required}"
  local approved_eid="${3:?Approved EID required}"
  local run_id="${4:-}"

  local token
  token=$(get_token)

  local payload
  payload=$(python3 -c "
import sys, json
body = {
    'workflow': sys.argv[1],
    'id': sys.argv[2],
    'approvedEid': sys.argv[3]
}
if len(sys.argv) > 4 and sys.argv[4]:
    body['runId'] = sys.argv[4]
print(json.dumps(body))
" "$wf" "$id" "$approved_eid" "$run_id")

  echo "Approving EID ${approved_eid} for ${id} in ${wf}..."
  curl -s -X POST "${BASE_URL}/api/eid-approval/approve" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "$payload" | python3 -m json.tool
}

cmd_stop() {
  local wf="${1:?Workflow required}"
  local token
  token=$(get_token)
  echo "Stopping daemons for ${wf}..."
  curl -s -X POST "${BASE_URL}/api/daemon/stop" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "{\"workflow\":\"${wf}\"}" | python3 -m json.tool
}

cmd_cancel() {
  local wf="${1:?Workflow required}"
  local token
  token=$(get_token)
  echo "Cancelling active runs for ${wf}..."
  curl -s -X POST "${BASE_URL}/api/cancel-active-bulk" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "{\"workflow\":\"${wf}\"}" | python3 -m json.tool
}

cmd_retry() {
  local wf="${1:?Workflow required}"
  local run_id="${2:?Run ID required}"
  local token
  token=$(get_token)
  echo "Retrying run ${run_id} for ${wf}..."
  curl -s -X POST "${BASE_URL}/api/retry" \
    -H "content-type: application/json" \
    -H "x-hr-auto-operator-token: ${token}" \
    -d "{\"workflow\":\"${wf}\",\"runId\":\"${run_id}\"}" | python3 -m json.tool
}

cmd_monitor() {
  local wf="${1:?Workflow required}"
  local timeout_s="${2:-600}"
  local start_time
  start_time=$(date +%s)

  echo "Monitoring ${wf} (timeout ${timeout_s}s)..."
  while true; do
    local now
    now=$(date +%s)
    local elapsed=$(( now - start_time ))
    if [ "$elapsed" -ge "$timeout_s" ]; then
      echo "Monitor timeout reached (${timeout_s}s)."
      break
    fi

    local daemons
    daemons=$(curl -s "${BASE_URL}/api/daemons?workflow=${wf}" 2>/dev/null || echo "[]")
    local status_line
    status_line=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.argv[1])
    if not isinstance(d, list): d = d.get('daemons', [])
    if not d:
        print('no-daemons')
    else:
        phases = [f\"{x.get('phase')}({x.get('currentItem') or '-'}:{x.get('itemsProcessed',0)})\t\" for x in d]
        print(' '.join(phases))
except:
    print('err')
" "$daemons")

    printf "\r[%03ds] daemons: %s" "$elapsed" "$status_line"

    if [ "$status_line" = "no-daemons" ]; then
      echo ""
      echo "All daemons finished or idle."
      break
    fi

    sleep 5
  done
  echo ""
  cmd_entries "$wf"
}

usage() {
  cat <<EOF
Usage: $0 <command> [arguments...]

Commands:
  token                                              Print operator session token
  status [workflow]                                  Check server health and active daemons
  enqueue <workflow> '<json_inputs>' [workers] [dry] Enqueue inputs to workflow
  entries <workflow>                                 View latest entries for workflow
  not-this-person <workflow> <id> <eid> [runId]      Reject false identity match and proceed as new hire
  approve <workflow> <id> <approvedEid> [runId]      Approve candidate EID for rehire/concurrent hire
  stop <workflow>                                    Stop background daemons for workflow
  cancel <workflow>                                  Cancel all active (queued/running) items for workflow
  retry <workflow> <runId>                           Retry a specific failed run
  monitor <workflow> [timeout_s]                     Watch workflow daemon progress live until completion

Examples:
  $0 status onboarding
  $0 enqueue onboarding '[{"email":"user@ucsd.edu","mode":"new-hire"}]'
  $0 enqueue separations '[{"docId":"4694"},{"docId":"4693"}]'
  $0 not-this-person onboarding anthony@ucsd.edu 10783400
  $0 monitor separations
EOF
}

case "${1:-}" in
  token) shift; cmd_token "$@" ;;
  status) shift; cmd_status "$@" ;;
  enqueue) shift; cmd_enqueue "$@" ;;
  entries) shift; cmd_entries "$@" ;;
  not-this-person) shift; cmd_not_this_person "$@" ;;
  approve) shift; cmd_approve_eid "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  cancel) shift; cmd_cancel "$@" ;;
  retry) shift; cmd_retry "$@" ;;
  monitor) shift; cmd_monitor "$@" ;;
  *) usage; exit 1 ;;
esac
