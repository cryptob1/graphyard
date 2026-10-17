import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { demand } from '../model.js';
import { Sent, defineRoutes } from './routes.js';
import { previewSitePathSchema, previewSiteUrl } from '../project-previews.js';

const plain = (res: ServerResponse, status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${text}\n`); return Sent; };

/**
 * The built dashboard under dist/, with index.html standing in for client-side routes; ahead of it,
 * an item's running preview (GY-1902, project-previews.ts) at `/preview/KEY/`: the built site the
 * loop published with its running record (item_preview_files), served from the server's own store,
 * so the link answers wherever the loop runs. `/preview/KEY` redirects to that directory URL, so the
 * site's relative assets and links resolve under it; a directory serves its index.html. The preview
 * is the change's own code, so it is served sandboxed: an opaque origin that cannot read the
 * dashboard's storage or call its API as the viewer. An item with no running preview answers 404.
 */
export const staticRoutes = defineRoutes('static', [
  {
    method: '*', path: /^\/preview\/([A-Za-z0-9._-]{1,100})(\/.*)?$/,
    async handle({ req, res, url, services }, [key, rest]) {
      demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed', 405);
      if (rest === undefined) { res.writeHead(308, { Location: `${previewSiteUrl(key!)}${url.search}` }); res.end(); return Sent; }
      const work = await services.engine.store.workDocument(key!), preview = work?.key === key ? work.preview : null;
      if (preview?.state !== 'running') return plain(res, 404, `${key} has no running preview`);
      let path: string;
      try { path = decodeURIComponent(rest.slice(1)); } catch { return plain(res, 400, 'Invalid path'); }
      const file = async (name: string) => (await services.engine.store.pool.query('SELECT media_type, bytes FROM item_preview_files WHERE preview_id=$1 AND path=$2', [preview.id, name])).rows[0] as { media_type: string; bytes: Buffer } | undefined;
      const wanted = path === '' || path.endsWith('/') ? `${path}index.html` : path;
      const found = previewSitePathSchema.safeParse(wanted).success ? await file(wanted) : undefined;
      if (!found) {
        // A directory named without its slash is redirected to it, as a static host does, so its relative links resolve under it.
        if (wanted === path && previewSitePathSchema.safeParse(`${path}/index.html`).success && await file(`${path}/index.html`)) { res.writeHead(308, { Location: `${url.pathname}/${url.search}` }); res.end(); return Sent; }
        return plain(res, 404, `${key}'s preview has no ${path || 'index.html'}`);
      }
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'none'");
      res.writeHead(200, { 'Content-Type': found.media_type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : found.bytes);
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
