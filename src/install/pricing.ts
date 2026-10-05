import type { PreflightItem } from './types.js';
import type { Transport } from './transport.js';

/**
 * Sizing and spend consent for a server the installer creates (GY-717 AC-5).
 *
 * A self-contained host runs every agent session, so its memory is sized from the planned
 * concurrency rather than guessed: each concurrent agent session, plus the heavy verification runs
 * the host allows at once, plus the control plane itself, must fit above the free-memory floor the
 * loop keeps. A host below that floor defers every launch — a paid machine that runs nothing.
 *
 * The floor and the slot bound are GY-612's (src/master-resources.ts `hostMemoryFloor`,
 * src/master/verification-slots.ts `defaultVerificationSlots`). They are restated here, with the
 * same values, so the installer does not depend on the loop's modules; change them together.
 */
export const memoryPerAgentGiB = 3;
/** One heavy verification run (a full suite with its own Postgres, or a type check) holds about this much. */
export const memoryPerVerificationRunGiB = 2;
/** Postgres, the server, the loop, the executors, Herdr and the operating system. */
export const controlPlaneGiB = 2;
/** GY-612: max(10% of total, 4 GiB) stays free, or the loop defers launches. */
export const memoryFloorShare = 0.1, memoryFloorMinimumGiB = 4;
/** GY-612: one verification slot per 8 GB of memory, never fewer than two. */
export const gigabytesPerSlot = 8, minimumSlots = 2;

export const hostMemoryFloorGiB = (totalGiB: number) => Math.max(totalGiB * memoryFloorShare, memoryFloorMinimumGiB);
export const verificationSlotsFor = (totalGiB: number) => Math.max(minimumSlots, Math.floor(totalGiB / gigabytesPerSlot));

export interface HostSizing { agents: number; totalGiB: number; verificationSlots: number; floorGiB: number; requiredGiB: number; fits: boolean }

/** What a machine of `totalGiB` must hold for `agents` concurrent sessions, and whether it does. */
export function hostSizing(totalGiB: number, agents: number): HostSizing {
  const verificationSlots = verificationSlotsFor(totalGiB);
  const floorGiB = hostMemoryFloorGiB(totalGiB);
  const requiredGiB = agents * memoryPerAgentGiB + verificationSlots * memoryPerVerificationRunGiB + controlPlaneGiB;
  return { agents, totalGiB, verificationSlots, floorGiB, requiredGiB, fits: totalGiB - floorGiB >= requiredGiB };
}

export interface ServerOffer { name: string; memoryGiB: number; cores: number; architecture: string; monthly: number; currency: string }

/**
 * `hcloud server-type list -o json`: every type with its per-location prices. Deprecated types and
 * types not sold at `location` are left out; the price is the gross monthly price at that location.
 */
export function parseServerTypes(json: string, location: string): ServerOffer[] {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.server_types) ? parsed.server_types : [];
  return list.flatMap((type: any): ServerOffer[] => {
    if (type?.deprecation || type?.deprecated === true) return [];
    const price = (Array.isArray(type?.prices) ? type.prices : []).find((entry: any) => entry?.location === location);
    const monthly = Number(price?.price_monthly?.gross);
    const memoryGiB = Number(type?.memory);
    if (!type?.name || !Number.isFinite(monthly) || !Number.isFinite(memoryGiB)) return [];
    return [{ name: String(type.name), memoryGiB, cores: Number(type.cores) || 0, architecture: String(type.architecture ?? 'x86'), monthly: Math.round(monthly * 100) / 100, currency: 'EUR' }];
  });
}

/** The smallest x86 type whose memory fits the planned concurrency; the cheaper of equal sizes. */
export function recommendServerType(offers: ServerOffer[], agents: number): ServerOffer | null {
  const fitting = offers.filter(offer => offer.architecture === 'x86' && hostSizing(offer.memoryGiB, agents).fits);
  fitting.sort((a, b) => a.memoryGiB - b.memoryGiB || a.monthly - b.monthly);
  return fitting[0] ?? null;
}

