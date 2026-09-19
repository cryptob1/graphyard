import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { demand } from '../model.js';
import { Sent, defineRoutes } from './routes.js';

/** The built dashboard under dist/, with index.html standing in for client-side routes. */
export const staticRoutes = defineRoutes('static', [
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
