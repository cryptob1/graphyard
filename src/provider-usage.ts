/**
 * Provider-usage adapters and plan-level quota tracking (GY-1121).
 *
 * Each supported provider plan (Claude, Codex, Z.AI, Cursor, Muse, Antigravity) has a usage adapter
 * reading its own usage source or explicitly stating "usage not reported by <provider>".
 * Usage belongs to the provider plan, not the CLI: accounts that draw on one plan share one budget,
 * grouped on the Accounts page with a bar per usage window.
 */

export const supportedProviderPlans = ['claude', 'codex', 'zai', 'cursor', 'muse', 'antigravity'] as const;
export type ProviderPlanKind = typeof supportedProviderPlans[number];

export const providerPlanLabels: Record<ProviderPlanKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  zai: 'Z.AI',
  cursor: 'Cursor',
  muse: 'Muse',
  antigravity: 'Antigravity',
};

export interface UsageWindow {
  window: string;
  percent: number;
  resetsAt: string | null;
}

export interface ProviderUsageResult {
  reported: boolean;
  status: 'reported' | 'not-reported';
  windows: UsageWindow[];
  resetsAt: string | null;
  reason: string | null;
}

export interface ProviderUsageAdapter {
  kind: ProviderPlanKind;
  name: string;
  parse(response: unknown): ProviderUsageResult;
  getUsage(response?: unknown): ProviderUsageResult;
}

export const windowName = (minutes: number): string =>
  minutes >= 1440 && minutes % 1440 === 0
    ? `${minutes / 1440}d`
    : minutes >= 60 && minutes % 60 === 0
    ? `${minutes / 60}h`
    : `${minutes}m`;

export function notReportedUsage(provider: string): ProviderUsageResult {
  return {
    reported: false,
    status: 'not-reported',
    windows: [],
    resetsAt: null,
    reason: `usage not reported by ${provider}`,
  };
}

/**
 * Claude Code usage adapter: parses Anthropic OAuth usage windows (5h, 7d).
 */
export function parseClaudeUsage(response: unknown): ProviderUsageResult {
  if (!response) {
    return notReportedUsage('Claude');
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      return parseClaudeUsage(parsed);
    } catch {
      // Regex parsing for text output
      const windows: UsageWindow[] = [];
      const fiveHourMatch = /(?:5-?hour|5h)[^0-9]*?(\d+(?:\.\d+)?)%/i.exec(response);
      const sevenDayMatch = /(?:weekly|7-?day|7d)[^0-9]*?(\d+(?:\.\d+)?)%/i.exec(response);
      const reset5hMatch = /(?:5-?hour|5h)[^]*?resets?\s+(?:at\s+)?([^\s,)]+)/i.exec(response);
      const reset7dMatch = /(?:weekly|7-?day|7d)[^]*?resets?\s+(?:at\s+)?([^\s,)]+)/i.exec(response);

      if (fiveHourMatch) {
        const resetsAt = reset5hMatch && !isNaN(Date.parse(reset5hMatch[1])) ? new Date(reset5hMatch[1]).toISOString() : null;
        windows.push({ window: '5h', percent: Number(fiveHourMatch[1]), resetsAt });
      }
      if (sevenDayMatch) {
        const resetsAt = reset7dMatch && !isNaN(Date.parse(reset7dMatch[1])) ? new Date(reset7dMatch[1]).toISOString() : null;
        windows.push({ window: '7d', percent: Number(sevenDayMatch[1]), resetsAt });
      }
      if (windows.length) {
        const resets = windows.map(u => u.resetsAt).filter((r): r is string => !!r).sort();
        return { reported: true, status: 'reported', windows, resetsAt: resets.at(-1) ?? null, reason: null };
      }
      return notReportedUsage('Claude');
    }
  }
  const body = response as Record<string, any>;
  if (Array.isArray(body.windows) && body.windows.length > 0) {
    const windows = body.windows as UsageWindow[];
    const resets = windows.map(w => w.resetsAt).filter((r): r is string => !!r).sort();
    return { reported: true, status: 'reported', windows, resetsAt: (body.resetsAt as string | null) ?? resets.at(-1) ?? null, reason: null };
  }
  const container = (body.usage && typeof body.usage === 'object') ? body.usage : body;
  const usage: UsageWindow[] = [];
  const entries: [string, any][] = [
    ['5h', container.five_hour ?? container.fiveHour ?? container.fiveHourWindow ?? container['5h']],
    ['7d', container.seven_day ?? container.sevenDay ?? container.sevenDayWindow ?? container['7d'] ?? container.weekly],
  ];
  for (const [window, entry] of entries) {
    if (!entry) continue;
    const percent = typeof entry === 'number' ? entry
      : typeof entry.utilization === 'number' ? entry.utilization
      : typeof entry.percent === 'number' ? entry.percent
      : typeof entry.percentage === 'number' ? entry.percentage
      : typeof entry.used_percent === 'number' ? entry.used_percent : null;
    if (percent !== null) {
      const rawReset = entry.resets_at ?? entry.resetsAt ?? entry.reset_time;
      const resetsAt = typeof rawReset === 'string' && !isNaN(Date.parse(rawReset)) ? new Date(rawReset).toISOString()
        : typeof rawReset === 'number' ? new Date(rawReset < 1e11 ? rawReset * 1000 : rawReset).toISOString()
        : null;
      usage.push({ window, percent, resetsAt });
    }
  }
  if (!usage.length) {
    return notReportedUsage('Claude');
  }
  const resets = usage.map(u => u.resetsAt).filter((r): r is string => !!r).sort();
  return { reported: true, status: 'reported', windows: usage, resetsAt: resets.at(-1) ?? null, reason: null };
}

