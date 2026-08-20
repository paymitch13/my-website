# Fantasy Command Center

*A fantasy football decision engine. Live at
[paymitch13.github.io/my-website](https://paymitch13.github.io/my-website/).*

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

As the season progresses, preseason projections are blended with what players have **actually
done**. Early on a hot three games is mostly noise so the projection holds; by the back half of
the year results carry most of the weight, capped so the prior never fully retires.

### Depth is not worthless

A player at replacement level is not worth zero, and a player below it is not worth the same as
every other player below it. An earlier version clamped the whole sub-replacement tail to a
single floor, which made a starting running back display the same value as a fourth-string
handcuff. Value now passes through a softplus: strictly decreasing with rank, positive
everywhere, and asymptotically equal to points-above-replacement for genuine starters.

## The pieces

| Module | Job |
|---|---|
| `js/projections.js` | Sleeper projections + actuals, scored against league rules |
| `js/valuation.js` | Rank → projection curve → league-scored points → value |
| `js/odds.js` | Vegas lines → implied team totals (weekly context only) |
| `js/lineup.js` | Optimal starting lineup solver (FLEX / SUPER_FLEX aware) |
| `js/sim.js` | Monte Carlo season + bracket simulator → playoff and title odds |
| `js/trade.js` | The trade engine: value, fit, impact, verdict and written reasoning |
| `js/power.js` | Payton Mitchell Power Rankings |
| `js/rankings.js` | The customizable board, CSV import/export, auto-tiering |
| `js/data.js` | Sleeper → the shapes the engines expect |
| `js/news.js` | Injury / waiver / transaction feed, scored for real impact |
| `js/startsit.js` | Weekly start/sit engine: Vegas, matchup, weather, health |
| `js/matchup.js` | Defense-vs-position difficulty, computed from weekly results |
| `js/weather.js` | Stadium forecasts and position-weighted weather impact |
| `js/transactions.js` | League transaction history, trade log, per-player history |

The lineup solver places players best-first into the most restrictive slot they qualify for.
For the usual slot set the eligibility sets are nested, and greedy is provably optimal on a
nested family; leagues that mix crossing slots (`WRRB_FLEX` alongside `REC_FLEX`) break that
nesting, so a swap-improvement pass cleans up the remainder.

The simulator runs the "before trade" and "after trade" seasons against the **same seeded
random weeks**, so the difference between them is the trade rather than sampling noise.

## Start / Sit

The weekly projection is the starting point, not the answer. Four multiplicative adjustments sit
on top of it, each computed from real data and each shown separately so a call can always be
explained — and disagreed with:

- **Vegas** — implied team total, the best available proxy for how many points an offense will
  have to distribute. Measured against **this week's slate average**, not a fixed number: in a
  low-scoring week a 21-point team is an *above*-average spot, and comparing it to a hardcoded
  baseline would call it a bad one.
- **Matchup** — how a defense has actually treated the position, normalized against *each
  player's own* baseline. Holding a WR1 to 9 points is an achievement; holding a WR60 to 9 is
  not. Damped toward neutral, because a handful of games is a noisy estimate.
- **Weather** — wind and precipitation, weighted by position. Wind is the single most reliable
  suppressor of passing and kicking; a back barely notices, and in a downpour a run-heavy script
  can even help him. Domes are excluded outright rather than given a "good weather" bonus.
- **Health** — injury designations discounted by expected availability.

The output is a recommended lineup, a diff against what you currently have set in Sleeper, and
the close calls — decisions within 2.5 points, which are the only ones actually in doubt.

Individual player props would be a natural fifth input, but no free, CORS-open source for them
exists, so they are not part of this rather than being faked.

## Trades that actually get accepted

Closing a value gap is a constraint, not a goal. An earlier version of the add-on suggester
ranked candidates purely on how close their value was to the gap, which produced nonsense — it
would happily propose the giving team's starting running back, or a fourth-string body nobody
wants, as long as the number lined up.

A suggestion now has to satisfy all three:

1. **The giver can spare him** — he costs their optimal lineup little, because they have surplus
   at that position.
2. **The receiver wants him** — he improves their optimal lineup.
3. **He roughly closes the gap** without wildly overshooting it.

Ranking by (2) minus (1) with a penalty on (3) surfaces genuine surplus-for-need swaps, which
are the deals that really get done. Two-player packages are offered when no single player fits.

## Trade log

Completed trades across the season are pulled from Sleeper and shown as a league trade log, with
each side's gives and gets, draft picks and FAAB. The app polls while open, so a trade accepted
in Sleeper appears within a couple of minutes and the rosters it touched are re-synced. Every
player's card carries his own transaction history — drafted, traded, dropped, claimed.

## Power rankings

A record is a bad power ranking. Two teams at 4-2 can be completely different teams. The board
blends what a team *is* with what it has actually *done*, corrected for luck.

There is no single correct weighting, and most disagreements between power-ranking sites are
disagreements about this table rather than about the data. Most public rankings lean hard on
record; this one leans on roster strength. Rather than hide that choice, it is a control:

| Preset | Roster | All-play | Title odds | Form | Depth |
|---|---|---|---|---|---|
| Roster-first | 58% | 10% | 14% | 6% | 12% |
| **Balanced** (default) | 40% | 20% | 20% | 10% | 10% |
| Results-first | 22% | 36% | 24% | 14% | 4% |

All-play record is what your record would be if you played every team every week, which strips
out schedule luck almost entirely. Before week 1 there is no performance signal at all, so
every preset falls back to roster strength.

Each team gets a written blurb that leads with the biggest disconnect between what it is and
what it has done. Strengths and weaknesses are measured against the rest of *your* league —
noting that a team scores fewer points at TE than at RB is true of every roster ever assembled
and therefore worth nothing.

## Data

| Source | Used for | Key needed |
|---|---|---|
| Sleeper API | Players, leagues, rosters, matchups, live scoring | No |
| Sleeper projections | Projected stat lines and season-to-date actuals | No |
| ESPN scoreboard | DraftKings spread / over-under → implied team totals | No |
| Open-Meteo | Stadium weather at kickoff for outdoor venues | No |

All three are public, read-only and CORS-open, so the browser talks to them directly. No key,
no password, no OAuth — a username is enough to find your leagues. Your rankings live in
`localStorage` and never leave the browser.

The ~14MB player database is fetched once and cached for a day in trimmed form (about 300KB).
Projections are cached for six hours, since they move as news breaks.

### On Vegas odds

Vegas is excellent at predicting how many points a team scores in a **specific game**, which
makes it a genuinely useful weekly signal — a back on a 27-point implied team is in a very
different spot than the same back on a 16-point implied team. It is a poor **season-long**
signal: this week's spread says nothing about a player's rest-of-season worth, and the season
projections already price in team quality and offensive environment.

So odds are surfaced as matchup context in the player card and are deliberately **not** folded
into trade value. Doing otherwise would make trade grades swing on a single week's line.

## Known limitations

- **Bye weeks are not modeled.** Sleeper does not publish them and there is no CORS-open NFL
  schedule source, so rather than guess, the app leaves them out. A trade that stacks two
  players on the same bye will not be flagged for it.
- **IDP leagues are partially supported.** Rankings cover offense, kickers and team defenses.
  If your league starts IDP slots the app says so and excludes those slots from every
  calculation rather than silently scoring them as zero.
- **Kicker and defense** are projected and scored from their real stat lines (field-goal
  distance buckets, sacks, points-allowed brackets) under the league's own rules.
- **There is no news wire.** No free, CORS-open NFL wire service exists, so instead of faking
  headlines the feed is built from live signals Sleeper does expose: injury designations,
  waiver-wire momentum, league transactions and in-progress scoring.

## Development

```bash
npm test          # 132 engine tests, no dependencies
```

Everything under `js/` is a plain ES module. `package.json` exists only so Node can run the
tests; the browser loads `js/app.js` directly. There is no build step: what is in the repo is
what the browser runs.

To run it locally you need a server (ES modules do not load over `file://`):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
