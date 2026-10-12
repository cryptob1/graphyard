#!/usr/bin/env bash
# The chart's operating exercise, against the current kubectl context (a kind cluster in
# CI). It is the procedure docs/deployment.md documents, executed end to end:
#
#   1. install with the bundled evaluation Postgres, and `helm test` the release
#   2. seed a ledger through the API: an assignment under lease, with history
#   3. upgrade to another image; the pre-upgrade migration hook runs, pods roll, the
#      ledger and its lease survive under the same epoch
#   4. take a logical backup with the chart's CronJob onto a claim outside the release
#   5. lose the database: uninstall, delete its volume, reinstall empty
#   6. restore the backup with a Job from the same image, and read the ledger back
#
#   deploy/helm/exercise.sh IMAGE            # IMAGE = repository:tag, loaded into kind if kind is present
#
# Every step is a failure when it does not hold. Nothing here produces Graphyard evidence.
set -euo pipefail
IMAGE="${1:?Usage: exercise.sh REPOSITORY:TAG}"
REPOSITORY="${IMAGE%:*}"; TAG="${IMAGE##*:}"
NEXT_REPOSITORY="${REPOSITORY}-next"
RELEASE="${RELEASE:-gy}"; NAMESPACE="${NAMESPACE:-graphyard-exercise}"
CHART="$(cd "$(dirname "$0")" && pwd)/graphyard"
HELM_TIMEOUT="${HELM_TIMEOUT:-5m}"
# The local end of the current forward: left empty when the forward starts, so kubectl binds a
# free port itself and no leftover or concurrent listener on a fixed port can take the forward's
# place (GY-1729); forward() then reads the port kubectl bound. It and the forward's pid live in
# FORWARD_DIR as well, so a forward re-established inside a `$(api …)` is the one the next step uses.
LOCAL_PORT=""
# A forward that exits, or never answers /healthz as this release, is started again on a fresh port,
# FORWARD_ATTEMPTS times FORWARD_RETRY_WAIT seconds apart; then the exercise fails, naming why.
FORWARD_ATTEMPTS="${FORWARD_ATTEMPTS:-4}"; FORWARD_RETRY_WAIT="${FORWARD_RETRY_WAIT:-3}"
# Every attempt of one forward() shares FORWARD_BUDGET seconds of wall clock: the rollout wait, each
# attempt's 30 s of /healthz probes and every probe's curl are cut to what is left of it, so a pod that
# accepts connections and never answers fails the gate within the budget, long before the chart job's
# own timeout, instead of after FORWARD_ATTEMPTS × 30 probes × API_TIMEOUT (GY-1729).
FORWARD_BUDGET="${FORWARD_BUDGET:-180}"
# How long one API request may keep failing while the release rolls: 15 attempts 2 s apart, each
# attempt given up after API_TIMEOUT seconds (curl --max-time), so a connection the forward accepts
# but never answers is a failed attempt too, not a stall until the job's own timeout.
API_ATTEMPTS="${API_ATTEMPTS:-15}"; API_RETRY_WAIT="${API_RETRY_WAIT:-2}"
API_TIMEOUT="${API_TIMEOUT:-10}"
OPERATOR_TOKEN="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
WORKER_TOKEN="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
VALUES="$(mktemp)"
# Credentials go through a values file: `--set` would split the JSON on its commas.
cat > "$VALUES" <<EOF
secrets:
  create: true
  principals: '[{"id":"exercise-operator","role":"admin","token":"$OPERATOR_TOKEN"},{"id":"exercise-worker","role":"worker","token":"$WORKER_TOKEN"}]'
postgresql:
  enabled: true
  password: exercise-only
backup:
  enabled: true
  persistence:
    existingClaim: exercise-backups
