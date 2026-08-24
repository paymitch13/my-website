// What a dollar of FAAB is worth.
//
// Cash is a real trade asset and almost no calculator prices it, because the
// honest answer is league-specific: a dollar in a league where nobody bids is
// worth nothing, and a dollar in a league where the waiver wire is a bloodbath
// is worth a great deal. Picking a constant would be picking a number that is
// wrong in every league except by accident.
//
// So the rate is measured from the league's own behaviour wherever possible.
// Every waiver claim of the season carries its winning bid, and the app already
// downloads them for the transaction feed. Regressing bid against the claimed
// player's value gives this league's own observed points-per-dollar. Before
// enough bids exist to fit anything, a market-clearing rate stands in: the
// value sitting in the free-agent pool divided by the cash chasing it.

import { valuePlayer } from './valuation.js';
import { marginalValue } from './lineup.js';
import { sortBy } from './util.js';

/** Bids below this are noise -- speculative $1 stashes, not a price signal. */
const MIN_MEANINGFUL_BID = 1;

/** Fewer observations than this and a fit is not a measurement, it is a guess. */
export const MIN_OBSERVATIONS = 4;

/**
 * Value units per dollar, measured from this league's own winning bids.
 *
 * Least squares through the ORIGIN, not an ordinary regression: a $0 bid buys
 * nothing, and a fitted intercept would either invent value for free claims or
 * charge an entry fee for the first dollar. Both are wrong, and the constraint
 * is free.
 *
 * @param {Array}  transactions normalized transactions (transactions.js)
 * @param {object} players      id -> player
 * @param {object} ctx          valuation context
 * @param {Map}    rankings     board used to value the claimed player
 * @returns {{rate:number, samples:number, median:number, max:number, bids:Array}|null}
 */
export function observedFaabRate(transactions, players, ctx, rankings) {
    const points = [];

    for (const tx of transactions || []) {
        // Sleeper labels a successful claim `waiver`; `free_agent` adds cost
        // nothing and would drag the fit toward zero.
        if (tx.type !== 'waiver') continue;
        const bid = tx.bid;
        if (!Number.isFinite(bid) || bid < MIN_MEANINGFUL_BID) continue;

        const added = tx.movements.find((m) => m.to !== null && m.from === null);
        const player = added?.player && players[added.player.id];
        if (!player) continue;

        const value = valuePlayer(player, rankings?.get(player.id) ?? 999, ctx).value;
        if (!(value > 0)) continue;

        points.push({ bid, value, player, week: tx.week ?? null });
    }

    if (points.length < MIN_OBSERVATIONS) return null;

    // Slope through the origin: sum(x*y) / sum(x*x), with bid as x.
    const num = points.reduce((s, p) => s + p.bid * p.value, 0);
    const den = points.reduce((s, p) => s + p.bid * p.bid, 0);
    if (!(den > 0)) return null;

    const sorted = sortBy(points, (p) => p.bid).map((p) => p.bid);
    return {
        rate: num / den,
        samples: points.length,
        median: sorted[Math.floor(sorted.length / 2)],
        max: sorted[sorted.length - 1],
        bids: points,
    };
}

/**
 * The rate implied by supply and demand when there is no bid history to read.
 *
 * Every dollar of unspent FAAB in the league is chasing the same free-agent
 * pool. If the pool holds 60 points of usable value and the league is holding
 * $600, a dollar buys a tenth of a point -- whatever anyone believes about it.
 *
 * Usable value, not raw value: a free agent is only worth what he would add to
 * the lineup of the team that signs him, which is what marginalValue measures.
 * Twelve identical waiver receivers are not twelve times one receiver.
 *
 * @param {object} input
 * @param {Array}  input.freeAgents  entries [{player, score, value}] not on a roster
 * @param {Array}  input.teams       every team, for remaining budget
 * @param {object} input.cfg
 * @param {Function} [input.entriesFor] team -> valued entries, for lineup fit
 */
