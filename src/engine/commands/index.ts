import type { Command } from './schemas.js';
import type { Entry } from './types.js';
import * as blocked from './blocked.js';
import * as claim from './claim.js';
import * as create from './create.js';
import * as defer from './defer.js';
import * as evidence from './evidence.js';
import * as heartbeat from './heartbeat.js';
import * as hold from './hold.js';
import * as message from './message.js';
import * as priority from './priority.js';
import * as ready from './ready.js';
import * as reading from './reading.js';
import * as release from './release.js';
import * as request from './request.js';
import * as requirements from './requirements.js';
import * as revoke from './revoke.js';
import * as rework from './rework.js';
import * as session from './session.js';
import * as submit from './submit.js';
import * as unblock from './unblock.js';
import * as windowCommand from './window.js';
import * as workspace from './workspace.js';

/** Every command, one entry each. `run.ts` wraps them all in the same receipt, authorization and save. */
export const table: Record<Command, Entry> = {
  create, ready, priority, requirements, unblock, rework, claim, heartbeat, release, workspace, submit, blocked, defer,
  window: windowCommand, hold, message, evidence, reading, revoke, session, request,
};