EOF
FORWARD_PID=""; FORWARD_DIR="$(mktemp -d)"
cleanup() { stop_forward; rm -f "$VALUES"; rm -rf "$FORWARD_DIR"; }
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }
k() { kubectl --namespace "$NAMESPACE" "$@"; }
install_args() {
  helm "$1" "$RELEASE" "$CHART" --namespace "$NAMESPACE" --create-namespace --wait --timeout "$HELM_TIMEOUT" \
    --set image.repository="$2" --set image.tag="$TAG" --set image.pullPolicy=Never -f "$VALUES"
}
# What an operator needs when the release cannot be reached: the forward's own output, the
# pods behind the Service, and the server's log.
diagnose() {
  echo "--- port-forward output, every attempt" >&2; cat "$FORWARD_DIR"/forward-*.log >&2 2>/dev/null || true
  echo "--- pods, service and endpoints" >&2; k get pods,svc,endpoints -o wide >&2 || true
  echo "--- server log" >&2; k logs "deploy/$RELEASE-graphyard" --all-containers --tail=100 >&2 || true
}
# The pod the forward targets, read from `kubectl get rs,pods -o json` of the server workload on
# stdin: a Ready pod that is not terminating and carries the pod-template-hash of a ReplicaSet still
# scaled up. After a rollout only the upgraded ReplicaSet is, so the pod is one of its own.
# `kubectl port-forward svc/…` instead ranks the longest-ready pod first, which right after an
# upgrade is the old ReplicaSet's pod about to terminate (GY-1690): its first requests then got an
# empty reply. Prints `NAME PORT`, the pod and its http container port.
select_pod() {
  node -e '
    const items = JSON.parse(require("fs").readFileSync(0, "utf8")).items;
    const hash = item => item.metadata.labels?.["pod-template-hash"];
    const live = items.filter(item => item.kind === "ReplicaSet" && (item.spec.replicas ?? 0) > 0).map(hash);
    const ready = item => item.kind === "Pod" && live.includes(hash(item)) && !item.metadata.deletionTimestamp
      && (item.status?.conditions ?? []).some(condition => condition.type === "Ready" && condition.status === "True");
    const pod = items.find(ready);
    if (!pod) { console.error("no Ready pod of a scaled-up ReplicaSet among: " + items.map(item => item.kind + "/" + item.metadata.name).join(", ")); process.exit(1); }
    const port = pod.spec.containers.flatMap(container => container.ports ?? []).find(port => port.name === "http")?.containerPort ?? 4310;
    console.log(pod.metadata.name + " " + port);'
}
# Stops the current forward, whichever shell started it.
stop_forward() {
  FORWARD_PID="$(cat "$FORWARD_DIR/pid" 2>/dev/null || true)"
  # $! is the subshell running k(), so kubectl, its child, is stopped first.
  if [ -n "$FORWARD_PID" ]; then pkill -P "$FORWARD_PID" 2>/dev/null || true; kill "$FORWARD_PID" 2>/dev/null || true; wait "$FORWARD_PID" 2>/dev/null || true; fi
  rm -f "$FORWARD_DIR/pid" "$FORWARD_DIR/port"; FORWARD_PID=""; LOCAL_PORT=""
}
# Forward a free local port to the release: only once the deployment's rollout has completed (so
# step 4 cannot follow step 3 onto a terminating pod), to a pod of its current ReplicaSet, and only
# returning once /healthz through the forward reports this release's version; a forward that
# reaches anything else is dropped at once. A forward that exits (a port it could not bind, a lost pod)
# or that the pod never answers through is retried on a fresh port with the pod selected again. A
# rollout that fails or times out is a failed attempt too, never a forward: with maxUnavailable 0 the
# previous ReplicaSet stays scaled up and Ready, and both images carry the same tag, so a forward to
# its pod would pass /healthz and judge the old pod as the upgrade (GY-1729).
# Every message goes to stderr: the forward may be re-established inside a `$(api …)`.
forward() {
  local attempt made=0 target version deadline remaining probe_end now
  deadline=$(( $(date +%s) + FORWARD_BUDGET ))
  for attempt in $(seq 1 "$FORWARD_ATTEMPTS"); do
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    made="$attempt"
    stop_forward
    if ! k rollout status "deploy/$RELEASE-graphyard" --timeout="${remaining}s" >&2; then
      echo "port-forward attempt $attempt of $FORWARD_ATTEMPTS: the rollout of deploy/$RELEASE-graphyard has not completed, so no pod is forwarded" >&2
    elif target="$(k get rs,pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=server" -o json | select_pod)"; then
      echo "forwarding a free local port to pod/${target% *} (attempt $attempt of $FORWARD_ATTEMPTS)" >&2
      # Created before kubectl starts: the backgrounded redirect may not have run when the port is first read.
      FORWARD_LOG="$FORWARD_DIR/forward-$attempt-$(date +%s%N).log"; : >"$FORWARD_LOG"
      k port-forward --address 127.0.0.1 "pod/${target% *}" "$LOCAL_PORT:${target#* }" >"$FORWARD_LOG" 2>&1 &
      FORWARD_PID=$!; echo "$FORWARD_PID" >"$FORWARD_DIR/pid"
      probe_end=$(( $(date +%s) + 30 )); if [ "$probe_end" -gt "$deadline" ]; then probe_end="$deadline"; fi
      while now="$(date +%s)"; [ "$now" -lt "$probe_end" ]; do
        [ -n "$LOCAL_PORT" ] || LOCAL_PORT="$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9][0-9]*\) .*/\1/p' "$FORWARD_LOG" | head -1)"
        if [ -n "$LOCAL_PORT" ]; then
          version="$(curl -fsS "http://127.0.0.1:$LOCAL_PORT/healthz" --max-time "$(( probe_end - now < API_TIMEOUT ? probe_end - now : API_TIMEOUT ))" 2>/dev/null | node -e 'try { console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).version ?? "") } catch {}' || true)"
          if [ "$version" = "$TAG" ]; then echo "$LOCAL_PORT" >"$FORWARD_DIR/port"; echo "forwarding 127.0.0.1:$LOCAL_PORT to pod/${target% *}" >&2; return 0; fi
          if [ -n "$version" ]; then break; fi
        fi
        if ! kill -0 "$FORWARD_PID" 2>/dev/null; then break; fi
        sleep 0.2
      done
      echo "port-forward attempt $attempt of $FORWARD_ATTEMPTS to pod/${target% *} did not answer /healthz as release $TAG (local port ${LOCAL_PORT:-none bound}, healthz version ${version:-none}): $(tail -n 1 "$FORWARD_LOG")" >&2
    fi
    if [ "$attempt" -lt "$FORWARD_ATTEMPTS" ] && [ $(( deadline - $(date +%s) )) -gt "$FORWARD_RETRY_WAIT" ]; then sleep "$FORWARD_RETRY_WAIT"; fi
  done
  diagnose; stop_forward
  echo "port-forward to release $RELEASE never became reachable after $made attempts within ${FORWARD_BUDGET}s" >&2
  exit 1
}
# The exercise's own forward, re-established when it has exited, wherever it was started.
ensure_forward() {
  FORWARD_PID="$(cat "$FORWARD_DIR/pid" 2>/dev/null || true)"; LOCAL_PORT="$(cat "$FORWARD_DIR/port" 2>/dev/null || true)"
  if [ -n "$FORWARD_PID" ] && [ -n "$LOCAL_PORT" ] && kill -0 "$FORWARD_PID" 2>/dev/null; then return 0; fi
  echo "the port-forward ${FORWARD_PID:+(pid $FORWARD_PID) }is gone; re-establishing it" >&2
  forward
}
# api METHOD PATH TOKEN [BODY] — one request to the forwarded release, printing the non-empty body
# of a 2xx reply. An empty reply, a reset connection, a transfer still unanswered after API_TIMEOUT
# seconds, a non-2xx status or a 2xx carrying no body at all is a failed request, never a body: every
# route the exercise calls answers with the engine's JSON, and while the release rolls the forward
# can reach a pod that is terminating or not yet serving, so the request is retried under the same
# Idempotency-Key, API_ATTEMPTS times API_RETRY_WAIT seconds apart, and when the bound is exhausted
# (every attempt bounded, so the loop always reaches it) the exercise prints its diagnosis
# and exits on a last line naming the request, the status and the body it received, instead of
# handing an empty body to a JSON projection (GY-1690). Before each attempt the exercise's forward
# (FORWARD_DIR; a caller without one sets LOCAL_PORT itself) is re-established if it has exited, and
# three connection failures in a row through a live forward start it afresh (GY-1729).
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" key reply status attempt rc received lost=0
  key="$(node -p "require('node:crypto').randomUUID()")"; reply="$(mktemp)"
  for attempt in $(seq 1 "$API_ATTEMPTS"); do
    if [ -n "${FORWARD_DIR:-}" ]; then ensure_forward; fi
    rc=0
    status="$(curl -sS --max-time "$API_TIMEOUT" -o "$reply" -w '%{http_code}' -X "$method" "http://127.0.0.1:$LOCAL_PORT/api/$path" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" ${body:+--data "$body"} 2>"$reply.err")" || rc=$?
    if [ "$rc" -ne 0 ]; then status="$status, $(tr -d '\n' <"$reply.err")"; lost=$((lost + 1)); else lost=0; fi
    if [ "$lost" -ge 3 ] && [ -n "${FORWARD_DIR:-}" ]; then lost=0; stop_forward; fi
    case "$status" in
      2[0-9][0-9]) if [ -s "$reply" ]; then cat "$reply"; rm -f "$reply" "$reply.err"; return 0; fi; status="$status with an empty body";;
    esac
    echo "api $method /api/$path: attempt $attempt of $API_ATTEMPTS got status $status" >&2
    if [ "$attempt" -lt "$API_ATTEMPTS" ]; then sleep "$API_RETRY_WAIT"; fi
  done
  diagnose; received="$(cat "$reply")"; rm -f "$reply" "$reply.err"
  echo "api $method /api/$path failed after $API_ATTEMPTS attempts: status $status, body: ${received:-(empty)}" >&2
  exit 1
}
# rejects METHOD PATH TOKEN BODY STATUS ERROR — a request the release must refuse: it returns only
# once the release answers STATUS with an `error` containing ERROR. A 2xx, or any other status or
# error (a 401/403 from broken credentials, a 404 from a missing route), ends the exercise naming it,
# since the refusal it checks never ran. A failed transfer, a 5xx or no status at all is no answer: it
# is retried under the same Idempotency-Key within api()'s bound, through a forward re-established as
# api() does, and when the bound is exhausted the exercise prints its diagnosis and exits (GY-1729).
rejects() {
  local method="$1" path="$2" token="$3" body="$4" expected="$5" error="$6" key err reply status attempt rc lost=0 received
  key="$(node -p "require('node:crypto').randomUUID()")"; err="$(mktemp)"; reply="$(mktemp)"
  for attempt in $(seq 1 "$API_ATTEMPTS"); do
    if [ -n "${FORWARD_DIR:-}" ]; then ensure_forward; fi
    rc=0
    status="$(curl -sS --max-time "$API_TIMEOUT" -o "$reply" -w '%{http_code}' -X "$method" "http://127.0.0.1:$LOCAL_PORT/api/$path" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" --data "$body" 2>"$err")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      status="$status, $(tr -d '\n' <"$err")"; lost=$((lost + 1))
      if [ "$lost" -ge 3 ] && [ -n "${FORWARD_DIR:-}" ]; then lost=0; stop_forward; fi
    else
      lost=0
      case "$status" in
        2[0-9][0-9]) rm -f "$err" "$reply"; echo "api $method /api/$path was accepted with status $status; the release must refuse it" >&2; exit 1;;
        4[0-9][0-9])
          received="$(node -e "try{const e=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).error;process.stdout.write(typeof e==='string'?e:'')}catch{}" "$reply")"
          if [ "$status" = "$expected" ] && [ -n "$received" ] && [[ "$received" == *"$error"* ]]; then
            rm -f "$err" "$reply"; echo "api $method /api/$path refused with status $status ($received), as it must be" >&2; return 0
          fi
          received="$(cat "$reply")"; rm -f "$err" "$reply"
          echo "api $method /api/$path was refused with status $status, body: ${received:-(empty)}; the release must refuse it with $expected naming '$error'" >&2; exit 1;;
      esac
    fi
    echo "api $method /api/$path: attempt $attempt of $API_ATTEMPTS got status $status, not a refusal" >&2
    if [ "$attempt" -lt "$API_ATTEMPTS" ]; then sleep "$API_RETRY_WAIT"; fi
  done
  diagnose; rm -f "$err" "$reply"
  echo "api $method /api/$path received no refusal after $API_ATTEMPTS attempts: status $status" >&2
  exit 1
}
# The part of the ledger a restore and an upgrade must hand back unchanged.
projection() { node -e "const w=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(w.map(x=>({id:x.id,key:x.key,title:x.title,stage:x.stage,epoch:x.epoch,revision:x.revision,workspaces:x.workspaces,lease:x.lease&&{owner:x.lease.owner,epoch:x.lease.epoch,expiresAt:x.lease.expiresAt}}))))"; }
# The projected ledger, read in two steps so a failed request ends the exercise on api's own last
# line rather than feeding the projection an empty body.
ledger() { local body; body="$(api GET work "$OPERATOR_TOKEN")" || return 1; printf '%s' "$body" | projection; }
same() { if [ "$1" != "$2" ]; then echo "$3" >&2; echo "expected: $1" >&2; echo "actual:   $2" >&2; exit 1; fi; }

