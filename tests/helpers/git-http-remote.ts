// Concern: a git remote served over token-authenticated smart HTTP on loopback (git http-backend
// behind a Basic-auth server), the fixture for the merge writer's https credentials (GY-3220, GY-3269).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/**
 * Serves PROJECT_ROOT over git smart HTTP on loopback, answering 401 unless the Basic password is
 * TOKEN. LOG collects each request line, so a test can prove no line holds the token.
 */
export async function serveGitHttp(projectRoot: string, token: string, log: string[]) {
  const server = createServer((request, response) => {
    log.push(`${request.method} ${request.url}`);
    const password = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':')[1];
    if (password !== token) { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end(); return; }
    const [path, query = ''] = request.url!.split('?');
    const cgi = spawn('git', ['http-backend'], { env: { PATH: process.env.PATH!, GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token', REQUEST_METHOD: request.method!, PATH_INFO: path, QUERY_STRING: query, CONTENT_TYPE: request.headers['content-type'] ?? '', ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}), ...(request.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] } : {}) } });
    request.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', chunk => chunks.push(chunk));
    cgi.on('close', () => {
      const output = Buffer.concat(chunks), split = output.indexOf('\r\n\r\n');
      const headers = Object.fromEntries(output.subarray(0, split).toString().split('\r\n').map(line => line.split(': ') as [string, string]));
      const { Status, ...rest } = headers;
      response.writeHead(Status ? Number(Status.split(' ')[0]) : 200, rest).end(output.subarray(split + 4));
    });
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/repo.git`, close: () => server.close() };
}
