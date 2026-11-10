// GY-3201, GY-3245: the fixture node application, started on the PORT Graphyard gives it. Its page
// shows the change's title; a change titled "broken" breaks it, so its bound case fails.
import { createServer } from 'node:http';
const title = (process.env.GRAPHYARD_PREVIEW_TITLE ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const page = /broken/i.test(title) ? '<h1>Out of order</h1>' : `<h1>Fixture node app</h1>\n<p>${title}</p>`;
createServer((request, response) => {
  // GY-3223: the app answers the commit it serves at its declared versionPath; its /healthz names none.
  if (request.url === '/api/meta/version') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ version: process.env.GRAPHYARD_PREVIEW_SHA })); }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<!doctype html><title>Node fixture</title>\n${page}\n`);
}).listen(Number(process.env.PORT), '127.0.0.1');
