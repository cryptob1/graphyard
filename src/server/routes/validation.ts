import { gitLedger, importRun, readImports, sealImports } from '../../validation-import.js';
import { gitRunnerFor } from '../../merge-writer/local-observation.js';
import type { Engine } from '../../engine.js';
import { defineRoutes, parseJson } from '../routes.js';

/** The checkout the plane serves from, as the merge record and head observation read it. */
const checkoutGit = (engine: Engine) => engine.gitRunner ??= gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());

/** Deployment definitions and external reports survive the retired runner protocol. */
export const validationRoutes = defineRoutes('validation', [
  { method: 'POST', path: '/api/validation/define', handle: async context => context.services.validation.define(context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: '/api/validation/import', handle: async context => importRun({ store: context.services.engine.store, ledger: gitLedger(checkoutGit(context.services.engine)) }, context.actor, await parseJson(context, 11_200_000)) },
  { method: 'GET', path: /^\/api\/validation\/import\/([a-f0-9]{40})$/, handle: ({ services, url }, [sha]) => readImports({ store: services.engine.store }, sha, url.searchParams.get('candidate')) },
  { method: 'POST', path: /^\/api\/validation\/import\/([a-f0-9]{40})\/seal$/, handle: async (context, [sha]) => sealImports({ store: context.services.engine.store }, context.actor, sha, await parseJson(context, 10_000)) },
]);
