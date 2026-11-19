import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fakeNode = { ID: 'nFAKE123CNTRL', DNSName: 'yard.tail-test.ts.net.', TailscaleIPs: ['100.64.0.7', 'fd7a::7'], Online: true };

/**
 * A fake `tailscale` in DIR/bin, the only thing stubbed: `status --json` answers SELF, and the serve
 * config is DIR/serve.json, a port → target map that `serve --bg --http=PORT TARGET` writes as the real
 * command does. `serve status --json` reports it in Tailscale's own shape (TCP and Web), plus any https
 * mapping in DIR/served-https.json (`{ "8447": "http://127.0.0.1:4100" }`), as `serve --bg --https=8447` makes.
 * GY-3514: `funnel --bg --https=PORT TARGET` adds an https mapping that Funnel opens to the internet (AllowFunnel).
 */
export async function fakeTailscale(dir: string, self: object = fakeNode) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = path.join(__dirname, '..', 'serve.json'), https = path.join(__dirname, '..', 'served-https.json'), funnel = path.join(__dirname, '..', 'funnel.json'), log = path.join(__dirname, '..', 'calls.log');
const self = ${JSON.stringify(self)}, host = self.DNSName.replace(/\\.$/, '');
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const read = name => fs.existsSync(name) ? JSON.parse(fs.readFileSync(name, 'utf8')) : {};
const config = read(file);
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ Self: self })); process.exit(0); }
if (args[0] === 'serve' && args[1] === 'status') {
  const status = { TCP: {}, Web: {}, AllowFunnel: {} };
  for (const port of Object.keys(read(funnel))) status.AllowFunnel[host + ':' + port] = true;
  for (const [kind, ports] of [['HTTP', config], ['HTTPS', read(https)]]) for (const [port, target] of Object.entries(ports)) {
    status.TCP[port] = { [kind]: true };
    status.Web[host + ':' + port] = { Handlers: { '/': { Proxy: target } } };
  }
  process.stdout.write(JSON.stringify(status)); process.exit(0);
}
if (args[0] === 'funnel') {
  if (fs.existsSync(path.join(__dirname, '..', 'funnel-refused'))) process.exit(1);
  const port = /--https=(\\d+)/.exec(args.join(' '))[1], mappings = read(https), open = read(funnel);
  mappings[port] = args[args.length - 1]; open[port] = true;
  fs.writeFileSync(https, JSON.stringify(mappings)); fs.writeFileSync(funnel, JSON.stringify(open)); process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'reset') { fs.writeFileSync(file, '{}'); process.exit(0); }
if (args[0] === 'serve') { const port = /--http=(\\d+)/.exec(args.join(' '))[1]; config[port] = args[args.length - 1]; fs.writeFileSync(file, JSON.stringify(config)); process.exit(0); }
process.exit(1);
`;
  await writeFile(join(dir, 'bin', 'tailscale'), script);
  await chmod(join(dir, 'bin', 'tailscale'), 0o755);
  return join(dir, 'bin');
}

/** Puts BIN first on this process's PATH, as the host loop finds `tailscale`; returns the restore. */
export function onPath(bin: string) {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  return () => { process.env.PATH = previous; };
}