if command -v kind >/dev/null 2>&1; then
  step "Loading $IMAGE into kind as $REPOSITORY:$TAG and $NEXT_REPOSITORY:$TAG"
  docker tag "$IMAGE" "$NEXT_REPOSITORY:$TAG"
  kind load docker-image "$IMAGE" "$NEXT_REPOSITORY:$TAG" --name "${KIND_CLUSTER:-graphyard}"
fi

step "Creating the namespace and the backup claim the release does not own"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: exercise-backups, namespace: $NAMESPACE }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
EOF

step "1. Installing $IMAGE with the bundled evaluation database"
install_args install "$REPOSITORY"
helm test "$RELEASE" --namespace "$NAMESPACE" --logs
# forward() returns only once /healthz through it reports $TAG, so the deployed version is checked there;
# a second, unretried probe would abort the exercise on a forward lost just after it (GY-1729).
forward

step "2. Seeding a ledger: an assignment under lease with history, and a backlog item"
WORK="$(api POST work "$OPERATOR_TOKEN" '{"title":"Chart exercise","criteria":[{"id":"AC-1","text":"Survives upgrade and restore","proofs":["integration:chart"]}]}')"
WORK_ID="$(printf '%s' "$WORK" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")"
api POST "work/$WORK_ID/ready" "$OPERATOR_TOKEN" '{}' >/dev/null
api POST "work/$WORK_ID/claim" "$WORKER_TOKEN" '{}' >/dev/null
api POST "work/$WORK_ID/workspace" "$WORKER_TOKEN" '{"epoch":1,"host":"exercise-host","path":"/srv/worktrees/chart","branch":"graphyard/chart-1"}' >/dev/null
api POST work "$OPERATOR_TOKEN" '{"title":"Backlog item","criteria":[{"id":"AC-1","text":"Waits","proofs":["unit:later"]}]}' >/dev/null
history() { local body; body="$(api GET "events?work=$WORK_ID" "$OPERATOR_TOKEN")" || return 1; printf '%s' "$body" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).map(e=>e.seq+':'+e.kind).join(',')"; }

