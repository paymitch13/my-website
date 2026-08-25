// An honest audit of one roster.
//
// Every other view in this app answers a question the user brought to it. This
// one goes looking: it reads a roster the way a rival manager would and says
// what is wrong with it, because the weaknesses somebody else can see are the
// ones that cost you games.
//
// Three rules, and they are the whole design:
//
//   1. NO FINDING WITHOUT A NUMBER. "Weak at running back" is a horoscope.
//      "3.4 points a week below the league at running back, 11th of 12" is a
//      fact somebody can check and argue with.
//   2. NO FINDING WITHOUT A FIX. A critique that stops at the diagnosis is
//      just an insult. Every item names the move that addresses it.
//   3. FLATTERY IS NOT FEEDBACK. A roster with nothing wrong gets told so in
//      one line, not padded out with invented problems -- and a roster with
//      real problems does not get them softened.

import { optimizeLineup, positionalReport } from './lineup.js';
import { buildLeagueNeeds, NEED_POSITIONS } from './needs.js';
import { byeConflicts } from './schedule.js';
import { describeSchedule } from './outlook.js';
import { round, sortBy, sum } from './util.js';

/** How bad a finding is. Drives ordering and colour, nothing else. */
const SEVERITY = { critical: 3, warning: 2, note: 1, good: 0 };

/**
 * Audit a roster.
 *
 * @param {object} input
 * @param {object} input.team        the roster under the microscope
 * @param {Array}  input.teams       every team, for league-relative comparison
 * @param {object} input.cfg
 * @param {object} input.ctx         valuation context
 * @param {Map}    input.rankings
 * @param {Function} input.entriesFor team -> valued entries
 * @param {Map}    [input.byeWeeks]
 * @param {Map}    [input.restOfSeason]  schedule strength by team
 * @param {Map}    [input.playoffSchedule]
 * @param {number} [input.currentWeek]
 * @param {Map}    [input.playoffOdds]
 */
export function critiqueRoster(input) {
    const {
        team, teams, cfg, ctx, entriesFor,
        byeWeeks = new Map(), restOfSeason = null, playoffSchedule = null,
        currentWeek = 1, playoffOdds = null,
    } = input;

    const { byRoster, perSlotAvg, weakAvg, bestAvg } = buildLeagueNeeds({
        teams,
        cfg,
        entriesFor,
        replacementPpg: ctx.replacementPpg,
    });

    const mine = byRoster.get(team.rosterId);
    if (!mine) return { ok: false, error: 'That roster could not be analysed.' };

    const findings = [];
    const rank = leagueRanks(byRoster);

    findings.push(...positionFindings({ mine, rank, perSlotAvg, weakAvg, bestAvg, teams }));
    findings.push(...fragilityFindings({ mine, byRoster }));
    findings.push(...deadWeightFindings({ mine, cfg, ctx, byRoster }));
    findings.push(...byeFindings({ team, byeWeeks, currentWeek, cfg }));
    findings.push(...scheduleFindings({ mine, restOfSeason, playoffSchedule }));
    findings.push(...shapeFindings({ mine, rank, playoffOdds, team }));

    const ordered = sortBy(
        findings,
        (f) => SEVERITY[f.severity] * 100 + (f.weight ?? 0),
        -1
    );

    return {
        ok: true,
        team,
        findings: ordered,
        lineup: mine.lineup,
        rank: rank.lineup.get(team.rosterId),
        of: teams.length,
        // A single sentence for the top of the page, written from what was
        // actually found rather than from a template.
        summary: summarize(ordered, rank.lineup.get(team.rosterId), teams.length),
    };
}

/** Where this roster sits in the league on each measure that matters. */
function leagueRanks(byRoster) {
    const rows = [...byRoster.values()];
    const lineup = new Map();
    sortBy(rows, (r) => r.lineup.points, -1).forEach((r, i) => lineup.set(r.rosterId, i + 1));

    const byPos = {};
    for (const pos of NEED_POSITIONS) {
        const map = new Map();
        const withPos = rows.filter((r) => (r.needs[pos]?.starting ?? 0) > 0);
        sortBy(withPos, (r) => r.needs[pos].perSlot, -1).forEach((r, i) => map.set(r.rosterId, i + 1));
        byPos[pos] = { map, of: withPos.length };
    }
    return { lineup, byPos };
}

