import { request } from 'node:http';

/** One request to a loopback server with the headers given verbatim, Host included (fetch cannot set Host). */
export function localRequest(url: string, path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: any }>((resolve, reject) => {
    const sent = request({ hostname, port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    sent.on('error', reject);
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
