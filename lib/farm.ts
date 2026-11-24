// Farm plans: one concrete plan per board row, generated from the protocol's own
// record — its category decides the work, its first chain decides the gas bill,
// its TVL decides the sensible position size, and its age decides how long the
// position must be held to count. Every step names what it costs and how long it
// takes. Phrasing variants are picked by a hash of the slug, so plans differ
// across rows while staying byte-identical between runs.

import type { Protocol } from './model.ts';

/** A small deterministic string hash (FNV-1a): the same slug always picks the same variant. */
export function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The working capital a farm position in this protocol sensibly needs, from its TVL. */
export function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 500;
  if (tvlUsd >= 1_000_000_000) return 250;
  if (tvlUsd >= 250_000_000) return 150;
  if (tvlUsd >= 50_000_000) return 100;
  if (tvlUsd >= 10_000_000) return 75;
  return 50;
}

/** What one ordinary transaction costs on a chain, in dollars, and the asset to pay it with. */
interface ChainProfile {
  gas: number;
  asset: string;
}

const CHAIN_PROFILES: Record<string, ChainProfile> = {
  Ethereum: { gas: 9, asset: 'ETH' },
  Arbitrum: { gas: 0.3, asset: 'ETH' },
  Base: { gas: 0.15, asset: 'ETH' },
  Optimism: { gas: 0.25, asset: 'ETH' },
  'OP Mainnet': { gas: 0.25, asset: 'ETH' },
  'ZKsync Era': { gas: 0.3, asset: 'ETH' },
  Linea: { gas: 0.3, asset: 'ETH' },
  Scroll: { gas: 0.35, asset: 'ETH' },
  Mantle: { gas: 0.2, asset: 'MNT' },
  Blast: { gas: 0.2, asset: 'ETH' },
  Mode: { gas: 0.2, asset: 'ETH' },
  Solana: { gas: 0.05, asset: 'SOL' },
  'BNB Chain': { gas: 0.3, asset: 'BNB' },
  BSC: { gas: 0.3, asset: 'BNB' },
  Polygon: { gas: 0.05, asset: 'POL' },
  Avalanche: { gas: 0.4, asset: 'AVAX' },
  Fantom: { gas: 0.1, asset: 'FTM' },
  Sonic: { gas: 0.1, asset: 'S' },
  Gnosis: { gas: 0.05, asset: 'xDAI' },
  Celo: { gas: 0.05, asset: 'CELO' },
  Sui: { gas: 0.05, asset: 'SUI' },
  Aptos: { gas: 0.05, asset: 'APT' },
  Near: { gas: 0.05, asset: 'NEAR' },
  Tron: { gas: 1.2, asset: 'TRX' },
  Bitcoin: { gas: 2.5, asset: 'BTC' },
  Cosmos: { gas: 0.1, asset: 'ATOM' },
  Sei: { gas: 0.05, asset: 'SEI' },
  Berachain: { gas: 0.2, asset: 'BERA' },
  Monad: { gas: 0.1, asset: 'MON' },
  Hyperliquid: { gas: 0.05, asset: 'HYPE' },
};

const DEFAULT_CHAIN: ChainProfile = { gas: 1, asset: 'the chain’s gas token' };

/** The chain a plan is written for: the first the snapshot lists for the protocol. */
export function primaryChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
}

function chainProfile(chain: string): ChainProfile {
  return CHAIN_PROFILES[chain] ?? DEFAULT_CHAIN;
}

/** How long a position must be held to register across snapshots, from the protocol's age. */
export function holdDaysFor(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 180) return 60;
  if (ageDays < 365) return 45;
  if (ageDays < 730) return 35;
  return 30;
}

/** The work a category asks of a farmer: the two core actions and how the position is unwound. */
interface Playbook {
  open: (name: string, capital: number, chain: string) => string;
  second: (name: string, capital: number, chain: string) => string;
  unwind: (name: string, chain: string) => string;
}

