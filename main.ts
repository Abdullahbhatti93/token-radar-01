// LaunchScope token radar: the program behind the board.
//
// Reads the sealed snapshot (default /input/snapshot.json, or --input <file|dir>),
// prices every standalone pre-token protocol with the comparables model in
// lib/model.ts, attaches a generated farm plan from lib/farm.ts, and writes to the
// output directory (default /output, or MAKEFUN_OUTPUT_DIR, or --output):
//
//   board.json    the ranked board the gate reads
//   data.js       the same board as a script the static dashboard loads
//   dashboard/    a copy of this repository's dashboard/
//   screenshots/  a copy of this repository's screenshots/
//   dossier.json  written last, by buildDossier from vendor/makefun-board.ts
//
// The program checks its own board against the gate's rules before writing
// anything, and refuses to hand in a board that fails them. It reads no clock and
// no randomness: two runs over the same snapshot write the same bytes.
//
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL,
  buildComparables,
  isStandalonePreToken,
  medianKnownAge,
  parseSnapshot,
  priceProtocol,
  recordsNoToken,
  type Protocol,
  type Snapshot,
} from './lib/model.ts';
import { farmPlan } from './lib/farm.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, from the competition rules: the dossier text cap and the file limits. */
const DOSSIER_TEXT_BYTES = 65_536;
const DOSSIER_SHOTS = { max: 4, max_bytes: 524_288 };
const DOSSIER_DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A board row: the gate's five fields plus the record and the model's arithmetic. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_samples: number;
    momentum_factor: number;
    maturity_factor: number;
    breadth_factor: number;
  };
  farm_steps: string[];
}

/** A traded protocol for the dashboard's Live view: the market's own numbers, no model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** Everything data.js carries for the dashboard. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    name: string;
    version: string;
    global_median_multiple: number;
    shrink_k: number;
    momentum_weight: number;
    maturity_base: number;
    maturity_span: number;
    breadth_step: number;
  };
  stats: {
    protocols: number;
    pre_token: number;
    board_rows: number;
    watchlist: number;
    live_shown: number;
  };
  rows: BoardRow[];
  live: LiveRow[];
  categories: Array<{ category: string; multiple: number; samples: number; board_rows: number }>;
}

/** Build the ranked board: every watchlist slug, plus every standalone pre-token protocol the rule admits. */
export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; live: LiveRow[]; data: RadarData } {
  const comps = buildComparables(snapshot);
  const medianAge = medianKnownAge(snapshot);
  const watch = new Set(snapshot.watchlist);

  const candidates = snapshot.protocols.filter(isStandalonePreToken);
  const priced = candidates.map((p) => ({ p, pricing: priceProtocol(p, snapshot.as_of, comps, medianAge) }));
  priced.sort(
    (a, b) =>
      b.pricing.implied_value_usd - a.pricing.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  const rows: BoardRow[] = priced.map(({ p, pricing }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: pricing.age_days,
    on_watchlist: watch.has(p.slug),
    implied_value_usd: pricing.implied_value_usd,
    model: {
      category_multiple: pricing.category_multiple,
      category_samples: pricing.category_samples,
      momentum_factor: pricing.momentum_factor,
      maturity_factor: pricing.maturity_factor,
      breadth_factor: pricing.breadth_factor,
    },
    farm_steps: farmPlan(p, pricing.age_days),
  }));

  for (const row of rows) {
    const comp = comps.by_category.get(row.category ?? 'Uncategorised');
    if (comp !== undefined) comp.board_rows += 1;
  }

  const live: LiveRow[] = snapshot.protocols
    .filter((p): p is Protocol & { mcap_usd: number } => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));

  const categories = [...comps.by_category.values()]
    .filter((c) => c.board_rows > 0 || c.samples > 0)
    .sort((a, b) => b.board_rows - a.board_rows || (a.category < b.category ? -1 : 1))
    .map((c) => ({ category: c.category, multiple: Math.round(c.multiple * 1e4) / 1e4, samples: c.samples, board_rows: c.board_rows }));

  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      name: MODEL.name,
      version: MODEL.version,
      global_median_multiple: Math.round(comps.global_median * 1e4) / 1e4,
      shrink_k: MODEL.shrink_k,
      momentum_weight: MODEL.momentum_weight,
      maturity_base: MODEL.maturity_base,
      maturity_span: MODEL.maturity_span,
      breadth_step: MODEL.breadth_step,
    },
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: candidates.length,
      board_rows: rows.length,
      watchlist: snapshot.watchlist.length,
      live_shown: live.length,
    },
    rows,
    live,
    categories,
  };
  return { rows, live, data };
}

/** The gate's board rules, checked before anything is written; a string says why the board fails. */
export function boardProblem(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!known.has(row.slug)) return `${row.slug} is not one of the snapshot's protocols`;
    if (seen.has(row.slug)) return `${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.name.trim().length === 0) return `${row.slug} has an empty name`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `${row.slug} has a farm step of ${len} characters`;
    }
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `the board misses watchlist slug ${slug}`;
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (rows.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: not a ranking';
  }
  return null;
}

/** --name value (or --name=value) from the command line, else the fallback. */
function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

/** Copy a directory's regular files (recursively) into the output, skipping dot-names. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copied.push(...copyTree(src, dst));
    else if (statSync(src).isFile()) {
      copyFileSync(src, dst);
      copied.push(name);
    }
  }
  return copied;
}

function main(): void {
  const inputArg = argValue('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`launchscope: no snapshot at ${inputFile}: pass --input <snapshot.json|dir> or mount the sealed /input\n`);
    process.exit(2);
  }
  const out = argValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { rows, data } = buildBoard(snapshot);
  const problem = boardProblem(rows, snapshot);
  if (problem !== null) {
    process.stderr.write(`launchscope: the board fails the gate: ${problem}\n`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows })}\n`);
  writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(data)};\n`);

  copyTree(join(repoDir, 'dashboard'), join(out, 'dashboard'));
  const shots = copyTree(join(repoDir, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3 || shots.length > 4) {
    process.stderr.write(`launchscope: screenshots/ holds ${shots.length} files: hand in 3 or 4, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`launchscope: screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }

  // Written last: the scorer rebuilds the dossier from this same output and compares bytes.
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, { text_max_bytes: DOSSIER_TEXT_BYTES, screenshots: DOSSIER_SHOTS, dashboard: DOSSIER_DASHBOARD }),
  );

  process.stdout.write(
    `launchscope: ${snapshot.protocols.length} protocols scanned, ${data.stats.pre_token} standalone pre-token, ` +
      `${rows.length} rows ranked, watchlist ${snapshot.watchlist.length}/${snapshot.watchlist.length} covered\n` +
      `launchscope: wrote board.json, data.js, dashboard/, screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
  );
}

main();
