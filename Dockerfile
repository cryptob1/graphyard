# The Graphyard control-plane image.
#
# Built and published per release as REGISTRY/graphyard:VERSION by .github/workflows/release.yml,
# with the same bytes also addressable by immutable digest. The version and the Git revision
# are stamped into the image so a running deployment reports which release it serves at
# /healthz; the same values are OCI labels on the image itself.
#
#   docker build --build-arg GRAPHYARD_VERSION=0.1.0 --build-arg GRAPHYARD_BUILD_REVISION=$(git rev-parse HEAD) -t graphyard:0.1.0 .
ARG GRAPHYARD_VERSION=0.0.0-dev
ARG GRAPHYARD_BUILD_REVISION=unknown

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Private-root merge trials. Nested bwrap uses unprivileged user namespaces;
# no capabilities or host control sockets are supplied to this image.
FROM node:24-trixie-slim AS trial
# Reverts require merge-tree --merge-base (Git >= 2.43); trixie supplies it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/graphyard-browsers
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 python3-venv git ripgrep ca-certificates openssh-client && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/node /usr/bin/node && ln -s /usr/local/bin/npm /usr/bin/npm && ln -s /usr/local/bin/npx /usr/bin/npx \
    && touch /etc/graphyard-trial
# Independent exact-math producer dependencies, immutable to the unprivileged trial.
COPY benchmarks/hard-math/oracle/requirements.txt /opt/hard-math-requirements.txt
RUN python3 -m venv /opt/graphyard-hard-math-oracle \
    && /opt/graphyard-hard-math-oracle/bin/pip install --no-cache-dir -r /opt/hard-math-requirements.txt \
    && chmod -R a-w /opt/graphyard-hard-math-oracle
ENV HARD_MATH_PYTHON=/opt/graphyard-hard-math-oracle/bin/python
# Use the locked Playwright version for both Chromium and its Debian libraries.
# The browser is read-only image content; sessions keep their profiles in scratch.
RUN --mount=from=build,source=/app/node_modules,target=/opt/browser-dependencies/node_modules \
    PLAYWRIGHT_BROWSERS_PATH=/opt/graphyard-browsers node /opt/browser-dependencies/node_modules/playwright/cli.js install --with-deps chromium
# Native workspace-sandbox regression tool; no login or account is copied in.
RUN npm install --global @openai/codex@0.166.0
RUN find /usr/local/lib/node_modules/@openai -type f -name codex -exec ln -s '{}' /usr/local/bin/codex-linux-sandbox ';'
USER node

FROM node:24-bookworm-slim
ARG GRAPHYARD_VERSION
ARG GRAPHYARD_BUILD_REVISION
WORKDIR /app
ENV NODE_ENV=production
ENV GRAPHYARD_VERSION=${GRAPHYARD_VERSION}
ENV GRAPHYARD_BUILD_REVISION=${GRAPHYARD_BUILD_REVISION}
LABEL org.opencontainers.image.title="Graphyard" \
      org.opencontainers.image.description="Evidence-backed coordination for distributed software agents" \
      org.opencontainers.image.version="${GRAPHYARD_VERSION}" \
      org.opencontainers.image.revision="${GRAPHYARD_BUILD_REVISION}" \
      org.opencontainers.image.source="https://github.com/cryptob1/graphyard" \
      org.opencontainers.image.licenses="Apache-2.0"
# The land route fetches the base branch to judge a merge-writer landing (GY-1661), so the image carries git and openssh-client for SSH remotes.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src ./src
COPY bin ./bin
USER node
EXPOSE 4310
CMD ["npm", "start"]
