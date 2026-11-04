import EmbeddedPostgres from 'embedded-postgres';
import { copyTemplateCluster, createMigratedDatabase, warmPassword, warmUser } from '../../src/e2e/warm-postgres.js';

/**
 * The suite's embedded Postgres (src/e2e/warm-postgres.ts): `initialise` copies the migrated
 * template cluster instead of running initdb, so a test file's cluster starts warm and with fsync
 * off. A cluster with another role, password or initdb flags is initialised cold, as before.
 * `createDatabase` still creates an empty database; `createMigratedDatabase` clones the template.
 */
export default class WarmPostgres extends EmbeddedPostgres {
  async initialise() {
    const { user, password, authMethod, initdbFlags, databaseDir, port } = this.options;
    if (user !== warmUser || password !== warmPassword || authMethod !== 'password' || initdbFlags.length) return super.initialise();
    await copyTemplateCluster(databaseDir, port);
  }

  /** A database holding the current schema, cloned from the cluster's migrated template. */
  async createMigratedDatabase(name: string) { await createMigratedDatabase(this.options.port, name); }
}
