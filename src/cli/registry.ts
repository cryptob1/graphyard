import type { CliContext } from './context.js';

/**
 * One CLI command word and everything the launcher needs to know about it. A module
 * exports a list of these; the index concatenates the lists, prints the help text in
 * registry order, and dispatches on `name`. Adding a command means adding an entry to
 * one module (or a new module), never editing the dispatcher.
 */
export interface CliCommand {
  /** The first argv word this entry answers to. */
  name: string;
  /** Help lines exactly as `graphyard help` prints them, in registry order. */
  help: string[];
  /**
   * `work` commands name an existing work item as their first positional. The dispatcher
   * resolves it before `run`, and `unscoped` answers an invocation that names none.
   */
  scope?: 'work';
  unscoped?(context: CliContext): Promise<void>;
  /** The master and the host attestor never read the repository connection file. */
  readsConnection?(id: string | undefined): boolean;
  run(context: CliContext, work: any): Promise<void>;
}

/** Group a module's commands; a module is the unit a feature adds, so groups stay disjoint. */
export const defineCommands = (commands: CliCommand[]) => commands;

/** The `POST /api/work/:id/NAME` helper every work-scoped mutation uses. */
export const workMutation = (context: CliContext, work: { id: string }) => (name: string, data: unknown) => context.api(`work/${work.id}/${name}`, data);