const LENDING: Playbook = {
  open: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} as a lender and leave the deposit untouched once it lands.`,
  second: (name, capital) => `Borrow about $${Math.round(capital * 0.4)} of USDC against the deposit on ${name}, then supply it back once, so the wallet shows both sides of the market.`,
  unwind: (name) => `Repay the borrow in full on ${name}, then withdraw the supplied USDC in one transaction each.`,
};

const DEX: Playbook = {
  open: (name, capital, chain) => `Add $${capital} of liquidity to ${name}'s busiest USDC pool on ${chain}, split evenly between the two sides of the pair.`,
  second: (name, capital) => `Make two small swaps of about $${Math.max(10, Math.round(capital * 0.1))} each through ${name} on different days, so the wallet is a user and not only a liquidity provider.`,
  unwind: (name) => `Remove the liquidity position on ${name} and swap the proceeds back to USDC in one visit.`,
};

const BRIDGE: Playbook = {
  open: (name, capital, chain) => `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name} and keep the bridged funds on the far side.`,
  second: (name, capital) => `Use the bridged funds in one app on the destination chain, then bridge about $${Math.round(capital * 0.3)} back through ${name} a week later.`,
  unwind: (name) => `Bridge the remaining balance back to Ethereum through ${name} and consolidate it in the farming wallet.`,
};

const STAKING: Playbook = {
  open: (name, capital, chain) => `Stake $${capital} worth of ${chain}'s staking asset through ${name} and keep the staking receipt token in the wallet.`,
  second: (name) => `Restake or deposit the receipt token in one integrated vault listed by ${name}, so the position earns in two places at once.`,
  unwind: (name) => `Withdraw from the vault first, then unstake through ${name} and wait out its unbonding period before moving the funds.`,
};

const DERIVATIVES: Playbook = {
  open: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position, long and short in equal size.`,
  second: (name) => `Place two or three small trades a week on ${name} at the minimum size, keeping total fees under $5 a week.`,
  unwind: (name) => `Close every open position on ${name}, cancel open orders, then withdraw the margin to the farming wallet.`,
};

const YIELD: Playbook = {
  open: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the vault shares in the wallet.`,
  second: (name) => `Claim the vault's rewards each week and redeposit them into the same ${name} vault, so the balance compounds on the record.`,
  unwind: (name) => `Redeem the vault shares on ${name} for the underlying USDC, allowing for any withdrawal queue it runs.`,
};

const RWA: Playbook = {
  open: (name, capital, chain) => `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} with USDC and hold it in the farming wallet.`,
  second: (name) => `Use the minted asset in one place ${name} lists as integrated, such as a lending market, so the wallet shows real usage.`,
  unwind: (name) => `Exit the integration first, then redeem the asset for USDC through ${name} inside its redemption window.`,
};

const STABLE: Playbook = {
  open: (name, capital, chain) => `Mint $${capital} of ${name}'s stable asset against USDC collateral on ${chain} and hold the minted balance.`,
  second: (name, capital) => `Provide about $${Math.round(capital * 0.5)} of liquidity to the stable asset's main pool, so the wallet both mints and supports the peg.`,
  unwind: (name) => `Remove the pool liquidity, then repay or redeem the minted stable asset through ${name} to release the collateral.`,
};

const LAUNCHPAD: Playbook = {
  open: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s current sale or staking tier on ${chain} before its snapshot date.`,
  second: (name) => `Take part in one live launch on ${name} at the smallest tier, even a $10 allocation, so the wallet has a participation record.`,
  unwind: (name) => `Claim any vested allocation from ${name} on its published schedule and withdraw the unused deposit.`,
};

const PREDICTION: Playbook = {
  open: (name, capital, chain) => `Fund the wallet with $${capital} of USDC on ${chain} and take one position in ${name}'s most liquid market.`,
  second: (name) => `Trade two or three different markets on ${name} over the month at $10 to $20 each, rather than one large bet.`,
  unwind: (name) => `Let open positions settle on ${name}, then withdraw the full USDC balance to the farming wallet.`,
};

const GENERIC: Playbook = {
  open: (name, capital, chain) => `Deposit $${capital} of USDC into ${name} on ${chain} through its main app and keep the position open.`,
  second: (name) => `Repeat the core action on ${name} once a week at a small size, so the wallet builds a steady history instead of one visit.`,
  unwind: (name) => `Withdraw the full position from ${name} back to USDC and move it to the farming wallet.`,
};

