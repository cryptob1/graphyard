import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const verificationRequestTimeoutMs = 60 * 60_000;

/** The host trial can take 55 minutes. Node fetch's header deadline is shorter,
 * so this request uses HTTP directly, bounded by one signal through the body. */
export function verificationRequest(url: string, request: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  const signal = AbortSignal.timeout(verificationRequestTimeoutMs);
  return new Promise((resolve, reject) => {
    let receivedHeaders = false;
    const fail = (error: Error) => reject(signal.aborted
      ? new Error(`Worker verification timed out at ${url} after 60 minutes`, { cause: error })
      : receivedHeaders ? error : new TypeError('fetch failed', { cause: error }));
    const req = (new URL(url).protocol === 'https:' ? httpsRequest : httpRequest)(url, { ...request, signal }, res => {
      receivedHeaders = true;
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('error', fail);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    });
    req.on('error', fail);
    req.end(request.body);
  });
}