/**
 * Codex / ChatGPT usage adapter: parses session rate-limit windows.
 */
export function parseCodexUsage(response: unknown): ProviderUsageResult {
  if (!response) {
    return notReportedUsage('Codex');
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      return parseCodexUsage(parsed);
    } catch {
      return notReportedUsage('Codex');
    }
  }
  const obj = response as Record<string, any>;
  if (Array.isArray(obj.windows) && obj.windows.length > 0) {
    const windows = obj.windows as UsageWindow[];
    const resets = windows.map(w => w.resetsAt).filter((r): r is string => !!r).sort();
    return { reported: true, status: 'reported', windows, resetsAt: (obj.resetsAt as string | null) ?? resets.at(-1) ?? null, reason: null };
  }
  const limits = obj.rate_limits ?? obj.payload?.rate_limits ?? obj.payload?.info?.rate_limits ?? obj;
  if (!limits || typeof limits !== 'object') {
    return notReportedUsage('Codex');
  }
  const windows: UsageWindow[] = [];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!entry || typeof entry !== 'object') continue;
      const percent = typeof entry.percent === 'number' ? entry.percent
        : typeof entry.used_percent === 'number' ? entry.used_percent : null;
      if (percent === null) continue;
      const window = entry.window ?? (typeof entry.window_minutes === 'number' ? windowName(entry.window_minutes) : 'window');
      const rawReset = entry.resets_at ?? entry.resetsAt;
      const resetsAt = typeof rawReset === 'number' ? new Date(rawReset < 1e11 ? rawReset * 1000 : rawReset).toISOString()
        : typeof rawReset === 'string' && !isNaN(Date.parse(rawReset)) ? new Date(rawReset).toISOString()
        : null;
      windows.push({ window, percent, resetsAt });
    }
  } else {
    for (const key of ['primary', 'secondary']) {
      const entry = limits[key];
      if (!entry || typeof entry.used_percent !== 'number') continue;
      const window = typeof entry.window_minutes === 'number' ? windowName(entry.window_minutes) : key === 'primary' ? '5h' : '7d';
      const resetsAt = typeof entry.resets_at === 'number' ? new Date(entry.resets_at * 1000).toISOString()
        : typeof entry.resets_at === 'string' ? new Date(entry.resets_at).toISOString()
        : typeof entry.resetsAt === 'string' ? new Date(entry.resetsAt).toISOString()
        : null;
      windows.push({ window, percent: entry.used_percent, resetsAt });
    }
  }
  if (!windows.length) {
    return notReportedUsage('Codex');
  }
  const resets = windows.map(u => u.resetsAt).filter((r): r is string => !!r).sort();
  return { reported: true, status: 'reported', windows, resetsAt: resets.at(-1) ?? null, reason: null };
}

