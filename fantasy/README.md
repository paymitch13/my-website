# Fantasy Command Center

A fantasy football trade calculator and power-rankings engine built on **your own player
rankings**, evaluated against **your league's actual settings**, and scored by **what a trade
does to your playoff and title odds**.

It runs entirely in the browser. No build step, no bundler, no server, no account — the whole
thing is ES modules loaded straight off static hosting, so it deploys with the rest of the site.

## Why it is not just another trade calculator

Most trade calculators answer one question — *which pile of players is worth more?* — and that
question is close to useless on its own, because value is zero sum. If I send you 100 and you
send me 90, the ledger says I won, and the ledger is often wrong: the 90 might start for me
every week while the 100 rode my bench behind better players.

So the engine answers three separate questions and reports them separately.

| | What it measures | Zero sum? |
|---|---|---|
| **Value** | Rest-of-season points above replacement moving each way | Yes |
| **Fit** | What each side's *optimal starting lineup* actually gains | **No** — a good trade improves both |
| **Impact** | How each side's playoff and title odds move over the real remaining schedule | No |

Impact is the headline. Value is the sanity check. Fit explains the gap between them.

## How a ranking becomes a number

```
positional rank → estimated per-game stat line → points under THIS league's
scoring → points above replacement → rest-of-season value
```

Going through a stat line instead of a hardcoded points table is what makes the calculator
league-aware for free. A 6-point-passing-TD superflex league and a standard-scoring 10-teamer
read the same rankings and get genuinely different values, because the scoring settings are
applied to modeled production rather than bolted on afterwards as a fudge factor.

Concretely, the engine derives from the league itself:

- **Replacement level per position**, from the actual starting slots — this is what makes an
  elite QB worth two to three times as much in superflex without any special-casing.
- **PPR / half-PPR / standard, TE premium, passing TD and yardage values**, applied to the
  estimated stat line.
- **Roster size**, so a deal that forces cuts is charged for the players lost.
- **Redraft vs. dynasty**, switching on positional aging curves. The running back cliff is the
  sharpest effect in fantasy and the constants say so.
- **Injury designations**, discounted by expected games missed against the weeks remaining —
  the same tag costs more in week 13 than in week 3.

## The pieces

| Module | Job |
|---|---|
| `js/valuation.js` | Rank → stat line → league-scored points → value |
| `js/lineup.js` | Optimal starting lineup solver (FLEX / SUPER_FLEX aware) |
| `js/sim.js` | Monte Carlo season + bracket simulator → playoff and title odds |
| `js/trade.js` | The trade engine: value, fit, impact, verdict and written reasoning |
| `js/power.js` | Payton Mitchell Power Rankings |
| `js/rankings.js` | The customizable board, CSV import/export, auto-tiering |
| `js/data.js` | Sleeper → the shapes the engines expect |
| `js/news.js` | Injury / waiver / transaction feed, scored for real impact |

The lineup solver places players best-first into the most restrictive slot they qualify for.
For the usual slot set the eligibility sets are nested, and greedy is provably optimal on a
nested family; leagues that mix crossing slots (`WRRB_FLEX` alongside `REC_FLEX`) break that
nesting, so a swap-improvement pass cleans up the remainder.

The simulator runs the "before trade" and "after trade" seasons against the **same seeded
random weeks**, so the difference between them is the trade rather than sampling noise.

## Power rankings

A record is a bad power ranking. Two teams at 4-2 can be completely different teams. The board
blends what a team *is* with what it has actually *done*, corrected for luck:

- 40% roster strength (optimal lineup under your rankings)
- 20% all-play record — what your record would be if you played everyone every week, which
  strips out schedule luck almost entirely
- 20% simulated title odds
- 10% recent form
- 10% injury resilience

Before week 1 there is no performance signal, so it falls back to roster strength.

Each team gets a written blurb that leads with the biggest disconnect between what it is and
what it has done. Strengths and weaknesses are measured against the rest of *your* league —
noting that a team scores fewer points at TE than at RB is true of every roster ever assembled
and therefore worth nothing.

## Data

Everything comes from the public, read-only [Sleeper API](https://docs.sleeper.com/). No key,
no password, no OAuth — a username is enough to find your leagues. Your rankings live in
`localStorage` and never leave the browser.

The ~14MB player database is fetched once and cached for a day in trimmed form (about 300KB).

## Known limitations

- **Bye weeks are not modeled.** Sleeper does not publish them and there is no CORS-open NFL
  schedule source, so rather than guess, the app leaves them out. A trade that stacks two
  players on the same bye will not be flagged for it.
- **IDP leagues are partially supported.** Rankings cover offense, kickers and team defenses.
  If your league starts IDP slots the app says so and excludes those slots from every
  calculation rather than silently scoring them as zero.
- **Kicker and defense values** use direct points-per-game curves instead of a modeled stat
  line, because their scoring is driven by events that barely correlate with a box score.
- **There is no news wire.** No free, CORS-open NFL wire service exists, so instead of faking
  headlines the feed is built from live signals Sleeper does expose: injury designations,
  waiver-wire momentum, league transactions and in-progress scoring.

## Development

```bash
npm test          # 62 engine tests, no dependencies
```

Everything under `js/` is a plain ES module. `package.json` exists only so Node can run the
tests; the browser loads `js/app.js` directly.