export function marketClearingRate({ freeAgents, teams, cfg, entriesFor = null }) {
    const budget = (teams || []).reduce((s, t) => s + Math.max(0, t.faabRemaining ?? 0), 0);
    if (!(budget > 0) || !freeAgents?.length) return null;

    // Only the top of the pool is ever claimed; the long tail is free.
    const pool = sortBy(freeAgents, (e) => e.value, -1).slice(0, Math.max(8, (teams?.length ?? 12) * 2));

    let supply = 0;
    if (entriesFor && teams?.length) {
        // What the pool is worth to the teams that would actually sign from it:
        // the best marginal lineup gain any one roster would get, per player.
        const rosters = teams.map((t) => entriesFor(t));
        for (const fa of pool) {
            let best = 0;
            for (const entries of rosters) {
                const gain = marginalValue(entries, cfg.starterSlots, fa);
                if (gain > best) best = gain;
            }
            supply += best;
        }
    } else {
        supply = pool.reduce((s, e) => s + Math.max(0, e.value), 0);
    }

    return supply > 0 ? supply / budget : null;
}

/**
 * The rate a specific team's cash is actually worth, after two adjustments the
 * raw rate cannot express.
 *
 * TIME. FAAB expires worthless. A dollar in week 3 has eleven weeks to cash in
 * the player it wins; the same dollar in week 14 has two. The rate scales with
 * the fraction of the season left to spend it in.
 *
 * CONCAVITY. The first dollars are worth more than the last. A team holding $4
 * cannot win a contested claim at all, so its cash is nearly worthless to it --
 * and, importantly, to a trade partner who values what that team can DO with
 * it. A team holding $90 has more than it can plausibly spend. Same treatment
 * as the player curve in tradevalue.js, and for the same reason: the marginal
 * unit is not the average unit.
 *
 * @param {object} input
 * @param {number} input.rate        base value units per dollar
 * @param {number} input.remaining   this team's remaining budget
 * @param {number} input.leagueMean  mean remaining budget across the league
 * @param {number} input.weeksLeft
 * @param {number} [input.seasonWeeks]
 */
export function effectiveFaabRate({ rate, remaining, leagueMean, weeksLeft, seasonWeeks = 14 }) {
    if (!Number.isFinite(rate) || rate <= 0) return 0;

    const timeLeft = Math.max(0, Math.min(1, (weeksLeft ?? 0) / Math.max(1, seasonWeeks)));
    if (timeLeft <= 0) return 0;

    const share = leagueMean > 0 ? Math.max(0, remaining ?? 0) / leagueMean : 1;
    const concavity = share > 0 ? share ** 0.8 : 0;

    return rate * timeLeft * concavity;
}

/** Mean remaining budget, the reference the concavity adjustment is relative to. */
export const meanRemaining = (teams) =>
    teams?.length ? teams.reduce((s, t) => s + Math.max(0, t.faabRemaining ?? 0), 0) / teams.length : 0;

/**
 * One call for everything a view or the trade engine needs to price cash.
 * Returns null when the league does not use FAAB, so every caller can gate on
 * a single check rather than re-deriving the rules.
 */
export function faabModel({
    cfg, teams, transactions, players, ctx, rankings,
    freeAgents = null, entriesFor = null,
}) {
    if (!cfg?.usesFaab) return null;

    const observed = observedFaabRate(transactions, players, ctx, rankings);
    const clearing = observed
        ? null
        : marketClearingRate({ freeAgents: freeAgents || [], teams, cfg, entriesFor });

    const rate = observed?.rate ?? clearing;
    if (!Number.isFinite(rate) || rate <= 0) {
        return { usable: false, rate: 0, source: 'none', budget: cfg.faabBudget, observed: null };
    }

    const mean = meanRemaining(teams);
    return {
        usable: true,
        rate,
        source: observed ? 'observed' : 'clearing',
        samples: observed?.samples ?? 0,
        median: observed?.median ?? null,
        max: observed?.max ?? null,
        budget: cfg.faabBudget,
        leagueMean: mean,
        weeksLeft: ctx.weeksLeft,
        observed,
        /** Value of `dollars` in a specific team's hands, right now. */
        valueOf(dollars, team) {
            if (!(dollars > 0)) return 0;
            const effective = effectiveFaabRate({
                rate,
                remaining: team?.faabRemaining ?? mean,
                leagueMean: mean,
                weeksLeft: ctx.weeksLeft,
            });
            return dollars * effective;
        },
    };
}

/**
 * What this league has actually paid, by how good the player was.
 *
 * "Nobody here has ever paid more than $31" is the single most useful thing to
 * know before accepting cash, and it is knowable exactly -- it is in the
 * transaction log. Bucketed by the claimed player's value, because $30 for a
 * every-week starter and $30 for a handcuff are different facts.
 */
