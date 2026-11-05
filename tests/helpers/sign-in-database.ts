import { databaseUrl } from './postgres.js';
import { Store } from '../../src/store.js';

/** A private real database for session persistence tests, never an installation database. */
export async function signInDatabase() {
  const url = await databaseUrl('signin');
  const store = new Store(url); await store.init();
  return { store, url, close: () => store.close() };
}
