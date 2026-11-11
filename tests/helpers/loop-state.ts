import { test as nodeTest, after } from 'node:test';
import { loopStateContext } from '../../src/loop-state.js';
import { storedLoopState } from '../../src/server/loop-state.js';
import { withDatabase } from './postgres.js';

// Launcher fixtures still stub runtimes, but their ledger uses an isolated real Postgres database.
let database: ReturnType<typeof withDatabase> | undefined;
const store = () => database ??= withDatabase('loop_state_fixture').then(async store => { await store.init(); return store; });
after(async () => { if (database) await (await database).close(); });
export const test: typeof nodeTest = ((...args: any[]) => {
  const fn = args.at(-1);
  if (typeof fn === 'function') args[args.length - 1] = (...context: any[]) => loopStateContext.run(scope => ({
    read: async kind => storedLoopState(await store(), { id: 'fixture-coordinator', role: 'coordinator' }, scope).read(kind),
    write: async (kind, records, removed, migrate) => storedLoopState(await store(), { id: 'fixture-coordinator', role: 'coordinator' }, scope).write(kind, records, removed, migrate),
  }), () => fn(...context));
  return (nodeTest as any)(...args);
}) as typeof nodeTest;
