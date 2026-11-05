import type { PoolClient } from 'pg';
import type { Engine } from '../../engine.js';
import type { Observation, Principal, Work } from '../../model.js';
import type { Command } from './schemas.js';

/** What one command's handler reads: the authenticated caller, the validated input and the item inside the command's transaction. */
export interface Ctx { engine: Engine; db: PoolClient; actor: Principal; command: Command; id: string | null; data: any; work: Work; all: Work[]; now: Date; observation: Observation | null }
/** What a command prepares before its transaction opens: external reads stay outside it. */
export interface Prepare { engine: Engine; actor: Principal; id: string | null; key: string; data: any; context: { observation?: Observation } }
/**
 * One command in the table. `prepare` runs before the transaction and may return the control plane's
 * observation; `open` makes the item a command creates; `screen` and `operator` refuse before and
 * after the operator-agent authorization; `delivered` says the command is still accepted on a
 * delivered item, which it then neither evaluates nor wakes; `run` is the command's own change.
 */
export interface Entry {
  prepare?(p: Prepare): Promise<Observation | null | void>;
  open?(c: Omit<Ctx, 'work'> & { work?: Work }): Promise<Work>;
  screen?(c: Ctx): void;
  operator?(c: Ctx): void;
  delivered?(c: Ctx): boolean;
  run?(c: Ctx): Promise<void> | void;
}