export interface PriceQuote {
  provider: 'hetzner';
  serverType: string;
  location: string;
  memoryGiB: number;
  monthly: number;
  currency: string;
  /** True when the type was chosen from the planned concurrency rather than named with --server-type. */
  recommended: boolean;
  sizing: HostSizing;
  source: 'hcloud server-type list';
}

export type QuoteResult = { quote: PriceQuote; problem: null } | { quote: null; problem: string };

/**
 * The type and its monthly price, read from the provider API before anything is created. With
 * `explicit` the named type is priced as given (and still sized, so the plan says when it is too
 * small); otherwise the type is recommended from `agents`.
 */
export async function hetznerQuote(transport: Transport, options: { location: string; agents: number; explicit: string | null }): Promise<QuoteResult> {
  const listed = await transport.exec('hcloud', ['server-type', 'list', '-o', 'json'], { allowFailure: true, timeout: 120_000 }).catch(() => ({ stdout: '', stderr: 'hcloud is unavailable', code: 1 }));
  if (listed.code !== 0) return { quote: null, problem: 'the Hetzner API did not list server types, so no price can be shown' };
  const offers = parseServerTypes(listed.stdout, options.location);
  if (!offers.length) return { quote: null, problem: `the Hetzner API lists no priced server type at ${options.location}` };
  const chosen = options.explicit ? offers.find(offer => offer.name === options.explicit) ?? null : recommendServerType(offers, options.agents);
  if (!chosen) return { quote: null, problem: options.explicit ? `server type ${options.explicit} is not sold at ${options.location}` : `no server type at ${options.location} fits ${options.agents} concurrent agent session(s)` };
  return { quote: { provider: 'hetzner', serverType: chosen.name, location: options.location, memoryGiB: chosen.memoryGiB, monthly: chosen.monthly, currency: chosen.currency, recommended: !options.explicit, sizing: hostSizing(chosen.memoryGiB, options.agents), source: 'hcloud server-type list' }, problem: null };
}

export const formatPrice = (quote: Pick<PriceQuote, 'monthly' | 'currency'>) => `${quote.monthly.toFixed(2)} ${quote.currency}/month`;

/**
 * Spending money is the operator's decision, so creating a server needs consent the installer can
 * check: `--max-monthly N` covering the price, or `--confirm-price X` equal to the price shown.
 * Neither refuses the apply before anything is created. An existing server buys nothing.
 */
export function spendConsent(result: QuoteResult | null, spend: { maxMonthly: number | null; confirmPrice: number | null }, exists: boolean): PreflightItem {
  const name = 'Monthly price';
  if (exists) return { name, ok: true, detail: 'the server already exists; this install buys nothing' };
  if (!result || !result.quote) return { name, ok: false, detail: result?.problem ?? 'the price was not read', fix: 'Check `hcloud server-type list -o json` works for this project, or name an available --server-type and --location' };
  const { quote } = result;
  const shown = `${quote.serverType} (${quote.memoryGiB} GB) at ${quote.location}: ${formatPrice(quote)}${quote.recommended ? `, recommended for ${quote.sizing.agents} concurrent agent session(s)` : ''}`;
  const fix = `After the operator approves ${formatPrice(quote)}, rerun with --confirm-price ${quote.monthly.toFixed(2)} or --max-monthly N (N at least ${quote.monthly.toFixed(2)})`;
  if (spend.confirmPrice !== null) {
    return Math.abs(spend.confirmPrice - quote.monthly) < 0.005
      ? { name, ok: true, detail: `${shown}; confirmed with --confirm-price` }
      : { name, ok: false, detail: `${shown}; --confirm-price ${spend.confirmPrice.toFixed(2)} does not match the price`, fix };
  }
  if (spend.maxMonthly !== null) {
    return quote.monthly <= spend.maxMonthly
      ? { name, ok: true, detail: `${shown}; within --max-monthly ${spend.maxMonthly.toFixed(2)}` }
      : { name, ok: false, detail: `${shown}; above --max-monthly ${spend.maxMonthly.toFixed(2)}`, fix };
  }
  return { name, ok: false, detail: `${shown}; not confirmed, so nothing will be created`, fix };
}
