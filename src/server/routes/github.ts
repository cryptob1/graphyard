import { createHmac, timingSafeEqual } from 'node:crypto';
import { demand } from '../../model.js';
import { defineRoutes } from '../routes.js';

/** GitHub webhook: HMAC-verified, deduplicated in Postgres, wakes the durable jobs. */
export const githubRoutes = defineRoutes('github', [
  {
    method: 'POST', path: '/api/github/webhook',
    async handle(context) {
      const { req, services: { engine, github } } = context;
      const raw = await context.body(); const secret = process.env.GITHUB_WEBHOOK_SECRET;
      demand(secret, 'Webhook not configured', 503);
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
      const actual = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
      demand(expected.length === actual.length && timingSafeEqual(expected, actual), 'Invalid webhook signature', 401);
      const payload = JSON.parse(raw.toString());
      demand(payload.repository?.full_name?.toLowerCase() === github?.config.repository.toLowerCase(), 'Repository is not managed', 403);
      // Our own check publications must not create an endless webhook/publish loop.
      if (payload.check_run?.app?.id === github?.config.appId) return context.send(202, { accepted: true, ignored: 'own check' });
      const delivery = String(req.headers['x-github-delivery'] ?? ''); demand(delivery && delivery.length < 200, 'Missing delivery ID', 400);
      await engine.store.transaction(async db => {
        const result = await db.query('INSERT INTO webhook_receipts(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [delivery]);
        if (result.rowCount) await db.query('UPDATE jobs SET available_at=now(),generation=generation+1');
      });
      return context.send(202, { accepted: true });
    },
  },
]);
