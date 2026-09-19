# The approved Playwright runner image.
#
# This is the "pinned runner image" the whole packaged path refers to: the browsers, the
# Playwright runtime and the Graphyard reporter all live here, and the operator approves
# them once, by digest, with `validation define`. The oracle bundle is mounted read-only
# at /oracle and supplies only the reviewed assertions and their Playwright configuration.
# Nothing is installed, resolved or transpiled from that mount, so candidate-authored
# bytes cannot choose the runtime, the browser or the reporter that describes the run.
#
#   docker build -f docker/runner/Dockerfile -t REGISTRY/graphyard-runner:VERSION .
#   docker push REGISTRY/graphyard-runner:VERSION
#
# Publish it, then pin the pushed manifest digest as `runnerImageDigest`. The tag is a
# convenience; only the digest is authority, and every attempt runs REPOSITORY@sha256:...
#
# Keep PLAYWRIGHT_VERSION identical to the `@playwright/test` version this repository
# pins: the base image carries the browser builds that exact release expects.
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

ENV NODE_ENV=production
WORKDIR /opt/graphyard-runner

# The runtime the phases execute. `/node_modules` makes it resolvable from the bundle's
# own specs without NODE_PATH or NODE_OPTIONS — both are refused at the container
# boundary precisely because they redirect module resolution.
RUN npm install --omit=dev --no-save --no-package-lock "@playwright/test@${PLAYWRIGHT_VERSION}" \
  && npm cache clean --force \
  && ln -s /opt/graphyard-runner/node_modules /node_modules \
  && test -f /opt/graphyard-runner/node_modules/playwright/cli.js

# Built into the image, never loaded from candidate code. Playwright transpiles it itself,
# writing its transform cache under TMPDIR, which the attempt's tmpfs scratch provides.
COPY src/playwright-reporter.ts ./reporter.ts
COPY docker/runner/entrypoint.sh /usr/local/bin/graphyard-runner-phase
RUN chmod 0444 ./reporter.ts && chmod 0555 /usr/local/bin/graphyard-runner-phase

# The attestor passes exactly one argument: the phase. It also supplies `--user`, so no
# USER is set here; the image must run as whatever unprivileged account the deployment's
# `runAsUser` names, and it needs no account of its own in /etc/passwd.
ENTRYPOINT ["/usr/local/bin/graphyard-runner-phase"]
