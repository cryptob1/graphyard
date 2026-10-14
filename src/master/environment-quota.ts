// Concern: one agent environment's provider login and quota — the per-provider probes that read them, and one shared plan's cached reading.
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getCachedPlanUsage, parseZaiUsage, setCachedPlanUsage, type ProviderUsageResult } from '../provider-usage.js';
import type { AccountUsage, EnvironmentProbe, ProbedEnvironment } from './environments.js';
import type { AgentEnvironment } from './profiles.js';

/** One reading of a shared plan's quota, with the limit flag its provider reported (GY-1260). */
export type PlanReading = ProviderUsageResult & { reached?: boolean };

export async function readJsonFile(file: string): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
export const windowName = (minutes: number) => minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

// Claude Code keeps its subscription login in the environment's .credentials.json. The usage the
// provider meters against it is read from the same endpoint Claude Code's /usage reads; the token
// is sent only to its own provider and never leaves this function. An account connected with a
// pasted API key (GY-409) holds it in the environment's settings.json instead, which is a login
// the health probe recognises even though no usage endpoint stands behind it.
export async function claudeAccount(environment: AgentEnvironment, probe: EnvironmentProbe, now: number) {
  const oauth = (await readJsonFile(resolve(environment.home, '.credentials.json')))?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || !(oauth.accessToken || oauth.refreshToken)) {
    const settings = await readJsonFile(resolve(environment.home, 'settings.json'));
    if (typeof settings?.env?.ANTHROPIC_API_KEY === 'string' && settings.env.ANTHROPIC_API_KEY) return { loggedIn: true, usage: [], note: 'an API-key account: the provider exposes no usage Graphyard can read' };
    return { loggedIn: false, usage: [], note: null };
  }
  if (probe.quota === false) return { loggedIn: true, usage: [], note: 'quota not read' };
  if (typeof oauth.accessToken !== 'string' || typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return { loggedIn: true, usage: [], note: 'the stored access token has expired; Claude Code refreshes it at launch, so quota is read on the next check' };
  try {
    const response = await (probe.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(probe.timeoutMs ?? 5_000) });
    if (!response.ok) return { loggedIn: response.status !== 401 || !!oauth.refreshToken, usage: [], note: `the provider usage endpoint answered ${response.status}` };
    const body: any = await response.json();
    const usage = (['five_hour', 'seven_day'] as const).flatMap(key => typeof body?.[key]?.utilization === 'number'
      ? [{ window: key === 'five_hour' ? '5h' : '7d', percent: body[key].utilization, resetsAt: typeof body[key].resets_at === 'string' ? new Date(body[key].resets_at).toISOString() : null }] : []);
    return { loggedIn: true, usage, note: null };
  } catch (error) { return { loggedIn: true, usage: [], note: `the provider usage endpoint is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
}

// Codex records the provider's rate-limit windows in every session it writes; the newest record
// is the account's last reported usage.
export async function newestCodexRateLimits(home: string) {
  const directories = async (directory: string) => { try { return (await readdir(directory)).filter(name => /^\d+$/.test(name)).sort().reverse().map(name => resolve(directory, name)); } catch { return []; } };
  const files: { file: string; modified: number }[] = [];
  for (const year of await directories(resolve(home, 'sessions'))) {
    for (const month of await directories(year)) {
      for (const day of await directories(month)) {
        for (const name of (await readdir(day).catch(() => [] as string[])).filter(entry => entry.endsWith('.jsonl'))) {
          const file = resolve(day, name);
          try { files.push({ file, modified: (await stat(file)).mtimeMs }); } catch { /* removed while listing */ }
        }
        if (files.length >= 5) break;
      }
      if (files.length >= 5) break;
    }
    if (files.length >= 5) break;
  }
  for (const { file } of files.sort((a, b) => b.modified - a.modified).slice(0, 5)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.slice(-1_000_000).split('\n').reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let record: any; try { record = JSON.parse(line); } catch { continue; }
      const limits = record?.payload?.rate_limits ?? record?.payload?.info?.rate_limits ?? record?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) return limits;
    }
  }
  return null;
}
export async function codexAccount(environment: AgentEnvironment, probe: EnvironmentProbe) {
  const auth = await readJsonFile(resolve(environment.home, 'auth.json'));
  const loggedIn = !!auth && (typeof auth.tokens?.access_token === 'string' || typeof auth.OPENAI_API_KEY === 'string' && !!auth.OPENAI_API_KEY);
  if (!loggedIn || probe.quota === false) return { loggedIn, usage: [], note: loggedIn ? 'quota not read' : null, reached: false };
  const limits = await newestCodexRateLimits(environment.home);
  if (!limits) return { loggedIn, usage: [], note: 'no Codex session has reported rate limits for this account yet', reached: false };
  const usage = [limits.primary, limits.secondary].filter(window => window && typeof window.used_percent === 'number').map((window: any) => ({
    window: typeof window.window_minutes === 'number' ? windowName(window.window_minutes) : 'window', percent: window.used_percent,
    resetsAt: typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000).toISOString() : null }));
  return { loggedIn, usage, note: null, reached: !!limits.rate_limit_reached_type };
}


export async function zaiAccount(environment: ProbedEnvironment, probe: EnvironmentProbe, plan: { id: string | null; now: number }): Promise<{ loggedIn: boolean; usage: AccountUsage[]; note: string | null; reached?: boolean; shared?: boolean; plan?: PlanReading }> {
  const opencodeAuth = await readJsonFile(resolve(environment.home, 'opencode/auth.json'));
  const zaiKey = opencodeAuth?.['zai-coding-plan']?.key ?? opencodeAuth?.['z.ai']?.key ?? opencodeAuth?.zai?.key;
  // A named key file is read as Z.AI's only when it is Z.AI's by its variable or name: an OpenCode account whose
  // key is Anthropic's is never probed against Z.AI, so its 401 cannot mark the account logged out (GY-1158).
  const named = environment.keyFile, variable = environment.keyVariable;
  const keyFileName = named && (variable === 'ZAI_API_KEY' || /zai/i.test(named)) ? named : 'zai.key';
  const fileKey = await readFile(resolve(environment.home, keyFileName), 'utf8').catch(() => null);
  const fallbackKey = keyFileName !== 'zai.key' ? await readFile(resolve(environment.home, 'zai.key'), 'utf8').catch(() => null) : null;
  const auth = await readJsonFile(resolve(environment.home, 'auth.json'));
  const piKey = auth?.zai?.key ?? auth?.['z.ai']?.key ?? auth?.['zai-coding-plan']?.key ?? auth?.ZAI_API_KEY;
  const key = zaiKey ?? piKey ?? (fileKey?.trim() || undefined) ?? (fallbackKey?.trim() || undefined);

  const hasZaiKey = !!key;
  // Z.AI-specific only on Z.AI evidence: the Pi runtime, a declared zai plan, or a key named Z.AI's. A plan id derived
  // from the runtime is no evidence (every OpenCode account defaults to the 'zai' kind), nor is the account's name (GY-1158).
  // The key's presence decides, not its value: a caller that passes an optional plan as `declaredPlan: undefined` has
  // declared none, and must not fall back to the derived plan's default 'zai' kind (GY-1239).
  const declared = 'declaredPlan' in environment ? environment.declaredPlan : environment.plan;
  const isZaiSpecific = (environment.kind as string) === 'pi'
    || /^zai/i.test(declared ?? '')
    || keyFileName !== 'zai.key';

  if (isZaiSpecific) {
    if (!hasZaiKey || probe.quota === false) {
      return { loggedIn: hasZaiKey, usage: [], note: hasZaiKey ? 'quota not read' : null };
    }
  } else {
    // Any provider entry carrying credential material is an OpenCode login: an API key (`type: 'api'`), a well-known
    // token, or the access/refresh pair `opencode auth login` stores for OAuth providers (Anthropic, OpenAI, Copilot).
    const credentialField = (value: unknown) => typeof value === 'string' && value.length > 0;
    const hasOpencodeAuth = !!opencodeAuth && Object.values(opencodeAuth).some((v: any) => credentialField(v)
      || !!v && typeof v === 'object' && ['key', 'apiKey', 'token', 'access', 'refresh'].some(field => credentialField(v[field])));
    const loggedIn = hasZaiKey || hasOpencodeAuth;
    if (!loggedIn || probe.quota === false) {
      return { loggedIn, usage: [], note: loggedIn ? 'quota not read' : null };
    }
    if (!hasZaiKey) {
      return { loggedIn, usage: [], note: 'OpenCode exposes no provider quota Graphyard can read; its providers report their own limits in the session' };
    }
  }
  // Accounts on one shared plan read one quota: a fresh plan reading answers without another call
  // to the provider's endpoint, so selecting among N such accounts costs one probe, not N (GY-1180).
  // Any reading the endpoint answered is shared, a zero-window one too, and it carries the plan's own
  // reason and limit flag rather than a note another account wrote (GY-1260).
  const shared: PlanReading | null = plan.id ? getCachedPlanUsage(plan.id, plan.now, probe.cacheMs ?? 30_000) : null;
  if (shared) return { loggedIn: true, usage: shared.windows, note: shared.reason, reached: shared.reached, shared: true };
  try {
    const response = await (probe.fetch ?? fetch)('https://api.z.ai/api/monitor/usage/quota/limit', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(probe.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const text = await response.text();
        const parsed = parseZaiUsage(text);
        if (parsed.reported && parsed.windows.length > 0) {
          return { loggedIn: true, usage: parsed.windows, note: parsed.reason, plan: parsed };
        }
      }
      return { loggedIn: true, usage: [], note: `provider returned ${response.status}` };
    }
    const body = await response.json();
    const parsed = parseZaiUsage(body);
    return { loggedIn: true, usage: parsed.windows, note: parsed.reason, plan: parsed };
  } catch (error) {
    return { loggedIn: true, usage: [], note: `the provider usage endpoint is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}` };
  }
}

