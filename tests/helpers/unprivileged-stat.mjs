// A simulated worker sandbox for the suite (GY-966). Under bubblewrap, and any user namespace
// that maps only the session's own account, a directory owned by an unmapped account — root's
// /tmp and /home above all — stats as the overflow uid 65534. The host attestor refuses every
// oracle bundle and collection boundary whose ancestry such an account owns, so the tests that
// drive it take their environment-conditional branch there.
//
//   node --import ./tests/helpers/unprivileged-stat.mjs --import tsx --test tests/cli.test.ts
//
// Loaded with --import (NODE_OPTIONS reaches every child, the attestor included), it makes /tmp,
// /home and the process's temporary directory stat as uid and gid 65534, exactly as that
// sandbox does, so the conditional branch is exercised on any host, not only inside one.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const overflowId = 65534;
const unmapped = new Set(['/tmp', '/home', fs.realpathSync(tmpdir())]);
const target = path => typeof path === 'string' || path instanceof URL || Buffer.isBuffer(path)
  ? resolve(path instanceof URL ? path.pathname : String(path)) : '';
const unprivileged = (path, info) => {
  if (info && unmapped.has(target(path))) {
    const id = typeof info.uid === 'bigint' ? BigInt(overflowId) : overflowId;
    info.uid = id; info.gid = id;
  }
  return info;
};

for (const name of ['stat', 'lstat']) {
  const promised = fs.promises[name], synchronous = fs[`${name}Sync`], callback = fs[name];
  fs.promises[name] = async (path, ...rest) => unprivileged(path, await promised(path, ...rest));
  fs[`${name}Sync`] = (path, ...rest) => unprivileged(path, synchronous(path, ...rest));
  fs[name] = (path, ...rest) => {
    const done = rest.pop();
    callback(path, ...rest, (error, info) => done(error, error ? info : unprivileged(path, info)));
  };
}
// Named ESM imports of node:fs and node:fs/promises are bound to the builtin's exports; this
// rebinds them to the wrappers above.
syncBuiltinESMExports();
