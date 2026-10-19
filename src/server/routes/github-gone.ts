// Concern: GY-2010 — the GitHub webhook and App routes are gone; answer 404 without asking for a bearer token.
import { defineRoutes } from '../routes.js';

/** Public stubs so `/api/github/*` is 404, not 401 from the authenticated API gate. */
export const githubGoneRoutes = defineRoutes('github-gone', [
  {
    method: 'POST', path: '/api/github/webhook',
    async handle({ send }) { return send(404, { error: 'GitHub webhooks are removed; the merge writer uses the deploy key' }); },
  },
  {
    method: 'GET', path: '/api/github/installation',
    async handle({ send }) { return send(404, { error: 'GitHub App installation status is removed' }); },
  },
  {
    method: 'POST', path: '/api/github/installation',
    async handle({ send }) { return send(404, { error: 'GitHub App installation status is removed' }); },
  },
]);