function parseZaiMessage(message: string): ProviderUsageResult {
  const resetMatch = /reset(?:s)? at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T\s][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?)/i.exec(message);
  let resetsAt: string | null = null;
  if (resetMatch) {
    const raw = resetMatch[1].replace(' ', 'T');
    const parsed = Date.parse(raw.includes('Z') || /[+-]\d{2}/.test(raw) ? raw : raw + 'Z');
    if (!Number.isNaN(parsed)) resetsAt = new Date(parsed).toISOString();
  }
  const is5h = /5-?hour|hourly|prompt/i.test(message);
  const window = is5h ? '5h' : '7d';
  return {
    reported: true,
    status: 'reported',
    windows: [{ window, percent: 100, resetsAt }],
    resetsAt,
    reason: message,
  };
}

/**
 * Z.AI GLM Coding Plan usage adapter: parses quota API limit endpoint or 429/prompt limit notices.
 */
export function parseZaiUsage(response: unknown): ProviderUsageResult {
  if (!response) {
    return notReportedUsage('Z.AI');
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      return parseZaiUsage(parsed);
    } catch {
      return parseZaiMessage(response);
    }
  }
  const obj = response as Record<string, any>;
  if (Array.isArray(obj.windows) && obj.windows.length > 0) {
    const windows = obj.windows as UsageWindow[];
    const resets = windows.map(w => w.resetsAt).filter((r): r is string => !!r).sort();
    return { reported: true, status: 'reported', windows, resetsAt: (obj.resetsAt as string | null) ?? resets.at(-1) ?? null, reason: null };
  }
  if (obj.code === 1310 || (obj.message && /limit exhausted|resets? at/i.test(String(obj.message)))) {
    return parseZaiMessage(String(obj.message ?? JSON.stringify(obj)));
  }
  const limits = obj.data?.limits ?? obj.limits ?? (Array.isArray(obj) ? obj : null);
  if (Array.isArray(limits) && limits.length > 0) {
    const windows: UsageWindow[] = [];
    for (const limit of limits) {
      if (!limit || typeof limit !== 'object') continue;
      const percent = typeof limit.percentage === 'number' ? limit.percentage
        : typeof limit.percent === 'number' ? limit.percent
        : typeof limit.used_percent === 'number' ? limit.used_percent : null;
      if (percent === null) continue;
      const window = limit.window ?? (limit.type === 'TOKENS_LIMIT' || limit.unit === 3 ? '5h'
        : limit.type === 'TIME_LIMIT' || limit.unit === 5 ? '7d'
        : String(limit.type || 'window'));
      const rawReset = limit.nextResetTime ?? limit.resetsAt ?? limit.resets_at;
      const resetsAt = typeof rawReset === 'number' ? new Date(rawReset < 1e11 ? rawReset * 1000 : rawReset).toISOString()
        : typeof rawReset === 'string' ? new Date(rawReset).toISOString()
        : null;
      windows.push({ window, percent, resetsAt });
    }
    if (windows.length) {
      const resets = windows.map(u => u.resetsAt).filter((r): r is string => !!r).sort();
      return { reported: true, status: 'reported', windows, resetsAt: resets.at(-1) ?? null, reason: null };
    }
  }
  return notReportedUsage('Z.AI');
}

