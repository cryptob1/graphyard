import EmbeddedPostgres from './warm-postgres.js';
import { Store } from '../../src/store.js';
import { temporaryDirectory } from './temp-dirs.js';

/** A private real database for session persistence tests, never an installation database. */
export async function signInDatabase(offset = 3076) {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + offset;
  const pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('sign-in-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('signin');
  const url = `postgres://graphyard:testing-only@127.0.0.1:${port}/signin`;
  const store = new Store(url); await store.init();
  return { store, url, close: async () => { await store.close(); await pg.stop(); } };
}
