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
FORWARD_PID=""; FORWARD_LOG="$(mktemp)"
stop_forward() { if [ -n "$FORWARD_PID" ]; then kill "$FORWARD_PID" 2>/dev/null || true; wait "$FORWARD_PID" 2>/dev/null || true; fi; FORWARD_PID=""; }
cleanup() { stop_forward; rm -f "$VALUES" "$FORWARD_LOG"; }
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
  echo "--- port-forward output" >&2; cat "$FORWARD_LOG" >&2
  echo "--- pods, service and endpoints" >&2; k get pods,svc,endpoints -o wide >&2 || true
  echo "--- server log" >&2; k logs "deploy/$RELEASE-graphyard" --all-containers --tail=100 >&2 || true
}
forward() {
  stop_forward
  k port-forward --address 127.0.0.1 "svc/$RELEASE-graphyard" 14310:80 >"$FORWARD_LOG" 2>&1 &
  FORWARD_PID=$!
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:14310/healthz >/dev/null 2>&1; then return; fi
    if ! kill -0 "$FORWARD_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  echo 'port-forward never became reachable' >&2; diagnose; exit 1
}
api() { # api METHOD PATH TOKEN [BODY]
  local method="$1" path="$2" token="$3" body="${4:-}"
  curl -fsS -X "$method" "http://127.0.0.1:14310/api/$path" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H "Idempotency-Key: $(node -p "require('node:crypto').randomUUID()")" ${body:+--data "$body"}
}
# The part of the ledger a restore and an upgrade must hand back unchanged.
projection() { node -e "const w=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(w.map(x=>({id:x.id,key:x.key,title:x.title,stage:x.stage,epoch:x.epoch,revision:x.revision,workspaces:x.workspaces,lease:x.lease&&{owner:x.lease.owner,epoch:x.lease.epoch,expiresAt:x.lease.expiresAt}}))))"; }
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
forward
HEALTH="$(curl -fsS http://127.0.0.1:14310/healthz)"
same "$TAG" "$(printf '%s' "$HEALTH" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")" '/healthz does not report the deployed version'

step "2. Seeding a ledger: an assignment under lease with history, and a backlog item"
WORK="$(api POST work "$OPERATOR_TOKEN" '{"title":"Chart exercise","criteria":[{"id":"AC-1","text":"Survives upgrade and restore","proofs":["integration:chart"]}]}')"
WORK_ID="$(printf '%s' "$WORK" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")"
api POST "work/$WORK_ID/ready" "$OPERATOR_TOKEN" '{}' >/dev/null
api POST "work/$WORK_ID/claim" "$WORKER_TOKEN" '{}' >/dev/null
api POST "work/$WORK_ID/workspace" "$WORKER_TOKEN" '{"epoch":1,"host":"exercise-host","path":"/srv/worktrees/chart","branch":"graphyard/chart-1"}' >/dev/null
api POST work "$OPERATOR_TOKEN" '{"title":"Backlog item","criteria":[{"id":"AC-1","text":"Waits","proofs":["unit:later"]}]}' >/dev/null
history() { api GET "events?work=$WORK_ID" "$OPERATOR_TOKEN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).map(e=>e.seq+':'+e.kind).join(',')"; }

step "3. Upgrading to $NEXT_REPOSITORY:$TAG; the migration hook runs before pods roll"
# The lease is renewed just before the upgrade so the rollout, not the clock, is what is judged.
api POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":1}' >/dev/null
BEFORE="$(api GET work "$OPERATOR_TOKEN" | projection)"
install_args upgrade "$NEXT_REPOSITORY"
same "2" "$(helm history "$RELEASE" --namespace "$NAMESPACE" -o json | node -p "const h=JSON.parse(require('fs').readFileSync(0,'utf8'));String(h.at(-1).revision)+(h.at(-1).status==='deployed'?'':'-'+h.at(-1).status)")" 'the upgrade did not deploy as revision 2'
same "$NEXT_REPOSITORY:$TAG" "$(k get deploy "$RELEASE-graphyard" -o jsonpath='{.spec.template.spec.containers[0].image}')" 'pods did not roll to the upgraded image'
forward
same "$BEFORE" "$(api GET work "$OPERATOR_TOKEN" | projection)" 'the ledger changed across the upgrade'
api POST "work/$WORK_ID/heartbeat" "$WORKER_TOKEN" '{"epoch":1}' >/dev/null
if curl -fsS -o /dev/null -X POST "http://127.0.0.1:14310/api/work/$WORK_ID/heartbeat" -H "Authorization: Bearer $WORKER_TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: stale-$RANDOM" --data '{"epoch":2}' 2>/dev/null; then echo 'a superseded epoch was accepted after the upgrade' >&2; exit 1; fi

step "4. Taking a logical backup with the chart's CronJob"
BEFORE_BACKUP="$(api GET work "$OPERATOR_TOKEN" | projection)"
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
same "[]" "$(api GET work "$OPERATOR_TOKEN")" 'the reinstalled release is not empty'

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
same "$BEFORE_BACKUP" "$(api GET work "$OPERATOR_TOKEN" | projection)" 'the restored ledger differs from the backup'
same "$HISTORY_BEFORE" "$(history)" 'history was not restored in order'
NEXT_KEY="$(api POST work "$OPERATOR_TOKEN" '{"title":"After restore","criteria":[{"id":"AC-1","text":"Continues","proofs":["unit:after"]}]}' | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).key")"
same "GY-3" "$NEXT_KEY" 'work numbering did not continue after the restored items'

step "Chart exercise passed: install, test, seed, upgrade, backup, loss, reinstall, restore"
