import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { demand } from '../model.js';
import { Sent, defineRoutes } from './routes.js';

/** The longest preview response the server relays. */
export const previewResponseLimit = 50 * 1024 * 1024;
const plain = (res: ServerResponse, status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${text}\n`); return Sent; };

/**
 * The built dashboard under dist/, with index.html standing in for client-side routes; ahead of it,
 * an item's running preview (GY-1902, project-previews.ts) at `/preview/KEY`, relayed from the
 * loopback origin the loop serves it on. The preview is the change's own code, so it is served
 * sandboxed: an opaque origin that cannot read the dashboard's storage or call its API as the viewer.
 * An item with no running preview answers 404.
 */
export const staticRoutes = defineRoutes('static', [
  {
    method: '*', path: /^\/preview\/([A-Za-z0-9._-]{1,100})(\/.*)?$/,
    async handle({ req, res, url, services }, [key, rest]) {
      demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed', 405);
      const work = await services.engine.store.workDocument(key), preview = work?.key === key ? work.preview : null;
      if (preview?.state !== 'running' || !preview.origin) return plain(res, 404, `${key} has no running preview`);
      // Concatenated, never resolved: a `//host` path stays a path on the preview's own origin.
      const target = new URL(`${preview.origin}${rest ?? '/'}${url.search}`);
      if (target.origin !== preview.origin) return plain(res, 400, 'Invalid path');
      let upstream: Response;
      try { upstream = await fetch(target, { method: req.method, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
      catch { return plain(res, 502, `${key}'s preview is not answering`); }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > previewResponseLimit) return plain(res, 502, `${key}'s preview answered more than the relay carries`);
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'none'");
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return Sent;
    },
  },
  {
    method: '*', path: /^(?!\/api\/)/,
    async handle({ req, res, url }) {
      demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed', 405);
      const root = resolve('dist');
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      demand(path.startsWith(root + '/') || path === root, 'Invalid path', 400);
      let file: Buffer; let extension = extname(path);
      try { file = await readFile(path); } catch { file = await readFile(resolve(root, 'index.html')); extension = '.html'; }
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : file);
      return Sent;
    },
  },
]);
