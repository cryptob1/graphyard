import { defineCommands } from './registry.js';
import { addHost, readHosts, removeHost } from '../hosts.js';

/** GY-3407: watch a spare machine. Work does not run there yet. The host needs Docker, Tailscale and this machine's SSH key; nothing is installed on it. */
export const hostCommands = defineCommands([{
  name: 'host',
  help: [
    '  host add USER@HOST            Check Docker over SSH and record the host (no work runs there yet); the loop',
    '                                reads it each cycle and Workers lists it (away when unreachable)',
    '  host remove USER@HOST         Stop reading the host',
    '  host list                     The recorded hosts',
  ],
  readsConnection: () => false,
  async run(context) {
    const [target] = context.args;
    if (context.id === 'add' && target) {
      const result = await addHost(target);
      console.log(result.added ? `Added ${target}: ${result.probe!.cores ?? '?'} cores, Docker answers. Workers lists it from the loop's next cycle; work still runs on this machine.` : `${target} is already added.`);
    } else if (context.id === 'remove' && target) {
      console.log((await removeHost(target)).removed ? `Removed ${target}.` : `${target} was not added.`);
    } else if (context.id === 'list' || !context.id) {
      const hosts = await readHosts();
      console.log(hosts.length ? hosts.map(host => `${host.target}  added ${host.addedAt}`).join('\n') : 'No host added: this machine runs all work. Add one with graphyard host add USER@HOST.');
    } else throw new Error('Usage: graphyard host add USER@HOST | host remove USER@HOST | host list');
  },
}]);