/**
 * Holes, measured two ways: below the league per starting slot, and a weak
 * starter behind a good one.
 *
 * Both matter and they catch different rosters. A team can be fine on average
 * and still be starting somebody it should not; a team can have no single
 * terrible starter and still be behind everywhere.
 */
function positionFindings({ mine, rank, perSlotAvg, weakAvg, bestAvg }) {
    const out = [];

    for (const pos of NEED_POSITIONS) {
        const need = mine.needs[pos];
        if (!need || need.starting <= 0) continue;

        const placed = rank.byPos[pos];
        const at = placed.map.get(mine.rosterId);
        const gap = need.deficit;

        if (gap >= 2.5) {
            out.push({
                kind: 'hole',
                pos,
                severity: gap >= 5 ? 'critical' : 'warning',
                weight: gap,
                title: `${pos} is costing you ${round(gap, 1)} points a week`,
                detail:
                    `You get ${round(need.perSlot, 1)} a start from ${pos} against a league average of ` +
                    `${round(perSlotAvg?.[pos] ?? 0, 1)} — ${at} of ${placed.of}. Over the rest of the season ` +
                    `that is the difference between a bye and a first-round exit.`,
                fix: `Trade for a ${pos}. The Trade Finder can target one directly, or search your surplus for a match.`,
                action: { view: 'finder', pos },
            });
        }

        // A hole in the lineup, as opposed to a hole in the average.
        const slotGap = need.slotDeficit ?? 0;
        if (slotGap >= 3 && gap < 2.5) {
            out.push({
                kind: 'weak-starter',
                pos,
                severity: slotGap >= 5 ? 'warning' : 'note',
                weight: slotGap,
                title: `Your last ${pos} starter is a problem the average hides`,
                detail:
                    `Your ${pos} room averages fine, but the worst one you start scores ` +
                    `${round(need.weakStarter, 1)} against a league norm of ${round(weakAvg?.[pos] ?? 0, 1)}. ` +
                    `One good ${pos} and one waiver body is not the same as two real ones.`,
                fix: `You do not need a stud here — you need a second startable ${pos}, which is cheap.`,
                action: { view: 'finder', pos },
            });
        }

        // No ceiling: fine everywhere, elite nowhere.
        const top = need.topEdge ?? 0;
        if (top <= -2.5 && gap < 2.5 && need.starting >= 2) {
            out.push({
                kind: 'no-ceiling',
                pos,
                severity: 'note',
                weight: Math.abs(top),
                title: `No difference-maker at ${pos}`,
                detail:
                    `Your best ${pos} scores ${round(need.bestPoints, 1)}; the typical league-best at the ` +
                    `position is ${round(bestAvg?.[pos] ?? 0, 1)}. Rosters like this win the weeks they are ` +
                    `supposed to and lose the ones they need to steal.`,
                fix: `Consolidate. Two of your interchangeable ${pos}s for one better one is the trade the value curve is built to price.`,
                action: { view: 'finder', pos },
            });
        }
    }

    return out;
}

/**
 * What happens if one man goes down -- measured against the league, not against
 * zero.
 *
 * Every roster in every league starts exactly one quarterback and one tight
 * end, so losing either always costs the whole position. That is the format,
 * not a flaw, and flagging it told all twelve managers the same non-fact.
 * Fragility only means something when this roster is MORE exposed than the
 * teams it plays.
 */
