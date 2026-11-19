import { request } from 'node:http';

export type SocketReply = { status: number; body: any };
/** GY-3486: a request as tailscaled makes it on an install's serve socket: Tailscale's own identity header, no bearer token. */
export const viaSocket = (socketPath: string, path: string, login: string, body?: unknown) => new Promise<SocketReply>((resolve, reject) => {
  const req = request({ socketPath, path, method: body === undefined ? 'GET' : 'POST', headers: { Host: 'yard.tail-test.ts.net', 'Tailscale-User-Login': login, 'Content-Type': 'application/json' } }, res => {
    let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null }));
  });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});
