[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Abdullahbhatti93/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Abdullahbhatti93/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# LaunchScope — Token Launch Radar

An entry for make.fun's **token-radar-01** bounty ("Build the best token launch
radar"), by Abdullah Bhatti.

LaunchScope reads the competition's sealed DefiLlama snapshot and answers three
questions about every protocol in it: does it record a token yet, what would that
token be worth if the protocol's record stayed as it is, and what should a farmer
actually do about it — with costs and times, not slogans.

## The model (CompSet FDV, compset-1)

No protocol is named or special-cased anywhere. One function prices every row
from the snapshot's own figures:

1. **Eligibility.** A protocol joins the board when it records no token and is a
   standalone product — not a wrapped, staked or bridged version of a token that
   already trades, not an exchange's own product, not a versioned pool of
   another protocol. This is the snapshot's own watchlist test with the TVL
   floor removed, applied at every size: all 40 watchlist slugs are covered,
   and the smaller early protocols below the floor are found by the same rule.
2. **Category comparables.** For each traded protocol, the market cap divided
   by its TVL (winsorized to 0.02–3.00). A category's multiple is the median of
   its traded protocols' ratios, blended toward the market-wide median by
   sample count and clamped to 0.05–2.00. Categories with no traded protocol
   are priced at the market median.
3. **Adjustments.** Implied value = TVL × category multiple, then a momentum
   factor from the seven-day TVL change (clamped to −60%…+120%, weight 0.30),
   a maturity factor for how long the protocol has run with no token (0.72 up
   to 1.10 over five years), and a breadth factor of +2.5% per extra chain,
   up to eight.

Every row carries its own multiple, sample count and three factors, so any
number on the board can be checked by hand from the dashboard's detail view.

## Farm plans

Each row's plan is generated from its own record: the category decides the work
(lend, provide liquidity, bridge, stake, vault, …), the first chain decides the
gas bill, the TVL decides the sensible position size ($50–$500), and the age
decides how long the position must be held to count (30–60 days). Eight steps
per protocol, each naming its cost and its time.

## Running it

Node 22, standard library only, no network:

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

The program writes `board.json`, `data.js`, a copy of `dashboard/` and
`screenshots/`, and `dossier.json` (built with `vendor/makefun-board.ts`) into
the output directory, after checking its own board against the gate's rules.
In the grader's container it simply reads `/input/snapshot.json` and writes
`/output`. Two runs over the same snapshot write identical bytes.

## Layout

- `main.ts` — entry point: build, self-check, outputs, dossier.
- `lib/model.ts` — snapshot parsing, eligibility, the comparables model.
- `lib/farm.ts` — the farm-plan generator (category playbooks, chain gas table).
- `dashboard/` — the static page (board, live comparison set, model view).
- `screenshots/` — the board, a protocol detail view, and a filtered view,
  rendered from the finished page.
- `vendor/makefun-board.ts` — the competition's dossier library, shipped
  byte-identical to the kit's copy, as the gate requires.

## Honesty notes

Implied values are this model's own estimates, never predictions that a token
will be issued. A protocol is described as *recording no token* — the snapshot
is a record, not proof. Protocols that already trade are shown separately with
the market's own figures; the model never prices them.
