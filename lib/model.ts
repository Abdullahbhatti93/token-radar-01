// LaunchScope model: from one sealed snapshot of the protocol universe to a ranked
// board of pre-token protocols, each with an implied token value.
//
// The valuation is anchored in the snapshot itself. Protocols whose token already
// trades reveal what the market pays for a dollar of TVL in their category; this
// model measures that price category by category (the median market-cap-to-TVL
// ratio of the category's traded protocols, pulled toward the market-wide median
// when a category has few traded names) and applies it to the pre-token protocols
// in the same category. Three adjustments follow, all from the protocol's own
// record: its seven-day TVL momentum, how long it has run with no token, and how
// many chains it operates on. No protocol is ever named or special-cased: one
// function prices every row, and every row carries its own arithmetic so a reader
// can check the number instead of trusting it.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** Why a snapshot cannot be scored by this model. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's fixed constants. One place, stated in the dashboard's Model view. */
export const MODEL = {
  version: 'compset-1',
  name: 'CompSet FDV',
  /** A category median is blended with the market median as (n*cat + K*global)/(n+K). */
  shrink_k: 6,
  /** Category multiples are kept inside this band, however the market prices outliers. */
  multiple_min: 0.05,
  multiple_max: 2.0,
  /** Each traded protocol's own ratio is winsorized into this band before any median is taken. */
  ratio_min: 0.02,
  ratio_max: 3,
  /** Momentum: implied value moves by this share of the clamped seven-day change. */
  momentum_weight: 0.3,
  momentum_floor_pct: -60,
  momentum_cap_pct: 120,
  momentum_min: 0.55,
  momentum_max: 1.4,
  /** Maturity: a factor from MATURITY_BASE up to +MATURITY_SPAN across MATURITY_DAYS. */
  maturity_base: 0.72,
  maturity_span: 0.38,
  maturity_days: 1825,
  /** Breadth: this much per extra chain, up to BREADTH_MAX_EXTRA chains. */
  breadth_step: 0.025,
  breadth_max_extra: 8,
} as const;

/** A finite number from the snapshot, else null (missing stays missing, never invented). */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whole days from the day a protocol was first tracked to the snapshot day; null if either is unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** The median of a non-empty list, computed on a sorted copy so callers keep their order. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Names that end in a release marker are pools of another protocol, not launches. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Whole words that mark a wrapped or staked product of a token that already trades. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are products of an existing asset or venue, never a launch candidate. */
const PRODUCT_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** Exchange brands a protocol name may not open with (it would be the venue's own product). */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * A standalone pre-token protocol: records no token, and is not a wrapped, staked,
 * bridged or versioned product of something that already trades. This is the
 * snapshot's own watchlist test with the TVL floor removed, applied at every size,
 * so the board below the floor is drawn by the same rule as the board above it.
 */
export function isStandalonePreToken(p: Protocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  for (const brand of EXCHANGE_PREFIXES) {
    if (p.name === brand || p.name.startsWith(`${brand} `)) return false;
  }
  return true;
}

/** What the market pays for a dollar of TVL in one category, and how much evidence backs it. */
export interface CategoryMultiple {
  category: string;
  /** The blended, clamped multiple applied to pre-token protocols in this category. */
  multiple: number;
  /** The category's own median ratio before blending (null when it has no traded protocol). */
  raw_median: number | null;
  /** How many traded protocols in the category priced it. */
  samples: number;
  /** How many board rows the category carries. */
  board_rows: number;
}

/** The comparables table the whole board is priced from. */
export interface Comparables {
  /** The market-wide median market-cap-to-TVL ratio across every traded protocol. */
  global_median: number;
  /** Every category that appears among traded or board protocols, by name. */
  by_category: Map<string, CategoryMultiple>;
}

/**
 * Measure the market's own pricing from the snapshot: for every traded protocol,
 * the ratio of its market cap to its TVL; per category, the median ratio, blended
 * toward the market median by sample count and clamped to a sane band.
 */
export function buildComparables(snapshot: Snapshot): Comparables {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, MODEL.ratio_min, MODEL.ratio_max);
    allRatios.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMedian = allRatios.length > 0 ? median(allRatios) : 0.25;
  const byCategory = new Map<string, CategoryMultiple>();
  const categories = new Set<string>();
  for (const p of snapshot.protocols) categories.add(p.category ?? 'Uncategorised');
  for (const category of categories) {
    const ratios = ratiosByCategory.get(category) ?? [];
    const raw = ratios.length > 0 ? median(ratios) : null;
    const blended = raw === null ? globalMedian : (ratios.length * raw + MODEL.shrink_k * globalMedian) / (ratios.length + MODEL.shrink_k);
    byCategory.set(category, {
      category,
      multiple: clamp(blended, MODEL.multiple_min, MODEL.multiple_max),
      raw_median: raw === null ? null : round4(raw),
      samples: ratios.length,
      board_rows: 0,
    });
  }
  return { global_median: globalMedian, by_category: byCategory };
}