function fragilityFindings({ mine, byRoster }) {
    const rows = [...byRoster.values()];
    const exposed = [];

    for (const pos of NEED_POSITIONS) {
        const need = mine.needs[pos];
        if (!need || need.starting <= 0) continue;

        const drop = need.dropoff ?? 0;
        if (drop < 4) continue;

        // The league's own typical exposure at this position.
        const peers = rows
            .filter((r) => r.rosterId !== mine.rosterId && (r.needs[pos]?.starting ?? 0) > 0)
            .map((r) => r.needs[pos].dropoff ?? 0);
        if (peers.length < 3) continue;
        const typical = median(peers);

        // Half again as exposed as the rest of the league, and by a margin
        // somebody would actually feel.
        if (drop < typical * 1.5 || drop - typical < 2.5) continue;

        // How many teams here are MORE exposed at this position. When most of
        // the league is in the same boat -- everyone starts one quarterback --
        // this is the format talking, and the median comparison alone does not
        // catch it: most teams carrying a backup drags the median down until
        // every single-QB roster looks like an outlier against it.
        const worse = peers.filter((p) => p >= drop).length;
        if (worse / peers.length > 0.25) continue;

        exposed.push({ pos, drop, typical, need, margin: drop - typical, worse, peers: peers.length });
    }

    if (!exposed.length) return [];

    // One finding, not one per position. Three separate cards saying "buy a
    // backup" is the same advice printed three times.
    const worst = sortBy(exposed, (x) => x.margin, -1)[0];
    const also = exposed.filter((x) => x !== worst);
    const share = worst.need.perSlot > 0 ? worst.drop / (worst.need.perSlot * worst.need.starting) : 0;

    return [
        {
            kind: 'fragile',
            pos: worst.pos,
            severity: worst.margin >= 5 ? 'warning' : 'note',
            weight: worst.margin,
            title:
                also.length
                    ? `No insurance at ${worst.pos} or ${also.map((x) => x.pos).join(' or ')}`
                    : `Your season runs through one ${worst.pos}`,
            detail:
                `Lose ${worst.need.best?.player?.name ?? `your top ${worst.pos}`} and the lineup drops ` +
                `${round(worst.drop, 1)} points a week — ${Math.round(share * 100)}% of what the position gives you, ` +
                `against ${round(worst.typical, 1)} for the typical team here. ` +
                (worst.worse === 0
                    ? `No other roster in the league is this thin behind its starter.`
                    : `Only ${worst.worse} of your ${worst.peers} rivals ${worst.worse === 1 ? 'is' : 'are'} this exposed.`) +
                (also.length ? ` The same is true at ${also.map((x) => x.pos).join(' and ')}.` : ''),
            fix: `Buy the cheapest startable ${worst.pos} in the league. Insurance is not exciting and it is not expensive.`,
            action: { view: 'finder', pos: worst.pos },
        },
    ];
}

/** Middle value, for comparing one roster against the rest of the league. */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Bench spots doing nothing, counted against what a bench normally does.
 *
 * The absolute version of this fired on twelve rosters out of twelve, which is
 * exactly what it should have done: a fifteen-man roster starting nine players
 * has six bench spots, and most bench players are below replacement by
 * construction. That is the format, not a flaw, and telling every manager in
 * the league the same non-fact is the definition of noise.
 *
 * So it is measured against the league. Six dead spots is only a finding when
 * the teams you play carry three.
 */