export function bidHistory(model) {
    const bids = model?.observed?.bids;
    if (!bids?.length) return null;

    const sorted = sortBy(bids, (b) => b.value, -1);
    const tierSize = Math.max(1, Math.ceil(sorted.length / 3));
    const names = ['Starters', 'Contributors', 'Fliers'];

    const tiers = [];
    for (let i = 0; i < sorted.length; i += tierSize) {
        const group = sorted.slice(i, i + tierSize);
        const amounts = sortBy(group, (b) => b.bid).map((b) => b.bid);
        const top = sortBy(group, (b) => b.bid, -1)[0];
        tiers.push({
            label: names[tiers.length] ?? `Tier ${tiers.length + 1}`,
            count: group.length,
            median: amounts[Math.floor(amounts.length / 2)],
            max: amounts[amounts.length - 1],
            min: amounts[0],
            topPlayer: top.player,
            topBid: top.bid,
        });
    }

    const all = sortBy(bids, (b) => b.bid).map((b) => b.bid);
    const richest = sortBy(bids, (b) => b.bid, -1)[0];
    return {
        tiers,
        samples: bids.length,
        median: all[Math.floor(all.length / 2)],
        max: all[all.length - 1],
        total: all.reduce((s, b) => s + b, 0),
        richest,
    };
}

/**
 * The free-agent pool, ranked by what each player would actually add to ONE
 * specific team's lineup.
 *
 * This is the number that makes cash legible. $20 to a team with a hole at
 * running back buys a real upgrade; the same $20 to a team with no holes buys
 * a bench body. Raw free-agent value cannot tell those apart and marginalValue
 * can, which is precisely what it is for.
 *
 * @param {object} input
 * @param {Array}  input.freeAgents entries not on any roster
 * @param {Array}  input.entries    the receiving team's valued roster
 * @param {object} input.cfg
 * @param {Map}    [input.trending] playerId -> adds in the last day
 */
export function waiverTargets({ freeAgents, entries, cfg, trending = null, limit = 8 }) {
    if (!freeAgents?.length || !entries) return [];

    const rows = freeAgents.map((fa) => ({
        player: fa.player,
        posRank: fa.posRank,
        value: fa.value,
        score: fa.score,
        gain: marginalValue(entries, cfg.starterSlots, fa),
        demand: trending?.get(fa.player.id) ?? 0,
    }));

    // Ranked by lineup gain, not by value: a better player who cannot crack
    // this lineup is worth less to THIS team than a worse one who starts.
    return sortBy(rows, (r) => r.gain, -1)
        .filter((r) => r.gain > 0.05)
        .slice(0, limit);
}

/** What a target would plausibly cost, given what this league pays. */
export function estimateBid(model, target) {
    if (!model?.usable || !(target?.value > 0)) return null;
    const perDollar = model.rate;
    if (!(perDollar > 0)) return null;

    const dollars = Math.max(1, Math.round(target.value / perDollar));
    // Never quote above what anyone here has ever actually paid: the fit is a
    // line through a handful of points and extrapolating it past the observed
    // range invents prices this league has never seen.
    const cap = model.max ?? dollars;
    return {
        dollars: Math.min(dollars, Math.max(cap, 1)),
        capped: dollars > cap,
        cap,
    };
}

/**
 * One sentence about what a cash amount means in this league.
 *
 * Rest-of-season points AND points per week, because those answer different
 * questions: the total is what the value ledger is denominated in, and the
 * weekly number is the one a manager can compare against the starter he is
 * being asked to give up.
 */
export function describeFaab(model, dollars, team) {
    if (!model?.usable || !(dollars > 0)) return null;
    const value = model.valueOf(dollars, team);
    if (!(value > 0)) {
        return `$${dollars} is worth essentially nothing here — there is not enough of the season left to spend it.`;
    }
    const perWeek = value / Math.max(1, model.weeksLeft || 1);

    const basis =
        model.source === 'observed'
            ? `the median winning bid in this league is $${model.median} across ${model.samples} claim${model.samples === 1 ? '' : 's'}`
            : 'nobody has bid yet this season, so this is priced off what is left in the free-agent pool against the cash chasing it';

    return (
        `$${dollars} is worth roughly ${value.toFixed(1)} rest-of-season points, about ${perWeek.toFixed(1)} a week — ${basis}. ` +
        'It adds nothing to this week\'s lineup and it does not take a roster spot.'
    );
}
