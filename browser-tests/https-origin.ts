import { generateKeyPairSync, sign } from 'node:crypto';
import { connect } from 'node:net';
import { createServer } from 'node:tls';

/** DER's one form a minimal certificate needs: [tag][length][content]. */
const element = (tag: number, ...body: Buffer[]): Buffer => {
  const content = Buffer.concat(body);
  let size = Buffer.of(content.length);
  if (content.length >= 128) {
    const octets: number[] = [];
    for (let length = content.length; length > 0; length = Math.floor(length / 256)) octets.unshift(length % 256);
    size = Buffer.of(0x80 | octets.length, ...octets);
  }
  return Buffer.concat([Buffer.of(tag), size, content]);
};
const sequence = (...parts: Buffer[]) => element(0x30, ...parts);
const objectIdentifier = (dotted: string) => {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  return element(0x06, Buffer.of(first! * 40 + second!, ...rest.flatMap(value => {
    const groups = [value % 128];
    for (let higher = Math.floor(value / 128); higher > 0; higher = Math.floor(higher / 128)) groups.unshift(higher % 128 | 128);
    return groups;
  })));
};
/** UTCTime — YYMMDDHHMMSSZ — the twelve digits an ISO timestamp holds before its fraction. */
const utc = (shiftDays: number) => element(0x17, Buffer.from(`${new Date(Date.now() + shiftDays * 86_400_000).toISOString().slice(2, 19).replace(/\D/g, '')}Z`));

/**
 * A throwaway self-signed certificate for HOST, written with the standard library alone: the suite's
 * HTTPS origin needs a key pair, and no committed fixture may hold one — the secret scan rejects a
 * key in Git, and a generated key is never a secret worth keeping anywhere.
 */
const selfSigned = (host: string): { key: string; cert: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const name = sequence(element(0x31, sequence(objectIdentifier('2.5.4.3'), element(0x0C, Buffer.from(host)))));
  // v3, serial 1, the issuer is its own subject, valid a day either side of now, one dNSName.
  const tbs = sequence(element(0xA0, element(0x02, Buffer.of(2))), element(0x02, Buffer.of(1)), ecdsaWithSha256, name,
    sequence(utc(-1), utc(1)), name, publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    element(0xA3, sequence(sequence(objectIdentifier('2.5.29.17'), element(0x04, sequence(element(0x82, Buffer.from(host))))))));
  const certificate = sequence(tbs, ecdsaWithSha256, element(0x03, Buffer.of(0), sign('sha256', tbs, privateKey)));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: `-----BEGIN CERTIFICATE-----\n${(certificate.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
};

/**
 * Serves UPSTREAM under HTTPS on HOST, terminating TLS in front of the control plane as
 * `tailscale serve` does on the host the owner reaches, with a certificate made here at runtime.
 */
export const httpsFront = async (upstream: string, host: string): Promise<{ origin: string; close(): void }> => {
  const front = createServer(selfSigned(host), socket => {
    const backend = connect(Number(new URL(upstream).port), '127.0.0.1');
    socket.pipe(backend); backend.pipe(socket);
    socket.on('error', () => backend.destroy()); backend.on('error', () => socket.destroy());
  });
  await new Promise<void>(done => front.listen(0, '127.0.0.1', done));
  return { origin: `https://${host}:${(front.address() as { port: number }).port}`, close: () => front.close() };
};