function deadWeightFindings({ mine, cfg, ctx, byRoster }) {
    const out = [];
    const lineup = optimizeLineup(mine.entries, cfg.starterSlots);
    const starting = new Set(lineup.starters.map((s) => s.entry.player.id));

    // A bench player worth real money who cannot crack the lineup is a trade
    // asset being stored as a hobby.
    const stranded = sortBy(
        mine.entries.filter(
            (e) => !starting.has(e.player.id) && e.player.pos !== 'K' && e.player.pos !== 'DEF' && e.value > 0
        ),
        (e) => e.value,
        -1
    );

    const worthy = stranded.filter((e) => e.score > (ctx.replacementPpg[e.player.pos] ?? 0) + 1.5);
    if (worthy.length >= 2) {
        const names = worthy.slice(0, 3).map((e) => e.player.name).join(', ');
        out.push({
            kind: 'stranded',
            severity: worthy.length >= 3 ? 'warning' : 'note',
            weight: sum(worthy, (e) => e.score),
            title: `${worthy.length} startable players are sitting on your bench`,
            detail:
                `${names} would start for somebody. On your roster they score nothing. Depth is only ` +
                `worth what it protects, and past a point it protects nothing.`,
            fix: 'Consolidate them into one better starter. Two players who cannot both start are worth less than one who does.',
            action: { view: 'finder' },
        });
    }

    // Roster spots spent on nothing at all -- relative to what everyone else
    // is carrying.
    const deadOn = (row) => {
        const l = optimizeLineup(row.entries, cfg.starterSlots);
        const start = new Set(l.starters.map((s) => s.entry.player.id));
        return row.entries.filter(
            (e) =>
                !start.has(e.player.id) &&
                e.player.pos !== 'K' &&
                e.player.pos !== 'DEF' &&
                e.score < (ctx.replacementPpg[e.player.pos] ?? 0) - 1
        );
    };

    const useless = deadOn(mine);
    const peers = [...(byRoster?.values() ?? [])]
        .filter((r) => r.rosterId !== mine.rosterId)
        .map((r) => deadOn(r).length);
    const typical = peers.length >= 3 ? median(peers) : null;

    // Two more than the league's typical bench, and at least three in total.
    if (useless.length >= 3 && typical !== null && useless.length - typical >= 2) {
        out.push({
            kind: 'dead-weight',
            severity: useless.length - typical >= 4 ? 'warning' : 'note',
            weight: useless.length - typical,
            title: `${useless.length} roster spots are doing nothing, against ${round(typical, 0)} for the rest of the league`,
            detail:
                `${sortBy(useless, (e) => e.score).slice(0, 3).map((e) => e.player.name).join(', ')} and ` +
                `${Math.max(0, useless.length - 3)} other${useless.length - 3 === 1 ? '' : 's'} score below what is freely ` +
                `available on waivers. Every roster carries some of this; you are carrying more than anyone you play.`,
            fix: 'Drop the worst of them for the best free agent at your weakest position.',
            action: { view: 'finder' },
        });
    }

    return out;
}

/** Weeks where several starters are out at once. */
function byeFindings({ team, byeWeeks, currentWeek, cfg }) {
    const conflicts = byeConflicts(team.players, byeWeeks, { fromWeek: currentWeek, minPlayers: 3 });
    if (!conflicts.length) return [];

    const worst = sortBy(conflicts, (c) => c.players.length, -1)[0];
    const playoffs = cfg.playoffWeekStart && worst.week >= cfg.playoffWeekStart;
    return [
        {
            kind: 'bye',
            severity: playoffs ? 'critical' : worst.players.length >= 4 ? 'warning' : 'note',
            weight: worst.players.length,
            title: `Week ${worst.week} takes ${worst.players.length} of your players out at once`,
            detail:
                `${worst.players.map((p) => p.name).join(', ')} are all on bye that week` +
                (playoffs ? ' — and that is a playoff week.' : '.') +
                ' One bye is routine. Four is a loss you can see coming.',
            fix: 'Trade one of them for a player on a different bye, or bank a startable body before that week.',
            action: { view: 'startsit' },
        },
    ];
}