step "3. Upgrading to $NEXT_REPOSITORY:$TAG; the migration hook runs before pods roll"
# The lease is renewed just before the upgrade so the rollout, not the clock, is what is judged.
api POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":1}' >/dev/null
BEFORE="$(ledger)"
install_args upgrade "$NEXT_REPOSITORY"
same "2" "$(helm history "$RELEASE" --namespace "$NAMESPACE" -o json | node -p "const h=JSON.parse(require('fs').readFileSync(0,'utf8'));String(h.at(-1).revision)+(h.at(-1).status==='deployed'?'':'-'+h.at(-1).status)")" 'the upgrade did not deploy as revision 2'
same "$NEXT_REPOSITORY:$TAG" "$(k get deploy "$RELEASE-graphyard" -o jsonpath='{.spec.template.spec.containers[0].image}')" 'pods did not roll to the upgraded image'
forward
AFTER="$(ledger)"
same "$BEFORE" "$AFTER" 'the ledger changed across the upgrade'
api POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":1}' >/dev/null
rejects POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":2}' 409 'superseded'

step "4. Taking a logical backup with the chart's CronJob"
BEFORE_BACKUP="$(ledger)"
HISTORY_BEFORE="$(history)"
k create job exercise-backup --from="cronjob/$RELEASE-graphyard-backup"
k wait --for=condition=complete --timeout=180s job/exercise-backup
BACKUP_FILE="$(k logs job/exercise-backup | grep -o 'graphyard-[0-9TZ]*\.json' | tail -1)"
[ -n "$BACKUP_FILE" ] || { echo 'the backup job wrote no file' >&2; k logs job/exercise-backup >&2; exit 1; }
echo "backup: $BACKUP_FILE"