export const providerUsageAdapters: Record<ProviderPlanKind, ProviderUsageAdapter> = {
  claude: {
    kind: 'claude',
    name: 'Claude',
    parse: parseClaudeUsage,
    getUsage: (res) => (res !== undefined ? parseClaudeUsage(res) : notReportedUsage('Claude')),
  },
  codex: {
    kind: 'codex',
    name: 'Codex',
    parse: parseCodexUsage,
    getUsage: (res) => (res !== undefined ? parseCodexUsage(res) : notReportedUsage('Codex')),
  },
  zai: {
    kind: 'zai',
    name: 'Z.AI',
    parse: parseZaiUsage,
    getUsage: (res) => (res !== undefined ? parseZaiUsage(res) : notReportedUsage('Z.AI')),
  },
  cursor: {
    kind: 'cursor',
    name: 'Cursor',
    parse: (res) => (res && typeof res === 'object' && Array.isArray((res as any).windows) && (res as any).windows.length
      ? { reported: true, status: 'reported', windows: (res as any).windows, resetsAt: (res as any).resetsAt ?? null, reason: null }
      : notReportedUsage('Cursor')),
    getUsage: () => notReportedUsage('Cursor'),
  },
  muse: {
    kind: 'muse',
    name: 'Muse',
    parse: (res) => (res && typeof res === 'object' && Array.isArray((res as any).windows) && (res as any).windows.length
      ? { reported: true, status: 'reported', windows: (res as any).windows, resetsAt: (res as any).resetsAt ?? null, reason: null }
      : notReportedUsage('Muse')),
    getUsage: () => notReportedUsage('Muse'),
  },
  antigravity: {
    kind: 'antigravity',
    name: 'Antigravity',
    parse: (res) => (res && typeof res === 'object' && Array.isArray((res as any).windows) && (res as any).windows.length
      ? { reported: true, status: 'reported', windows: (res as any).windows, resetsAt: (res as any).resetsAt ?? null, reason: null }
      : notReportedUsage('Antigravity')),
    getUsage: () => notReportedUsage('Antigravity'),
  },
};

/**
 * In-memory plan usage cache. Bounded cadence, never exposes secret keys.
 */
const planUsageCache = new Map<string, { at: number; usage: ProviderUsageResult }>();
export const DEFAULT_USAGE_CACHE_MS = 60_000;

export function getCachedPlanUsage(planId: string, now = Date.now(), maxAgeMs = DEFAULT_USAGE_CACHE_MS): ProviderUsageResult | null {
  const cached = planUsageCache.get(planId);
  if (cached && now - cached.at >= 0 && now - cached.at < maxAgeMs) {
    return cached.usage;
  }
  return null;
}

export function setCachedPlanUsage(planId: string, usage: ProviderUsageResult, now = Date.now()): void {
  planUsageCache.set(planId, { at: now, usage });
}

export function clearPlanUsageCache(): void {
  planUsageCache.clear();
}

export function detectPlanKind(text: string, runtime = '', model = ''): ProviderPlanKind {
  const lower = `${text} ${runtime} ${model}`.toLowerCase();
  if (lower.includes('z.ai') || lower.includes('zai') || lower.includes('glm')) return 'zai';
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('chatgpt')) return 'codex';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('muse')) return 'muse';
  if (lower.includes('antigravity') || lower.includes('agy')) return 'antigravity';
  return 'claude';
}

/**
 * Derive an account's plan kind and identifier, grouped where possible (e.g. pi-X and opencode-X sharing a Z.AI key).
 */
export function deriveAccountPlan(
  account: { name: string; runtime: string; model?: string; credential?: { host?: string; home?: string | null; key?: { file: string; variable: string } }; plan?: string | null },
  allAccounts: readonly { name: string; runtime: string; model?: string; credential?: { host?: string; home?: string | null; key?: { file: string; variable: string } }; plan?: string | null }[] = []
): { planId: string; planName: string; planKind: ProviderPlanKind } {
  // 1. Explicit plan declaration
  if (account.plan) {
    const raw = account.plan.trim();
    const kind = detectPlanKind(raw, account.runtime, account.model);
    return { planId: raw.toLowerCase().replace(/\s+/g, '-'), planName: raw, planKind: kind };
  }

  // 2. Shared key file or shared login home
  const keyFile = account.credential?.key?.file;
  const host = account.credential?.host ?? '';
  const home = account.credential?.home ?? '';

  if (keyFile) {
    const sharesKey = allAccounts.find(o => o.name !== account.name && o.credential?.key?.file === keyFile);
    if (sharesKey) {
      const kind = detectPlanKind(keyFile, account.runtime, account.model);
      return { planId: `key:${keyFile}`, planName: `${providerPlanLabels[kind]} (${keyFile})`, planKind: kind };
    }
  }

  if (home && host) {
    const sharesHome = allAccounts.find(o => o.name !== account.name && (o.credential?.host ?? '') === host && (o.credential?.home ?? '') === home);
    if (sharesHome) {
      const kind = detectPlanKind('', account.runtime, account.model);
      return { planId: `home:${host}:${home}`, planName: `${providerPlanLabels[kind]} (${home.split('/').filter(Boolean).at(-1) || home})`, planKind: kind };
    }
  }

  // 3. pi-X and opencode-X sharing Z.AI key by suffix
  const match = /^(?:pi|opencode)[-_]([a-zA-Z0-9]+)$/i.exec(account.name);
  if (match) {
    const suffix = match[1];
    const sharesSuffix = allAccounts.find(o => o.name !== account.name && new RegExp(`^(?:pi|opencode)[-_]${suffix}$`, 'i').test(o.name));
    if (sharesSuffix || account.credential?.key?.variable === 'ZAI_API_KEY') {
      return { planId: `zai-${suffix.toLowerCase()}`, planName: `Z.AI (${suffix})`, planKind: 'zai' };
    }
  }

  // 4. Default by runtime/provider
  const kind = detectPlanKind('', account.runtime, account.model);
  const providerLabel = providerPlanLabels[kind];
  return { planId: `${kind}:${account.name}`, planName: providerLabel, planKind: kind };
}

