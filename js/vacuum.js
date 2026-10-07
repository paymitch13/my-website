// Trade value in a vacuum: players only, no rosters, no lineups, no league.
//
// Every other surface in this app answers "is this good FOR ME" -- which is
// the better question and needs a synced league, a starting lineup and a
// schedule. This one answers the narrower question that gets asked far more
// often: who won the trade?
//
// That question comes up in two shapes, and neither has a roster attached:
//
//   - A trade that already happened, in this league or somebody else's, that
//     the manager wants scored after the fact.
//   - A pure hypothetical -- "would you do X for Y" -- with no intention of
//     either side being real.
//
// So nothing here reads a roster. The inputs are two lists of players and a
// league FORMAT, because format is what actually moves these numbers: a tight
// end is worth one thing in a TE-premium league and another thing in standard,
// and a quarterback is worth roughly double in superflex. Letting the format be
// chosen is the difference between a calculator that answers the question and
// one that answers it for a twelve-team half-PPR league and hopes.
//
// ONE HONEST LIMITATION, stated here and in the UI: prices are what players are
// worth NOW, not what they were worth on the day an old trade was made. There
// is no historical market feed behind this, and pretending otherwise would be
// the single most misleading thing this tool could do -- "you won that trade"
// is a very different claim from "you would win that trade today".

import { normalizeLeague } from './league.js';
import { fairness, createTradeValueScale } from './tradevalue.js';
import { createValuationContext, valuePlayer } from './valuation.js';
import { buildSeedKeys, seedOrder, toRankMap } from './rankings.js';
import { marketPriceCurve } from './market.js';
import { priceOf } from './trade.js';
import { sum } from './util.js';

/** Scoring presets, named the way managers name them. */
export const PPR_PRESETS = [
    { id: 'std', label: 'Standard', rec: 0 },
    { id: 'half', label: 'Half PPR', rec: 0.5 },
    { id: 'full', label: 'Full PPR', rec: 1 },
];

/** The format knobs that genuinely change what a player is worth. */
export const DEFAULT_SHAPE = {
    teams: 12,
    ppr: 'half',
    superflex: false,
    tePremium: 0,
    dynasty: false,
};

export const TE_PREMIUM_CHOICES = [0, 0.5, 1];

/**
 * Build a league configuration from the format knobs alone.
 *
 * Deliberately a *synthetic* league: starting slots are the standard set, with
 * the superflex swapped in when asked, because replacement level has to come
 * from somewhere and "the normal shape" is the only defensible default when
 * nobody has named a real league.
 */
export function shapeToCfg(shape = {}) {
    const s = { ...DEFAULT_SHAPE, ...shape };
    const rec = PPR_PRESETS.find((p) => p.id === s.ppr)?.rec ?? 0.5;
    const teams = Math.min(20, Math.max(4, Math.round(Number(s.teams) || 12)));

    const roster = [
        'QB', 'RB', 'RB', 'WR', 'WR', 'TE',
        s.superflex ? 'SUPER_FLEX' : 'FLEX',
        'K', 'DEF',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ];

    return normalizeLeague({
        league_id: 'vacuum',
        name: 'Vacuum',
        settings: { num_teams: teams, playoff_teams: Math.max(2, Math.round(teams / 3)), playoff_week_start: 15, type: s.dynasty ? 2 : 0 },
        scoring_settings: {
            rec,
            // A TE premium is extra points per reception for tight ends only,
            // which is exactly what Sleeper's `bonus_rec_te` key means -- so it
            // flows through the same dot product as everything else and needs
            // no special casing in the valuation.
            bonus_rec_te: Number(s.tePremium) || 0,
        },
        roster_positions: roster,
    });
}

/** A one-line description of the format a verdict was reached under. */
export function describeShape(shape = {}) {
    const s = { ...DEFAULT_SHAPE, ...shape };
    const bits = [`${s.teams}-team`, PPR_PRESETS.find((p) => p.id === s.ppr)?.label ?? 'Half PPR'];
    if (s.superflex) bits.push('superflex');
    if (Number(s.tePremium) > 0) bits.push(`TE +${s.tePremium}`);
    bits.push(s.dynasty ? 'dynasty' : 'redraft');
    return bits.join(' · ');
}