/** One protocol's full pricing: the implied value and every factor that produced it. */
export interface Pricing {
  implied_value_usd: number;
  category_multiple: number;
  category_samples: number;
  momentum_factor: number;
  growth_pct: number | null;
  maturity_factor: number;
  breadth_factor: number;
  age_days: number | null;
}

/** Price one pre-token protocol from its own record and the comparables table. */
export function priceProtocol(p: Protocol, asOf: string, comps: Comparables, medianAge: number): Pricing {
  const comp = comps.by_category.get(p.category ?? 'Uncategorised');
  const multiple = comp === undefined ? clamp(comps.global_median, MODEL.multiple_min, MODEL.multiple_max) : comp.multiple;
  const age = ageDays(asOf, p.listed_at);
  const growthPct = p.change_7d === null ? null : clamp(p.change_7d, MODEL.momentum_floor_pct, MODEL.momentum_cap_pct);
  const momentum = growthPct === null ? 1 : clamp(1 + (growthPct / 100) * MODEL.momentum_weight, MODEL.momentum_min, MODEL.momentum_max);
  const ageForModel = age ?? medianAge;
  const maturity = MODEL.maturity_base + MODEL.maturity_span * (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days);
  const extraChains = Math.max(0, Math.min(p.chains.length - 1, MODEL.breadth_max_extra));
  const breadth = 1 + MODEL.breadth_step * extraChains;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * breadth));
  return {
    implied_value_usd: implied,
    category_multiple: round4(multiple),
    category_samples: comp === undefined ? 0 : comp.samples,
    momentum_factor: round4(momentum),
    growth_pct: growthPct === null ? null : round4(growthPct),
    maturity_factor: round4(maturity),
    breadth_factor: round4(breadth),
    age_days: age,
  };
}

/** The median known age of the board's protocols: the stand-in for a protocol whose age is unrecorded. */
export function medianKnownAge(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isStandalonePreToken(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return ages.length > 0 ? Math.round(median(ages)) : 365;
}

/** Read and validate the sealed snapshot; anything malformed is refused, never guessed at. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot is not a JSON object');
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) throw new SnapshotError('snapshot has no as_of date');
  if (typeof doc.source !== 'string' || doc.source.length === 0) throw new SnapshotError('snapshot has no source');
  const floor = num(doc.floor_usd);
  if (floor === null || floor <= 0) throw new SnapshotError('snapshot has no usable floor_usd');
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot has no watchlist of slugs');
  }
  const protocols: Protocol[] = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotError(`protocol ${i} is not an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r.slug !== 'string' || r.slug.length === 0) throw new SnapshotError(`protocol ${i} has no slug`);
    if (typeof r.name !== 'string' || r.name.length === 0) throw new SnapshotError(`protocol ${i} has no name`);
    const tvl = num(r.tvl_usd);
    if (tvl === null) throw new SnapshotError(`protocol ${i} has no TVL`);
    return {
      slug: r.slug,
      name: r.name,
      category: typeof r.category === 'string' ? r.category : null,
      chains: Array.isArray(r.chains) ? r.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: tvl,
      change_7d: num(r.change_7d),
      mcap_usd: num(r.mcap_usd),
      listed_at: typeof r.listed_at === 'string' ? r.listed_at : null,
      gecko_id: typeof r.gecko_id === 'string' ? r.gecko_id : null,
      symbol: typeof r.symbol === 'string' ? r.symbol : null,
    };
  });
  return { as_of: doc.as_of, source: doc.source, floor_usd: floor, protocols, watchlist: doc.watchlist as string[] };
}
