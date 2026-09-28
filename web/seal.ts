/**
 * Seal a pasted credential to an agent host's public key, in the browser, before it is ever sent
 * (GY-409): an ephemeral ECDH P-256 key, an HKDF-SHA256 over the shared secret salted with the
 * host key itself, and AES-256-GCM with the authentication tag appended. The control plane in
 * between stores and relays ciphertext only; the host's executor opens the payload with the
 * private half that never left it (src/master/environments.ts, `unsealToHost`).
 */
export interface SealedKey { ephemeral: string; iv: string; ciphertext: string }

const bytesToBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const encoder = new TextEncoder();

export async function sealForHost(hostPublicKey: string, plaintext: string): Promise<SealedKey> {
  const subtle = globalThis.crypto.subtle;
  const hostSpki = Uint8Array.from(atob(hostPublicKey), character => character.charCodeAt(0));
  const hostKey = await subtle.importKey('spki', hostSpki as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: hostKey }, ephemeral.privateKey, 256);
  const salt = await subtle.digest('SHA-256', hostSpki as BufferSource);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: encoder.encode('graphyard connect-account v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encoder.encode(plaintext)));
  const ephemeralSpki = new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey));
  return { ephemeral: bytesToBase64(ephemeralSpki), iv: bytesToBase64(iv), ciphertext: bytesToBase64(sealed) };
}