step "5. Losing the database: uninstall, delete its volume, reinstall empty"
stop_forward
helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait
k delete pvc "data-$RELEASE-graphyard-postgresql-0" --wait
install_args install "$REPOSITORY"
forward
EMPTY="$(api GET work "$OPERATOR_TOKEN")"
same "[]" "$EMPTY" 'the reinstalled release is not empty'

step "6. Restoring $BACKUP_FILE with a Job from the same image"
k apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata: { name: exercise-restore }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
      containers:
        - name: restore
          image: $REPOSITORY:$TAG
          imagePullPolicy: Never
          command: ["node", "bin/graphyard.mjs", "db", "restore", "/backups/$BACKUP_FILE"]
          env:
            - { name: TMPDIR, value: /tmp }
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: $RELEASE-graphyard, key: DATABASE_URL } }
          volumeMounts:
            - { name: backups, mountPath: /backups, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: backups
          persistentVolumeClaim: { claimName: exercise-backups }
        - name: tmp
          emptyDir: {}
EOF
k wait --for=condition=complete --timeout=180s job/exercise-restore || { k logs job/exercise-restore >&2; exit 1; }
k logs job/exercise-restore
RESTORED="$(ledger)"
same "$BEFORE_BACKUP" "$RESTORED" 'the restored ledger differs from the backup'
HISTORY_AFTER="$(history)"
same "$HISTORY_BEFORE" "$HISTORY_AFTER" 'history was not restored in order'
NEXT="$(api POST work "$OPERATOR_TOKEN" '{"title":"After restore","criteria":[{"id":"AC-1","text":"Continues","proofs":["unit:after"]}]}')"
NEXT_KEY="$(printf '%s' "$NEXT" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).key")"
same "GY-3" "$NEXT_KEY" 'work numbering did not continue after the restored items'

step "Chart exercise passed: install, test, seed, upgrade, backup, loss, reinstall, restore"
