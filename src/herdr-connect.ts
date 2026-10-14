import type { PaneServer } from './model/setup-checklist.js';

// The commands that open an install's agents in Herdr (GY-1511), shared by `graphyard up`, master
// status, host installs and the dashboard's Setup page. Pure: the page bundles it.

export type HerdrWatch = PaneServer;
const shellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** Where a remote command names a host it does not know: the operator puts their own in. */
export const herdrHostPlaceholder = 'HOST';
/**
 * On this host, through SSH, and through Herdr's own remote attach. Its own instance is attached by
 * its XDG_CONFIG_HOME and session name; the default instance by plain `herdr`.
 */
export function herdrConnectCommands(watch: Pick<HerdrWatch, 'configHome' | 'session' | 'host'>) {
  const host = shellWord(watch.host ?? herdrHostPlaceholder);
  const own = watch.configHome && watch.session ? { configHome: watch.configHome, session: watch.session } : null;
  const local = own ? `XDG_CONFIG_HOME=${shellWord(own.configHome)} herdr session attach ${shellWord(own.session)}` : 'herdr';
  return { local, ssh: `ssh -t ${host} ${shellWord(local)}`, remote: own ? `herdr --remote ${host} --session ${shellWord(own.session)}` : `herdr --remote ${host}` };
}