/** What the rest of the schedule does to this roster. */
function scheduleFindings({ mine, restOfSeason, playoffSchedule }) {
    if (!restOfSeason?.size) return [];
    const out = [];

    // Which of my starters are in the worst remaining environments.
    const starters = mine.lineup.starters.map((s) => s.entry);
    const rough = starters
        .map((e) => ({ entry: e, row: restOfSeason.get(e.player.team) }))
        .filter((x) => x.row && x.row.edge < -1.2);

    if (rough.length >= 2) {
        out.push({
            kind: 'schedule',
            severity: 'note',
            weight: rough.length,
            title: `${rough.length} of your starters are on offences with a rough run home`,
            detail:
                rough
                    .slice(0, 3)
                    .map((x) => `${x.entry.player.name} (${x.entry.player.team}, ${round(x.row.average, 1)} implied a game, ${x.row.rank} of ${x.row.of})`)
                    .join('; ') + '.',
            fix: 'Nothing to do this week, but it is the argument to make when you shop them.',
            action: { view: 'vegas' },
        });
    }

    if (playoffSchedule?.size) {
        const bad = starters
            .map((e) => ({ entry: e, row: playoffSchedule.get(e.player.team) }))
            .filter((x) => x.row && x.row.rank > x.row.of * 0.7);
        if (bad.length >= 2) {
            out.push({
                kind: 'playoff-schedule',
                severity: 'warning',
                weight: bad.length,
                title: `${bad.length} starters have a bad fantasy playoff schedule`,
                detail:
                    bad
                        .slice(0, 3)
                        .map((x) => `${x.entry.player.name} (${x.entry.player.team}, ${x.row.rank} of ${x.row.of} in weeks ${x.row.weeks.map((w) => w.week).join(', ')})`)
                        .join('; ') +
                    '. Those are the only weeks that decide anything.',
                fix: 'Trade toward offences with better playoff-week environments while everyone else is still looking at this week.',
                action: { view: 'vegas' },
            });
        }
    }

    // And the good news, if there is any, because a critique that cannot say
    // what is working is not reading the roster, it is just complaining.
    const best = sortBy(
        starters.map((e) => ({ entry: e, row: restOfSeason.get(e.player.team) })).filter((x) => x.row),
        (x) => x.row.edge,
        -1
    )[0];
    if (best && best.row.edge > 1.5) {
        out.push({
            kind: 'schedule-good',
            severity: 'good',
            weight: best.row.edge,
            title: `${best.entry.player.name} has the schedule to carry you`,
            detail: describeSchedule(best.row) ?? '',
            fix: 'Hold. If somebody offers for him, this is the reason to ask for more.',
            action: { view: 'vegas' },
        });
    }

    return out;
}

/** The whole-roster verdict: where this team sits and what shape it is in. */
function shapeFindings({ mine, rank, playoffOdds, team }) {
    const out = [];
    const at = rank.lineup.get(team.rosterId);
    const of = rank.lineup.size;
    const odds = playoffOdds?.get(team.rosterId);

    // Contending on the roster but not in the standings, or the reverse. Both
    // are actionable and they point opposite ways.
    if (Number.isFinite(odds)) {
        const strong = at <= Math.ceil(of / 3);
        const weak = at > of - Math.ceil(of / 3);

        if (strong && odds < 0.4) {
            out.push({
                kind: 'unlucky',
                severity: 'note',
                weight: 5,
                title: 'Your roster is better than your record',
                detail:
                    `${at} of ${of} on lineup strength, and ${Math.round(odds * 100)}% to make the playoffs. ` +
                    'That gap is schedule and variance, not roster.',
                fix: 'Buy. You are closer than the standings say, and the teams around you are about to sell.',
                action: { view: 'finder' },
            });
        }
        if (weak && odds < 0.2) {
            out.push({
                kind: 'sell',
                severity: 'warning',
                weight: 6,
                title: 'This roster is not making the playoffs',
                detail:
                    `${at} of ${of} on lineup strength and ${Math.round(odds * 100)}% to qualify. Holding win-now ` +
                    'players through a lost season is how a bad year becomes two.',
                fix: 'Sell your oldest productive players to the contenders while they still have full value.',
                action: { view: 'finder' },
            });
        }
    }

    if (at === 1) {
        out.push({
            kind: 'best',
            severity: 'good',
            weight: 3,
            title: 'You have the best starting lineup in the league',
            detail: `${round(mine.lineup.points, 1)} points a week, first of ${of}.`,
            fix: 'Protect it. Your risk is now injury, not talent — check the fragility notes above.',
            action: null,
        });
    }

    return out;
}

/** One sentence, built from what was found rather than from a template. */
function summarize(findings, at, of) {
    const real = findings.filter((f) => f.severity !== 'good');
    if (!real.length) {
        return `No structural problems. ${at} of ${of} on lineup strength, no holes, no fragility, no bye pile-up — this roster's risk is injury, not construction.`;
    }

    const critical = real.filter((f) => f.severity === 'critical');
    const lead = critical[0] || real[0];
    const rest = real.length - 1;

    return (
        `${at} of ${of} on lineup strength. ${lead.title}` +
        (rest > 0 ? `, and ${rest} other ${rest === 1 ? 'thing' : 'things'} worth fixing.` : '.')
    );
}
