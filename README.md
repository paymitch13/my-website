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
| `js/odds.js` | Vegas markets: spread, moneyline, total, opening lines, movement |
| `js/tradevalue.js` | Market-scale trade values |
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
| `js/finder.js` | Three-stage trade search across the whole league |
| `js/needs.js` | Per-roster need and surplus by position |
| `js/usage.js` | Usage trends and touchdown dependence |
| `js/schedule.js` | Bye weeks, and every posted line for the rest of the season |
| `js/outlook.js` | Rest-of-season and playoff-week game environments |
| `js/props.js` | Player props, de-vigged totals, ESPN's model, the player join |
| `js/faab.js` | What a dollar of FAAB is worth, from this league's own bids |
| `js/simclient.js` | Simulation worker client, with a synchronous fallback |

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

There is a fifth adjustment when the market has posted one: **player props**, scored under the
league's own rules and blended with the projection. Where the two disagree materially, the
report says so outright — see [Player props](#player-props-as-a-second-projection).

## Trade Finder

A twelve-team league is roughly 16 of your players against 176 of theirs. One-for-one alone is
~2,800 combinations, and a 2,000-iteration double simulation on each is impossible. So the cost
of evaluation is matched to how many candidates survive:

| Stage | Work | Cost | Candidates |
|---|---|---|---|
| 1 | Need / surplus filter | microseconds | ~2,800 → ~200 |
| 2 | Lineup solve, both directions | milliseconds | ~200 → ~40 |
| 3 | Full evaluation with odds simulation | seconds | ~40 → ~25 |

Everything that survives stage 2 is shown. Only the top slice gets the expensive simulation; the
rest is listed as **also possible** with lineup numbers and a note saying so. Reporting "15
found" and rendering one was the wrong trade-off. A **Balanced only** toggle controls whether
the other side must gain too — on by default, because those are the offers that get accepted,
but a lopsided offer is still worth seeing before you send it.

### Naming a player

The open search infers what you need from roster shape. Naming a player replaces
the inference with a declaration, which is a better-informed question and gets a
different kind of answer.

**Target a player** — *"what would it take to get him?"* The counterparty is
pinned to whoever owns him, stage 1's position guessing is skipped entirely
(nobody wants to be told their target is unavailable because a need heuristic
did not pick that position), and the whole job becomes building the cheapest
package of your players that gets them to yes.

Packages are **enumerated, not grown greedily** — the cheapest acceptable offer
is frequently not the one built outward from your most obvious trade chip, and a
greedy walk never sees that. Two mid-round pieces they can start often beat one
better player they cannot.

Then they are **pruned to the minimal ones**. Losing a player can never raise
your optimal lineup, so once an offer is accepted every superset of it costs you
more and buys you nothing. Without that pruning the search returned 150
"packages" that were four versions of the same deal with free bodies attached;
with it, five genuinely distinct offers, cheapest first, and four times faster.

A targeted search is also **exempt from the odds filter** that governs the open
search. Asking what a player costs and being shown nothing because every version
of the deal costs something is not an answer — the cost is the answer, and it is
on every card as *Cost to your lineup*.

**Offer a player** — *"what could he bring back?"* The give side is pinned and
the whole league is searched for the return, including one-for-two: a team
shopping a star is often the team that wants quantity, and that is the same
consolidation trade read from the other end.

Both at once — *"here's my piece, what else do I need to add?"* — fixes the
target and the bait together and fills in the difference.

### What counts as "they have something to sell"

Surplus is measured as bench depth **above replacement** relative to positional dropoff, not as
low starting points: a team with three startable backs and one flex spot has surplus at running
back even when its starting production looks fine, and two backup quarterbacks out-score spare
backs while being worth nothing, because that production is free on waivers.

Surplus alone is not enough, though — matching only on it silently forbids the two trade shapes
people actually make. Four signals now open a pairing:

| Signal | What it means | The trade it enables |
|---|---|---|
| **surplus** | spare bodies the lineup cannot use | the classic depth-for-need swap |
| **strength** | above-average production per starting slot, even with a bare bench | they sell a star for two starters |
| **star** | one player well above the league's typical best at the position | *my WR3 for your WR1* — the only signal that fires when **both** teams are short |
| **relative** | weakest-by-their-own-standards against strongest-by-theirs | keeps the best roster in the league from being told no deal exists |

That last one matters more than it sounds. Need used to be measured only against the league
average, so a roster above average everywhere registered a deficit nowhere, and the finder told
the team most able to make a deal that there was nothing to look at. Every roster is weakest at
*something* by its own standards, and that is what consolidation trades run on.

Need itself is measured two ways for the same reason: per starting slot (so flexing a back does
not invent a receiver hole), and at the **weakest starter** in the room (so a monster WR1 next
to a waiver body does not average out to "fine" when that team is obviously shopping).

None of this decides whether a trade is good — it only decides what is worth looking at. Stage 2
still has to find a package that improves both lineups, and a bigger package has to buy
something: a second player thrown in that leaves the other lineup exactly where the one-for-one
left it is a player given away for nothing, and those are not proposed.

### They do not share your board

This is what makes or breaks a recommender. `evaluateTrade` values both rosters with *your*
rankings, which is correct for deciding whether **you** want a deal and wrong for predicting
whether **they** accept one. If you are low on a player, valuing his own roster with your board
decides his manager is low on him too, and confidently reports he is available. He is not.

So the counterparty's roster is valued on a **neutral board** — each player's projected rank,
independent of your ordering. Every suggestion reports two numbers:

- **Your gain**, from your board.
- **Their likely answer**, from the neutral board: what they gain in lineup points and playoff
  odds, which is the sentence that decides whether an offer is worth sending.

A trade that lowers your own playoff or title odds is dropped regardless of how much the other
side likes it.

### Buy low and sell high

Every completed week's full stat lines are already downloaded for the matchup profiles. Those
rows carry snap counts, targets, air yards and red-zone volume, which is everything needed for
the two calls people actually want:

- **Buy low** — snap and target share rising while fantasy points stay flat or fall. The role is
  growing and the box score has not caught up.
- **Sell high** — the fraction of a player's points coming from touchdowns. Touchdown rate is
  the least sticky thing in fantasy; a receiver whose usage says WR30 and whose points say WR8
  because of four scores is the textbook sell.

Counterparties are also labelled **buying**, **selling** or **on the bubble** from their
simulated playoff odds, because an 8% team and a 90% team want opposite things.

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

## FAAB is a real asset

Cash is a tradeable asset in a FAAB league and almost no calculator prices it, because the
honest answer is league-specific. A dollar is worth nothing where nobody bids and a great deal
where the wire is a bloodbath, so any fixed rate is wrong everywhere except by accident.

**The rate is measured from the league's own behaviour.** Every waiver claim of the season
carries its winning bid, and the app already downloads them for the transaction feed. Regressing
bid against the claimed player's value — least squares **through the origin**, because a $0 bid
buys nothing and a fitted intercept would either invent free value or charge an entry fee for
the first dollar — gives this league's own points-per-dollar.

Before four priced claims exist, a **market-clearing rate** stands in: the marginal lineup value
sitting in the free-agent pool divided by the cash chasing it. Usable value, not raw value —
twelve identical waiver receivers are not worth twelve times one receiver, and `marginalValue`
is exactly the function that knows the difference.

Two adjustments the raw rate cannot express:

- **Time.** FAAB expires worthless. A dollar in week 3 has eleven weeks to cash in the player it
  wins; the same dollar in week 14 has two.
- **Concavity.** A team holding $4 cannot win a contested claim, so its money is nearly
  worthless to it and to a trade partner. A team at $90 has more than it can plausibly spend.

Through the engine, cash enters **the value ledger and nothing else**. It never touches the
lineup solve, the season simulation, or the roster-crunch charge — so getting $40 for a starter
reads as positive value and negative lineup fit, and the verdict says exactly that. Taking no
roster spot is its one structural advantage and the engine knows it. Cash arriving is priced at
the **receiver's** rate, because $20 to a manager holding $3 buys a claim he could not otherwise
win.

`suggestFaab` proposes cash when no player on the roster closes the gap. That is the most common
real-world sweetener there is and the one the app could not previously make, and it is the
cleanest one available: it costs the giver no lineup points at all.

### What the cash buys

A dollar figure means nothing on its own. "$40" is not something a manager can weigh against a
running back; "$40, and here is what it claims, at prices this league has actually paid" is.

- **Free agents ranked by marginal lineup gain to the specific team receiving the cash.** $20 to
  a team with a hole at running back buys a real upgrade; the same $20 to a team with no holes
  buys a bench body. When nothing on the wire would crack that lineup, the card says so — which
  is the honest case against taking cash for a starter.
- **Bid history bucketed by how good the claimed player was**, because $30 for a weekly starter
  and $30 for a handcuff are different facts. Median, ceiling, and who the priciest claim was.
- **Estimates never quote a price this league has never paid.** The fit is a line through a
  handful of points; extrapolating past the observed range invents prices nobody here has seen.
- **Live waiver demand** from the trending endpoint, because pricing cash without knowing what
  the league is chasing prices it as though nobody else is bidding.
- **A remaining-budget column in the standings.** It says who can still win a claim, and it is
  what makes the cash numbers in the calculator mean anything.

## Trade log

Completed trades across the season are pulled from Sleeper and shown as a league trade log, with
each side's gives and gets, draft picks and FAAB. The app polls while open, so a trade accepted
in Sleeper appears within a couple of minutes and the rosters it touched are re-synced. Every
player's card carries his own transaction history — traded, dropped, claimed. Draft selections
are not included: Sleeper's transactions endpoint does not cover the draft.

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
| ESPN scoreboard | `week.teamsOnBye` → bye weeks for every team | No |

All three are public, read-only and CORS-open, so the browser talks to them directly. No key,
no password, no OAuth — a username is enough to find your leagues. Your rankings live in
`localStorage` and never leave the browser.

The ~14MB player database is fetched once and cached for a day in trimmed form (about 300KB).
Projections are cached for six hours, since they move as news breaks.

## Trade values

The engine works in points above replacement, which is the right unit for deciding anything: it
composes with lineups, schedules and simulations. It is a poor unit for *reading* — a 63 next to
a 58 does not feel like the gap it represents — so values are displayed on the 0–10,000 scale
people know from other calculators.

The rescale itself adds no accuracy, and this document is not going to pretend otherwise. The
part that **is** substantive is the curve. Trade markets are convex: one elite player costs more
than two good ones, because a roster has a fixed number of starting slots and only one can hold
your best player. Points above replacement is close to linear, so on the raw scale two RB20s
look equal to one RB4 — and no manager alive makes that trade. Values are raised to a power
greater than one, which reproduces the premium the market actually charges for consolidation.

## Vegas

Every posted market on the slate, and what each one is good for in fantasy:

| Market | What it tells you |
|---|---|
| **Implied team total** | How many points an offense is expected to score — the best one-number summary of a game environment |
| **Moneyline** | Win probability once the bookmaker's margin is removed by normalizing both sides |
| **Spread** | Game script. A heavy favorite runs it out; a heavy underdog throws forty times |
| **Line movement** | Where the market has moved since opening — weather, injury or news a projection has not absorbed |
| **Favorite flip** | The market changing its mind about who wins, which is news by itself |

ESPN also reports whether the venue is indoors, which is authoritative in a way a hardcoded
stadium table cannot be: it handles relocations, new roofs and neutral-site games.

### What the scoreboard does not carry

The scoreboard endpoint gives the total and the spread but not the **juice** on them, and a
total posted at −120 over is not the total it appears to be — the market's real expectation sits
above the number. ESPN's core API carries the priced pair, and de-vigging it recovers the number
the market actually believes. Implied team totals are the single input the whole Start/Sit
engine hangs on, so half a point of free precision is worth the request. Verified live across 22
priced games: corrections of 0.04 to 0.17 points, folded all the way through to each team's
context rather than left in a second copy that disagrees with the first.

The same API carries **ESPN's own win-probability model**, which is a model rather than a
market. Its value is precisely that it is independent: when the model and the moneyline diverge
by more than five points that is genuinely interesting, and nothing else in the app can see it.

Providers are parsed as a list rather than indexed at `[0]`. ESPN returns one book today and the
shape supports more, so a consensus and a book-disagreement measure arrive free the moment a
second one appears.

### Player props, as a second projection

Every other number in this app descends from one source: Sleeper's consensus projection. A
posted player prop is a number produced by people with money at risk.

Props come back in markets — passing yards, receptions, rushing touchdowns — that map directly
onto the stat keys a league's `scoring_settings` already uses, so a market line is scored by the
league's own rules with the same dot product that prices a projection. No special casing.

Where the market and the projection disagree materially, **Start/Sit says so outright**, with
the line movement since open. That is the most actionable single line a start/sit tool can
print. Disagreement is measured relative to the projection, because two points apart on a
20-point quarterback is noise and two points apart on a 5-point tight end is the whole decision.

Two things that would otherwise have failed silently:

- Sleeper carries `espn_id` for only about **23%** of currently rostered skill players — Kyle
  Pitts and Bucky Irving both lack it — so an id-only join would have had no market for three
  quarters of a roster while appearing to work. Names fill the rest in, normalized past "D.J."
  vs "DJ" and the suffixes the two databases punctuate differently, and every resolution is
  cached permanently because a player's name does not change.
- **One lonely market is not a projection.** A receiving-yards line with no touchdown market is
  a fact about receiving yards; scoring it as a whole projection would systematically
  under-project everyone whose other markets have not been posted yet.

Props are not posted in preseason, so the app degrades to the consensus projection it already
had — which is a normal state, not an error.

### The season ahead, not just Sunday

The Vegas tab used to load only the current week, which makes it a lineup tool. Trades are not
about this week.

ESPN posts lines for **every week of the season in advance** — verified: weeks 1, 2, 8, 15 and
17 all come back fully priced — and the bye-week sweep was already fetching one scoreboard
payload per week and throwing `payload.events` away. Parsing what was already on the wire turns
a bye map into a rest-of-season outlook at no additional network cost:

- **Rest-of-season implied totals** per team, ranked. Byes are skipped rather than counted as a
  zero: a team with a week-9 bye does not have a worse offense.
- **Fantasy playoff weeks specifically**, read from the league's own `playoff_week_start`. A team
  can be fine all year and collapse in weeks 15–17, and those are the only weeks that decide
  anything. "His three playoff-week games are all against top-five scoring environments" is the
  argument that closes a trade.

### On using Vegas for value

This is the one place the app changed its mind.

A **single week's** line still says nothing about a player's rest-of-season worth, and letting it
move trade grades would be wrong. But a **season-long average** of implied totals is a different
quantity, and it is real: a back on the offense with the league's best remaining schedule is
worth more than an equal back whose schedule collapses in November.

So rest-of-season schedule strength does feed trade value, deliberately gently. Lines eleven
weeks out are real information but they are not Sunday's information — they move, players get
hurt, and a season-long average of soft numbers is a weaker signal than a posted line. A 10%
swing in implied points is worth a few percent of value, not ten, and a test pins that down.

## Deliberate non-features

- **Divisions in playoff seeding** — Sleeper exposes them, the simulator seeds purely on record
  and points for. Correct for most leagues, wrong for divisional ones.
- **Draft picks in offers** — picks are parsed and shown in the trade log, but cannot yet be put
  into a proposed trade. In dynasty leagues that is a real gap.
- **Manual tiering** — tiers are derived from gaps in projected value, not hand-drawn.

## Known limitations

- **IDP leagues are partially supported.** Rankings cover offense, kickers and team defenses.
  If your league starts IDP slots the app says so and excludes those slots from every
  calculation rather than silently scoring them as zero.
- **Kicker and defense** are projected and scored from their real stat lines (field-goal
  distance buckets, sacks, points-allowed brackets) under the league's own rules.
- **There is no news wire.** No free, CORS-open NFL wire service exists, so instead of faking
  headlines the feed is built from live signals Sleeper does expose: injury designations,
  waiver-wire momentum, league transactions and in-progress scoring.
- **Player props depend on a name join for most players.** Sleeper's `espn_id` covers about a
  quarter of rostered skill players, so the rest are matched on normalized name and position.
  That is reliable for the players anybody trades and can miss an obscure one; a player with no
  match simply keeps his consensus projection.
- **FAAB is priced from a small sample early.** The rate is fitted from this league's own
  winning bids, and before four priced claims exist it falls back to a market-clearing estimate.
  Both are stated on screen rather than presented as a single confident number.

## Development

```bash
npm test          # 303 engine tests, no dependencies
npm run smoke     # browser check: boots the app, visits every tab at four widths
```

`npm test` covers the engine — valuation, lineups, simulation, needs, the finder funnel, trade
evaluation, FAAB pricing, the betting markets and the season outlook. It also runs two lints
that exist because of bugs that actually shipped:

- **Display scale.** There are two number scales in this app — raw points above replacement and
  the convex market value — and both are plain numbers that look identical in source. The picker
  once rendered one and the panel behind it rendered the other, so choosing a player changed his
  number from 47 to 6,240 with a single click. The lint asserts no render site prints a raw
  value, and is itself verified to catch that exact regression.
- **Imports.** `node --check` parses a file without resolving anything in it, so a view could
  call an identifier it never imported, pass every syntax check, and throw the moment a user
  opened that tab. The views cannot simply be imported in Node to find out, because they reach
  `app.js` and its `document` access, so the lint reads the imports and the exports and compares
  them.

It is the fast loop and it has no dependencies.

`npm run smoke` is the slow one: it serves the real files, fulfils every Sleeper, ESPN and
weather request from a fixture so the run is hermetic and repeatable, then boots the app and
visits all eight tabs at 360, 414, 768 and 1280 pixels. It fails on any page error, any view
that renders nothing, and any box that sticks out past the viewport. It needs `playwright-core`
and a Chromium binary (`CHROMIUM_PATH=... npm run smoke` to point at one), which is why it is
kept out of `npm test`. It is the check that the engine being right actually reaches the screen
— it is what caught the rankings tab throwing when the player database failed to download, and
the scoreboard pushing a phone sideways by 20 pixels.

Everything under `js/` is a plain ES module. `package.json` exists only so Node can run the
tests; the browser loads `js/app.js` directly. There is no build step: what is in the repo is
what the browser runs.

To run it locally you need a server (ES modules do not load over `file://`):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