/**
 * Everything needed to price players under one chosen format.
 *
 * Note what this deliberately does NOT use: the user's own board. Every other
 * surface in the app values the user's players the way the user ranks them,
 * which is right when the question is "do I want this deal". It is wrong here.
 * "Who won this trade" is not a question about one manager's opinion, and a
 * verdict that moved because the person asking had slid somebody down their
 * board would be worthless for settling an argument. So ranks come from the
 * projections, scored under THIS format.
 */
export function buildVacuumContext({
    players,
    projections = null,
    actuals = null,
    market = null,
    shape = DEFAULT_SHAPE,
    week = 1,
    weeksLeft = 14,
}) {
    const cfg = shapeToCfg(shape);

    // Rank every player against his own position under this format's scoring.
    const seedKeys = buildSeedKeys(players || {}, {
        projections,
        scoring: cfg.scoring,
        actuals,
        week,
        marketRanks: market?.ranks || null,
    });
    const order = seedOrder(players || {}, { seedKeys });
    const ranks = toRankMap(order);

    const ctx = createValuationContext(cfg, {
        week,
        weeksLeft,
        projections,
        actuals,
        market,
    });

    // One scale for the whole pool, so the chips and the totals agree.
    const raw = [];
    for (const list of Object.values(order)) {
        list.forEach((id, i) => {
            const player = players?.[id];
            if (player) raw.push(valuePlayer(player, i + 1, ctx).value);
        });
    }
    const tradeValue = createTradeValueScale(raw, { marketCurve: marketPriceCurve(market) });

    /**
     * Price one player on the displayed scale.
     *
     * The HIGHER of the two prices, which is deliberately different from the
     * rest of the app and the difference matters.
     *
     * Everywhere else, a price answers "what will his manager ask for him",
     * and the observed market price is simply the better answer -- so it wins
     * outright. Here the question is "what is he worth under THIS format", and
     * the format has to bite. The market can only be queried for the shapes
     * FantasyCalc models: team count, quarterback count, points per reception
     * and dynasty. It has no concept of a TE premium at all. So market-first
     * pricing would have made that control inert, and turning superflex on
     * changed nothing in the fixture at all -- which is how this was caught.
     *
     * Taking the maximum keeps both properties. The rank-derived price
     * responds to every format knob, so a premium tight end and a superflex
     * quarterback move as they should. The market price acts as a floor, which
     * is the right shape for the thing it is correcting: a bench player's worth
     * is option value, and option value is a floor under points above
     * replacement rather than a rescaling of it.
     */
    const pricePlayer = (player) => {
        if (!player) return 0;
        const rank = ranks.get(player.id) ?? 999;
        const raw = valuePlayer(player, rank, ctx).value;
        const byFormat = tradeValue(raw);
        const byMarket = priceOf({ player, value: raw }, ctx, tradeValue);
        return Math.max(byFormat, byMarket);
    };

    return { cfg, ctx, ranks, order, tradeValue, pricePlayer, shape: { ...DEFAULT_SHAPE, ...shape } };
}

/**
 * Score a two-sided trade from player prices alone.
 *
 * `sides` are the players each side SENDS. Note the inversion that trips
 * everybody up, including an earlier version of this file: side A's benefit is
 * the value of what side B sent. The totals are reported as RECEIVED, because
 * that is what "who won" is about.
 *
 * @param {object} input
 * @param {Array} input.a      entries side A sends
 * @param {Array} input.b      entries side B sends
 * @param {Function} input.price  entry -> displayed value
 */
