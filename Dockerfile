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
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src ./src
COPY bin ./bin
USER node
EXPOSE 4310
CMD ["npm", "start"]
