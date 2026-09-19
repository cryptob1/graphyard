import { Sent, defineRoutes, parseJson } from '../routes.js';

/** The validation runner protocol: artifacts, definitions, candidates, attempts and commands. */
export const validationRoutes = defineRoutes('validation', [
  { method: 'POST', path: '/api/validation/artifacts', handle: async context => context.services.validation.uploadArtifact(context.actor, await parseJson(context, 11_200_000), context.idempotencyKey()) },
  {
    method: 'GET', path: /^\/api\/validation\/artifacts\/([^/]+)\/([^/]+)$/,
    async handle({ actor, res, url, services }, [requestId, artifactId]) {
      const artifact = await services.validation.readArtifact(actor, requestId, artifactId);
      const safePreview = artifact.bytes.length <= 1_000_000 && (artifact.mediaType === 'image/png' || artifact.mediaType === 'application/json' || artifact.mediaType === 'text/plain');
      const preview = url.searchParams.get('preview') === '1' && safePreview;
      const filename = artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'graphyard-artifact';
      res.writeHead(200, { 'Content-Type': preview ? artifact.mediaType : 'application/octet-stream', 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${filename}"`, 'Content-Length': artifact.bytes.length,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' });
      res.end(artifact.bytes);
      return Sent;
    },
  },
  { method: 'GET', path: '/api/validation', handle: ({ url, services }) => services.validation.list(url.searchParams.get('cursor') ?? undefined) },
  { method: 'GET', path: '/api/validation/definitions', handle: ({ url, services }) => services.validation.definitions(url.searchParams.get('cursor') ?? undefined) },
  { method: 'GET', path: /^\/api\/validation\/candidate\/([^/]+)$/, handle: ({ services }, [id]) => services.validation.readCandidate(id) },
  // The host attestor's independent read of what it is about to execute. Read-only,
  // and refused to the worker and producer credentials that run and collect.
  { method: 'GET', path: /^\/api\/validation\/attempt\/([^/]+)$/, handle: ({ actor, services }, [id]) => services.validation.attemptAuthority(actor, id) },
  {
    method: 'POST', path: /^\/api\/validation\/(define|build|candidate|request|dispatch|ack|heartbeat|collection-authority|collection-heartbeat|result|cancel|settle|retry)$/,
    async handle(context, [command]) {
      const { actor, services: { validation } } = context;
      const data = await parseJson(context), key = context.idempotencyKey();
      return command === 'define' ? validation.define(actor, data, key)
        : command === 'build' ? validation.attestBuild(actor, data, key)
        : command === 'candidate' ? validation.createCandidate(actor, data, key)
        : command === 'request' ? validation.createRequest(actor, data, key)
        : command === 'dispatch' ? validation.dispatch(actor, data, key)
        : command === 'result' ? validation.result(actor, data, key)
        : command === 'ack' || command === 'heartbeat' ? validation.runnerCommand(actor, command, data, key)
        : command === 'collection-heartbeat' ? validation.collectionHeartbeat(actor, data, key)
        : command === 'collection-authority' ? validation.collectionAuthority(actor, data)
        : validation.operatorCommand(actor, command as 'cancel' | 'settle' | 'retry', data, key);
    },
  },
]);