export function scoreVacuumTrade({ a = [], b = [], price }) {
    const priced = (list) =>
        list.map((e) => ({ entry: e, player: e.player, value: price(e) })).sort((x, y) => y.value - x.value);

    const sentA = priced(a);
    const sentB = priced(b);
    const outA = sum(sentA, (r) => r.value);
    const outB = sum(sentB, (r) => r.value);

    // Received, not sent: A receives what B sent.
    const receivesA = outB;
    const receivesB = outA;

    const split = fairness(receivesA, receivesB);
    const diff = receivesA - receivesB;

    return {
        sentA,
        sentB,
        receivesA,
        receivesB,
        diff,
        gap: split.gap,
        winner: Math.abs(diff) < 1e-9 ? null : diff > 0 ? 'a' : 'b',
        // Who ends up with the single best player in the deal. A trade can be
        // level on totals and still be the kind nobody regrets making, because
        // one undroppable starter is worth more than the two useful pieces that
        // add up to him -- that is what the convex value curve prices, and it
        // is the first thing an experienced manager looks at.
        best: bestPiece(sentA, sentB),
        counts: { a: sentA.length, b: sentB.length },
        empty: !sentA.length || !sentB.length,
    };
}

/** The most valuable player in the deal, and which side receives him. */
function bestPiece(sentA, sentB) {
    const all = [
        ...sentA.map((r) => ({ ...r, to: 'b' })),
        ...sentB.map((r) => ({ ...r, to: 'a' })),
    ];
    if (!all.length) return null;
    const top = all.reduce((best, r) => (r.value > best.value ? r : best), all[0]);
    // Is he clearly the best, or is the field level? "Gets the best player" is
    // only worth saying when there is one.
    const rest = all.filter((r) => r !== top).map((r) => r.value);
    const next = rest.length ? Math.max(...rest) : 0;
    return {
        player: top.player,
        value: top.value,
        to: top.to,
        clear: next > 0 ? top.value >= next * 1.15 : true,
    };
}

/**
 * Verdict bands, in the language of the question being asked.
 *
 * The thresholds are the same ones the finder negotiates inside: under 7% is
 * noise on a value scale calibrated to a market that itself disagrees by more
 * than that, 15% is the edge of a deal somebody would actually accept, and past
 * 30% one side is not reading the offer.
 */
export function vacuumVerdict(result, { labelA = 'Side A', labelB = 'Side B' } = {}) {
    if (!result || result.empty) {
        return { tone: 'neutral', label: 'Incomplete', grade: null, headline: 'Add at least one player to each side.' };
    }

    const { gap, winner, best, receivesA, receivesB } = result;
    const winnerLabel = winner === 'a' ? labelA : labelB;
    const loserLabel = winner === 'a' ? labelB : labelA;
    const pct = Math.round(gap * 100);

    const bestNote =
        best && best.clear
            ? ` ${best.to === 'a' ? labelA : labelB} gets the best player in the deal in ${best.player.name}, which is worth more than the totals suggest: one starter you never bench beats two you sometimes do.`
            : '';

    if (gap < 0.07) {
        return {
            tone: 'neutral',
            label: 'Even',
            grade: 'B',
            headline:
                `Within ${pct}% on value — that is a fair trade, and close enough that neither side should feel robbed.` +
                bestNote,
        };
    }
    if (gap < 0.15) {
        return {
            tone: 'warn',
            label: `${winnerLabel} slightly ahead`,
            grade: winner === 'a' ? 'B+' : 'B-',
            headline:
                `${winnerLabel} comes out ${pct}% ahead. That is inside the range real trades get accepted in — ` +
                `a tilt, not a fleecing.` + bestNote,
        };
    }
    if (gap < 0.3) {
        return {
            tone: 'warn',
            label: `${winnerLabel} wins it`,
            grade: winner === 'a' ? 'A-' : 'C',
            headline:
                `${winnerLabel} wins this by ${pct}%. ${loserLabel} needs a reason beyond value — a hole to fill, ` +
                `a bye to cover — or this one is a pass.` + bestNote,
        };
    }
    return {
        tone: 'bad',
        label: `${winnerLabel} fleeces it`,
        grade: winner === 'a' ? 'A' : 'D',
        headline:
            `${winnerLabel} wins by ${pct}% — ${formatSide(receivesA)} against ${formatSide(receivesB)}. ` +
            `This is not a close call.` + bestNote,
    };
}

const formatSide = (v) => Math.round(v).toLocaleString('en-US');
