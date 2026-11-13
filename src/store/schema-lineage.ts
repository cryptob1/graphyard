/**
 * The digest of every generation's table definitions, oldest first (GY-1961): generation N's
 * migration had digest `schemaGenerations[N]`; generations recorded before the lineage are null.
 * Every change to a table's DDL appends its digest here, so any DDL change is a newer generation
 * and a release refuses a database a newer definition migrated instead of re-applying its own
 * older DDL. `tests/schema-generation-guard.test.ts` fails, naming the digest to append, when
 * the code's definitions are not the newest entry. A generation also covers what a backup must
 * carry: backups record the generation they were taken at, so a restore into older code refuses.
 */
export const schemaGenerations: readonly (string | null)[] = [
  null, null, null, null,
  'sha256:59c9d79237ce1c121a492cbe90295cf29ccc925aa0e5b22e327b5503a4ac6e11',
  // GY-2010: the GitHub response cache, charge ledger and webhook receipt tables left the registry; existing databases keep them, unread.
  'sha256:bc04377e454f8a3c4945201349fd3c9d498e41ae9738b5e8ed59b99e9c7d3ee8',
  // GY-1984: the executor presence table left the registry with the executor fleet; existing databases keep it, unread.
  'sha256:34fae2ef3d8c7bdca6deb1125befb52554bc9d6fbbebec5f733815f8d043215f',
  // The webhook receipt table left the registry with the GitHub model; existing databases keep it, unread.
  'sha256:7de34c0370b76022eb3a031341cf39d6530a12c4985302dad97da7f5479ab8a9',
  // GY-2874: the settled-delivery SQL no longer reads the deleted containment quarantine.
  'sha256:e07c6de88732eb753880f822b11c8f41543f7f2817001cd65fec79b954f71281',
  // GY-2876: the flow analytics and proof grant tables left the registry, and the migration drops them.
  'sha256:74c1eb046c1959bdbd71f79b8f536fb3f3af2b042547aa13c5cb5ff26924ceb9',
  // GY-2989: the product review screenshots table.
  'sha256:dcefbd2e92eecbef78eb75f38e5798adcfaa3a228e7c8e59ddab7f4e95e02627',
  // GY-2986: a person's human: answer stays in the coordination view for its head whatever the base.
  'sha256:72e499b9d63b92e474fa67e9ba27b7b89db644b5f9e18d3adf9b911d4e364e06',
  // GY-3013: migrate retired document fields once instead of stripping them on reads and writes.
  'sha256:e9966540eb026ae6f07a7abbd5ceacfc8dd90ffe41f8adbbb1f965aacd70457b',
  // GY-3017: retire job holds, unused work-index columns and legacy observation tables.
  'sha256:d1fad9115075e03bf688396b51c2aa4470a2bd66c1e54138787ba0b33b43acbb',
  // GY-3035: indexed decision peers; unchanged peer columns do not lock live coordination writes.
  'sha256:718f3640a5d9356b5444e6e949a945fce073e547bb395212a9e745a663e7c2c4',
  // GY-3076: persist browser sign-in session digests across server restarts.
  'sha256:a0047ee2fd35c862cfd4e38f8bf33620933ea67ebe26f5092acca63f83eb9a5b',
  // GY-3088: the work index and work tables' session, queue and pane definitions.
  'sha256:661c3ea67aac115ddefbbbe929990108ae67c6a8f2bb22d34ce583be417b6274',
  // GY-3018: retire validation runner and attribution tables after sign-in and work-index updates.
  'sha256:a127cbeeb6417fece94948bf7e28c43443b9c1f66a39c2023d15779b9935e0d8',
  // GY-3095: repeats of one registry refusal counted beside its ledger row.
  'sha256:c15146d251fe89e369361909267ff9ec32bbdb7d5d78ec2c935047711038d410',
  // GY-3111: ledger compaction's saved cursor and the per-item delivery event index.
  'sha256:9a5c9509616909d7861dda1419ec1f51914c392097d5313bd06ae565c53fd248',
  // GY-3215: teammates the operator invited (team_members).
  'sha256:0161aa6cf3d5e2729cfe74ed8bb00596640b6185d0e51dc72ff4b3c77a22d6d0',
  // GY-3257: durable review/producer ledgers and dispatch cursor.
  'sha256:7e40bafabb2d9745ec219230a13720fb068698526ed76387d97b905680d40d54',
  // GY-3267: the merge trial's kept browser-case screenshots.
  'sha256:e90c91c8758dbce1c60a7a1222e98ece78afdf3dc01a60d33c2cd51ae02b49ac',
  // GY-3274: the dashboard's mirror of the product brief.
  'sha256:85493afad035ef44abc73d285087957a50ecd7b0645f115e74333d7cd0afe6c5',
  // GY-3289: the tokens each agent session's runtime reported.
  'sha256:ff55f5f332404411e10798d26670c4b1a2d1d7df4479b764446ef16047141a9b',
];
/** The schema generation the code in this process expects: its table definitions' place in the lineage. */
export const schemaVersion = schemaGenerations.length - 1;