const PLAYBOOKS: Array<{ test: RegExp; book: Playbook }> = [
  { test: /lend|cdp|collateral|borrow/i, book: LENDING },
  { test: /dex|liquidity manager/i, book: DEX },
  { test: /bridge/i, book: BRIDGE },
  { test: /staking|restak/i, book: STAKING },
  { test: /derivative|option|synthetic|basis|perpetual/i, book: DERIVATIVES },
  { test: /yield|farm|curator|allocator|leveraged/i, book: YIELD },
  { test: /rwa/i, book: RWA },
  { test: /stable|algo/i, book: STABLE },
  { test: /launchpad/i, book: LAUNCHPAD },
  { test: /prediction/i, book: PREDICTION },
];

function playbookFor(category: string | null): Playbook {
  if (category !== null) {
    for (const entry of PLAYBOOKS) if (entry.test.test(category)) return entry.book;
  }
  return GENERIC;
}

const WALLET_OPENERS = [
  (name: string) => `Create a fresh wallet used only for ${name}, write its seed phrase on paper, and label the wallet with the protocol's name.`,
  (name: string) => `Set up a dedicated wallet for ${name} alone, store its seed phrase offline, and never mix it with a wallet that holds savings.`,
];

const CADENCE_LINES = [
  (name: string, gas: number) => `Return to ${name} once a week for one small qualifying action, about $${gas} of gas and 10 minutes each visit.`,
  (name: string, gas: number) => `Keep a weekly rhythm on ${name}: one deposit, claim or trade a week, roughly $${gas} of gas and 10 minutes of your time.`,
];

/**
 * The full plan for one protocol: eight steps, each with its cost and its time in
 * the sentence. The plan is a function of the record alone, so two runs write the
 * same plan and two protocols in the same category still differ by chain, size
 * and age.
 */
export function farmPlan(p: Protocol, ageDays: number | null): string[] {
  const chain = primaryChain(p);
  const profile = chainProfile(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(ageDays);
  const book = playbookFor(p.category);
  const pick = slugHash(p.slug) % 2;
  const gasRound = Math.max(1, Math.round(profile.gas * 3));
  const otherChains = p.chains.filter((c) => c !== chain).slice(0, 2);
  const chainNote = otherChains.length > 0 ? ` ${p.name} also runs on ${otherChains.join(' and ')}; the same wallet history counts there if gas is cheaper.` : '';

  const steps: string[] = [
    `${WALLET_OPENERS[pick]!(p.name)} Cost: nothing but the wallet software. Time: 5 minutes, once.`,
    `Fund the wallet on ${chain} with about $${capital + gasRound + 10} of USDC plus a little ${profile.asset} for gas, moved from an exchange in one transfer. Cost: about $${profile.gas} in network and withdrawal fees. Time: 15 minutes.`,
    `${book.open(p.name, capital, chain)} Cost: the $${capital} position plus about $${profile.gas} of gas. Time: 10 minutes to set up.`,
    `${book.second(p.name, capital, chain)} Cost: about $${profile.gas} of gas. Time: 10 minutes.${chainNote}`,
    `${CADENCE_LINES[pick]!(p.name, profile.gas)} Cost: about $${profile.gas} a week in gas. Time: 10 minutes a week, for ${Math.ceil(hold / 7)} weeks.`,
    `Hold the position for at least ${hold} days without emptying it, so the activity appears in more than one weekly snapshot of ${p.name}. Cost: the $${capital} stays committed and cannot be spent meanwhile. Time: ${hold} days.`,
    `Once a month, open ${p.name}'s own points or rewards page from the protocol's official site and screenshot your standing. Cost: nothing; never pay anyone to "unlock" a claim. Time: 10 minutes a month.`,
    `Keep a farm log with the wallet address, every date, amount and transaction hash, then unwind in order: ${book.unwind(p.name, chain)} Cost: about $${gasRound} of gas in total. Time: 20 minutes, plus any unbonding wait.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s));
}