export interface FleetPlanView {
  id: string;
  name: string;
  kind: ProviderPlanKind;
  usage: ProviderUsageResult;
  accounts: string[];
}

export interface AccountForPlanGrouping {
  name: string;
  runtime: string;
  model?: string;
  credential?: any;
  plan?: string | null;
  usage?: UsageWindow[];
  quota?: any;
  resetsAt?: string | null;
}

/**
 * Group accounts by their provider plan and assemble the FleetPlanView list.
 */
export function groupAccountsByPlan(
  fleet: { accounts: readonly AccountForPlanGrouping[] },
  now = Date.now()
): FleetPlanView[] {
  // We group accounts primarily under their provider plan (Claude, Codex, Z.AI, Cursor, Muse, Antigravity)
  // If accounts declare explicit plans or distinct shared plans, they group under those plans.
  const map = new Map<string, { id: string; name: string; kind: ProviderPlanKind; accounts: string[]; usageWindows: UsageWindow[]; resetsAt: string | null }>();

  for (const account of fleet.accounts) {
    const { planId, planName, planKind } = deriveAccountPlan(account, fleet.accounts);
    // If account has explicit plan or shared key/suffix, use that planId;
    // Otherwise group under provider plan (e.g. 'Claude', 'Codex', 'Cursor', etc.)
    const groupKey = account.plan || planId.startsWith('zai-') || planId.startsWith('key:') || planId.startsWith('home:')
      ? planId
      : planKind;
    const groupName = account.plan || planId.startsWith('zai-') || planId.startsWith('key:') || planId.startsWith('home:')
      ? planName
      : providerPlanLabels[planKind];

    let group = map.get(groupKey);
    if (!group) {
      group = { id: groupKey, name: groupName, kind: planKind, accounts: [], usageWindows: [], resetsAt: null };
      map.set(groupKey, group);
    }
    group.accounts.push(account.name);
    const usage = Array.isArray(account.usage) && account.usage.length > 0 ? account.usage
      : Array.isArray(account.quota?.usage) && account.quota.usage.length > 0 ? account.quota.usage : null;
    const resetsAt = account.resetsAt ?? (typeof account.quota?.resetsAt === 'string' ? account.quota.resetsAt : null);
    if (usage && !group.usageWindows.length) {
      group.usageWindows = usage;
      group.resetsAt = resetsAt;
    }
  }

  return Array.from(map.values()).map(group => {
    // 1. Cached plan usage
    const cached = getCachedPlanUsage(group.id, now);
    if (cached) {
      return { id: group.id, name: group.name, kind: group.kind, usage: cached, accounts: group.accounts };
    }
    // 2. From account's own observed usage windows
    if (group.usageWindows.length > 0) {
      const usage: ProviderUsageResult = {
        reported: true,
        status: 'reported',
        windows: group.usageWindows,
        resetsAt: group.resetsAt,
        reason: null,
      };
      setCachedPlanUsage(group.id, usage, now);
      return { id: group.id, name: group.name, kind: group.kind, usage, accounts: group.accounts };
    }
    // 3. Fallback to adapter's default getUsage
    const adapter = providerUsageAdapters[group.kind] ?? providerUsageAdapters.claude;
    const usage = adapter.getUsage();
    return { id: group.id, name: group.name, kind: group.kind, usage, accounts: group.accounts };
  });
}
