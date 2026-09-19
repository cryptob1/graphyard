import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { demand } from './model.js';

/**
 * Where private artifact bytes live. The built-in backend is the Postgres row itself; an
 * external backend holds the bytes at a location Graphyard chose, keyed by request, attempt
 * and name, while authorization, digests, retention and audit stay in Graphyard whatever the
 * backend. A backend never decides who may read: it moves bytes for a caller that has
 * already been authorized inside a coordination transaction, and it is only ever called
 * outside one.
 *
 * `put` must verify the stored bytes against what it sent (S3 returns the MD5 ETag of a
 * single-part upload); a `put` that resolves is a claim that the location holds exactly
 * these bytes, which the expiry sweep, migration and every read still re-verify by digest.
 * `delete` must be idempotent and `exists` must answer from the store, so deletion is
 * verified rather than assumed.
 */
export interface ArtifactBackend {
  readonly kind: 's3';
  readonly label: string;
  put(location: string, bytes: Buffer, mediaType: string): Promise<void>;
  get(location: string): Promise<Buffer | null>;
  delete(location: string): Promise<void>;
  exists(location: string): Promise<boolean>;
}

export const s3ConfigSchema = z.object({
  endpoint: z.url().max(2000).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'The S3 endpoint must be an HTTP(S) origin without credentials'),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  region: z.string().regex(/^[a-z0-9-]{1,40}$/),
  accessKeyId: z.string().min(1).max(200),
  secretAccessKey: z.string().min(1).max(500),
  prefix: z.string().max(200).regex(/^[a-zA-Z0-9._/-]*$/).default(''),
}).strict();
export type S3Config = z.infer<typeof s3ConfigSchema>;

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
/** RFC 3986 encoding of one path segment, as SigV4 canonicalizes it. */
const encodeSegment = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * An S3-compatible object store reached through path-style requests signed with SigV4. No
 * SDK: the four operations this backend needs are one signed request each, and a dependency
 * that could pull credentials from the ambient environment is exactly what this process must
 * not do — the only credential it uses is the one the operator configured for artifacts.
 */
export class S3ArtifactBackend implements ArtifactBackend {
  readonly kind = 's3' as const;
  readonly label: string;
  constructor(readonly config: S3Config, private readonly fetcher: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {
    this.label = `s3 ${new URL(config.endpoint).host}/${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`;
  }
  private key(location: string) { return this.config.prefix ? `${this.config.prefix.replace(/\/+$/, '')}/${location}` : location; }
  /** Sign one request. The payload hash binds the body, so a proxy cannot swap the bytes without breaking the signature. */
  sign(method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', location: string, body: Buffer | null, mediaType?: string) {
    const url = new URL(this.config.endpoint);
    const path = `/${[this.config.bucket, ...this.key(location).split('/')].map(encodeSegment).join('/')}`;
    const now = this.clock(), amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), date = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (body) { headers['content-length'] = String(body.length); headers['content-md5'] = createHash('md5').update(body).digest('base64'); }
    if (mediaType) headers['content-type'] = mediaType;
    const signed = Object.keys(headers).sort();
    const canonical = [method, path, '', ...signed.map(name => `${name}:${headers[name].trim()}`), '', signed.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, date), this.config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const { host: _host, ...sendable } = headers;
    const authorized: Record<string, string> = { ...sendable, Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` };
    return { url: `${url.origin}${path}`, headers: authorized };
  }
  private async request(method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', location: string, body: Buffer | null = null, mediaType?: string) {
    const { url, headers } = this.sign(method, location, body, mediaType);
    return this.fetcher(url, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  }
  async put(location: string, bytes: Buffer, mediaType: string) {
    const response = await this.request('PUT', location, bytes, mediaType);
    demand(response.ok, `Artifact store refused the upload (${response.status})`, 503);
    // A single-part upload's ETag is the MD5 of the stored bytes: the store's own statement of what it kept.
    const etag = (response.headers.get('etag') ?? '').replace(/"/g, '').toLowerCase();
    demand(etag === createHash('md5').update(bytes).digest('hex'), 'Artifact store acknowledged different bytes than were sent', 503);
  }
  async get(location: string) {
    const response = await this.request('GET', location);
    if (response.status === 404) return null;
    demand(response.ok, `Artifact store refused the read (${response.status})`, 503);
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(location: string) {
    const response = await this.request('DELETE', location);
    demand(response.ok || response.status === 404, `Artifact store refused the deletion (${response.status})`, 503);
  }
  async exists(location: string) {
    const response = await this.request('HEAD', location);
    if (response.status === 404) return false;
    demand(response.ok, `Artifact store refused the existence check (${response.status})`, 503);
    return true;
  }
}

/** Artifact storage configuration from the environment. Absent, the Postgres row remains the backend. */
export function artifactBackendFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactBackend | null {
  const kind = env.GRAPHYARD_ARTIFACT_BACKEND ?? 'postgres';
  if (kind === 'postgres') return null;
  demand(kind === 's3', `Unsupported artifact backend ${kind}; use postgres or s3`);
  const config = s3ConfigSchema.parse({ endpoint: env.GRAPHYARD_ARTIFACT_S3_ENDPOINT, bucket: env.GRAPHYARD_ARTIFACT_S3_BUCKET, region: env.GRAPHYARD_ARTIFACT_S3_REGION ?? 'us-east-1',
    accessKeyId: env.GRAPHYARD_ARTIFACT_S3_ACCESS_KEY_ID, secretAccessKey: env.GRAPHYARD_ARTIFACT_S3_SECRET_ACCESS_KEY, ...(env.GRAPHYARD_ARTIFACT_S3_PREFIX ? { prefix: env.GRAPHYARD_ARTIFACT_S3_PREFIX } : {}) });
  return new S3ArtifactBackend(config);
}
export function artifactCapacityFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.GRAPHYARD_ARTIFACT_CAPACITY_BYTES;
  if (raw === undefined) return defaultArtifactCapacityBytes;
  const value = Number(raw);
  demand(Number.isInteger(value) && value >= 8_388_608, 'GRAPHYARD_ARTIFACT_CAPACITY_BYTES must be an integer of at least 8 MiB');
  return value;
}
/** Two GiB of retained artifact bytes before uploads refuse with a visible capacity state. */
export const defaultArtifactCapacityBytes = 2 * 1024 ** 3;
