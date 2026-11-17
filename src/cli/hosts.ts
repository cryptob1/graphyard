import { defineCommands } from './registry.js';
import { addHost, hostPrepareScript, localPublicKey, readHosts, removeHost } from '../hosts.js';

/** GY-3407: lend a spare machine's compute, nothing else; merge trials send it test shards (GY-3412). */
export const hostCommands = defineCommands([{
  name: 'host',
  help: [
    '  host prepare                  Print the one-time sudo script for a host: an unprivileged gy-compute user',
    '                                with rootless Docker, whose key may only run graphyard-host-shim',
    '  host add USER@HOST            Check the host answers only through the shim, as neither root nor the',
    '                                docker group, and record it; Workers lists it (away when unreachable)',
    '  host remove USER@HOST         Stop reading the host',
    '  host list                     The recorded hosts',
  ],
  readsConnection: () => false,
  async run(context) {
    const [target] = context.args;
    if (context.id === 'prepare') {
      process.stdout.write(hostPrepareScript(await localPublicKey()));
    } else if (context.id === 'add' && target) {
      const result = await addHost(target);
      console.log(result.added ? `Added ${target}: ${result.probe?.cores ?? '?'} cores, rootless Docker answers through the shim. Workers lists it from the loop's next cycle, and merge trials send it test shards.` : `${target} is already added.`);
    } else if (context.id === 'remove' && target) {
      console.log((await removeHost(target)).removed ? `Removed ${target}.` : `${target} was not added.`);
    } else if (context.id === 'list' || !context.id) {
      const hosts = await readHosts();
      console.log(hosts.length ? hosts.map(host => `${host.target}  added ${host.addedAt}`).join('\n') : 'No host added: this machine runs all work. Prepare one with graphyard host prepare, then graphyard host add gy-compute@HOST.');
    } else throw new Error('Usage: graphyard host prepare | host add USER@HOST | host remove USER@HOST | host list');
  },
}]);
