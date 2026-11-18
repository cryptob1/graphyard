import { test } from 'node:test';
import { remotePostgresShard } from './helpers/remote-postgres-shard.js';

test('integration:remote-shard-nonroot-postgres — root refuses initdb; the non-root shard returns passing Postgres-backed records through the shim', { timeout: 660_000 }, remotePostgresShard);
