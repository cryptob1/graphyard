#!/bin/sh
# One phase of one authorized attempt.
#
# The attestor constructs the entire container environment and passes exactly one
# argument, the phase. Everything that decides what runs is fixed here or comes from the
# read-only bundle mount, so there is no configuration surface for the runner account.
set -eu

# The attestor and the collector are separate identities that read this attempt's output
# through the boundary group. A stricter umask would leave both with EACCES on a report
# the run had already produced, which is a deployment fault rather than a test result.
umask 027

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'usage: graphyard-runner-phase enumerate|execute [ORACLE_DIR]' >&2
  exit 64
fi
phase="$1"
# The read-only bundle mount. The image entrypoint always uses the default; it is a
# parameter only so this script's phase handling can be exercised outside a container.
oracle="${2:-/oracle}"
reporter=/opt/graphyard-runner/reporter.ts
cli=/opt/graphyard-runner/node_modules/playwright/cli.js

if [ -z "${GRAPHYARD_REPORT_FILE:-}" ]; then
  echo 'GRAPHYARD_REPORT_FILE must name the report this phase writes' >&2
  exit 64
fi
# Each phase writes its report exactly once, into a boundary that was empty at preflight.
# Refusing an existing file here keeps a second invocation from being read as the first.
if [ -e "$GRAPHYARD_REPORT_FILE" ]; then
  echo 'The attempt boundary already holds this phase report' >&2
  exit 64
fi

config=''
for candidate in "$oracle/playwright.config.ts" "$oracle/playwright.config.js" "$oracle/playwright.config.mjs"; do
  if [ -f "$candidate" ]; then config="$candidate"; break; fi
done
if [ -z "$config" ]; then
  echo 'The approved oracle bundle must be mounted read-only at /oracle and carry a Playwright configuration' >&2
  exit 64
fi

case "$phase" in
  enumerate)
    # Offline. `--list` reports the declared suite without running a test body, so the
    # approved inventory cannot be shaped by the deployment under test.
    exec node "$cli" test --config "$config" --reporter "$reporter" --list
    ;;
  execute)
    if [ -z "${GRAPHYARD_TARGET_URL:-}" ]; then
      echo 'GRAPHYARD_TARGET_URL must name the approved target for the execute phase' >&2
      exit 64
    fi
    exec node "$cli" test --config "$config" --reporter "$reporter"
    ;;
  *)
    echo "Unknown attempt phase $phase" >&2
    exit 64
    ;;
esac
