// Turns a raw Sleeper league object into the normalized configuration the
// valuation, lineup and simulation code depends on.
//
// Everything that makes one league different from another -- scoring, starting
// slots, superflex, team count, playoff structure -- is resolved here exactly
// once, so no downstream module has to guess.

export const ALL_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** Which positions may fill each Sleeper starting slot. */
export const SLOT_ELIGIBILITY = {
    QB: ['QB'],
    RB: ['RB'],
    WR: ['WR'],
    TE: ['TE'],
    K: ['K'],
    DEF: ['DEF'],
    FLEX: ['RB', 'WR', 'TE'],
    WRRB_FLEX: ['RB', 'WR'],
    WRRB_WRT: ['RB', 'WR', 'TE'],
    REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
    // Sleeper's name for a superflex in some leagues: "offensive player".
    OP: ['QB', 'RB', 'WR', 'TE'],
    IDP_FLEX: ['DL', 'LB', 'DB'],
    // Shorthand slot names other platforms use and leagues copy across.
    KICKER: ['K'],
    DEFENSE: ['DEF'],
    W_R_T: ['RB', 'WR', 'TE'],
    W_R: ['RB', 'WR'],
    W_T: ['WR', 'TE'],
    Q_W_R_T: ['QB', 'RB', 'WR', 'TE'],
    DL: ['DL'],
    LB: ['LB'],
    DB: ['DB'],
};

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);
const IDP_SLOTS = new Set(['IDP_FLEX', 'DL', 'LB', 'DB']);

/**
 * Position tokens, longest first. Single letters are included because the
 * W/R/T and Q/W/R/T conventions are widespread, and they are only ever matched
 * as part of a decomposition that consumes a whole word -- never as a
 * substring.
 */
const POS_TOKENS = {
    SUPER: ['QB', 'RB', 'WR', 'TE'],
    DST: ['DEF'],
    DEF: ['DEF'],
    QB: ['QB'],
    RB: ['RB'],
    WR: ['WR'],
    TE: ['TE'],
    DL: ['DL'],
    LB: ['LB'],
    DB: ['DB'],
    K: ['K'],
    Q: ['QB'],
    W: ['WR'],
    R: ['RB'],
    T: ['TE'],
    D: ['DEF'],
};
const TOKENS_LONGEST_FIRST = Object.keys(POS_TOKENS).sort((a, b) => b.length - a.length);

/** Words that decorate a slot name without saying anything about eligibility. */
const SLOT_NOISE = ['SUPERFLEX', 'FLEX', 'FLX', 'SLOT', 'START', 'UTIL', 'PLAYER', 'SPOT', 'POS', 'PPR', 'REC'];

/** Whole-word names for a slot that take any offensive player. */
const ANY_OFFENSE = new Set(['OP', 'SF', 'SUPERFLEX', 'SUPER']);

/**
 * Break one word of a slot name into position tokens, or return null if the
 * word is not entirely made of them.
 *
 * Requiring the WHOLE word to decompose is the point. Matching tokens as bare
 * substrings reads a tight end out of `MYSTERY` and `STARTER`, and a kicker
 * out of `BACKUP` -- so an unrelated name would quietly become a roster slot
 * with eligibility rules attached, which is worse than admitting the name is
 * not understood.
 */
function decomposeSlotWord(word) {
    if (!word) return null;
    const out = [];
    const walk = (rest) => {
        if (!rest) return true;
        for (const token of TOKENS_LONGEST_FIRST) {
            if (!rest.startsWith(token)) continue;
            out.push(...POS_TOKENS[token]);
            if (walk(rest.slice(token.length))) return true;
            out.length -= POS_TOKENS[token].length;
        }
        return false;
    };
    return walk(word) ? out : null;
}

/**
 * Which positions can fill a slot, for a slot name we do not have a table
 * entry for.
 *
 * A slot the app does not recognise used to be dropped silently: it
 * contributed nothing to the starters-per-position counts and the lineup
 * solver could never fill it, so the slot sat empty forever and the roster
 * scored a starter short every week. Nothing anywhere said so. A league with a
 * flex slot under an unfamiliar name therefore had a permanently broken lineup
 * and a replacement level computed from the wrong number of starters -- which
 * is a long way from an obscure edge case, because leagues rename slots and
 * Sleeper adds them.
 *
 * Reading the position tokens out of the name recovers the intent for any
 * sensible naming: TE_WR_FLEX, W_R_T, FLEX_WR_TE, TEWRFLEX. A name that is not
 * built out of position tokens returns null and is reported to the user
 * instead of guessed at.
 */
export function inferSlotEligibility(slot) {
    const name = String(slot || '').toUpperCase();
    if (!name) return null;

    const found = [];
    const add = (positions) => {
        for (const pos of positions) if (!found.includes(pos)) found.push(pos);
    };

    for (const raw of name.split(/[^A-Z]+/)) {
        if (!raw) continue;
        if (ANY_OFFENSE.has(raw)) {
            add(['QB', 'RB', 'WR', 'TE']);
            continue;
        }
        // Strip the decoration, so a concatenated name like TEWRFLEX or
        // SUPERFLEX still decomposes. Longest noise word first, so SUPERFLEX
        // is not left as a bare SUPER by removing FLEX from the middle.
        let word = raw;
        for (const noise of SLOT_NOISE) {
            if (noise === 'SUPERFLEX') continue;
            word = word.split(noise).join('');
        }
        if (!word) continue;

        const positions = decomposeSlotWord(word);
        // A word that is not made of position tokens says nothing about
        // eligibility; the other words in the name may still.
        if (positions) add(positions);
    }

    if (!found.length) return null;
    return ALL_POS.filter((p) => found.includes(p)).concat(found.filter((p) => !ALL_POS.includes(p)));
}

/**
 * How a slot's single starting spot splits across the positions that can fill
 * it, for a slot with no measured share. Even weights: without data on how
 * managers actually fill it, pretending to know the split is worse than
 * sharing it out.
 */
function inferredShare(positions) {
    const share = {};
    for (const pos of positions) share[pos] = 1 / positions.length;
    return share;
}

/**
 * How a multi-position slot splits across the positions that can fill it.
 * Used to convert flex slots into an expected number of starters per position,
 * which is what sets each position's replacement level.
 */
const FLEX_SHARE = {
    FLEX: { RB: 0.36, WR: 0.5, TE: 0.14 },
    WRRB_WRT: { RB: 0.36, WR: 0.5, TE: 0.14 },
    WRRB_FLEX: { RB: 0.42, WR: 0.58 },
    REC_FLEX: { WR: 0.72, TE: 0.28 },
    W_R_T: { RB: 0.36, WR: 0.5, TE: 0.14 },
    W_R: { RB: 0.42, WR: 0.58 },
    W_T: { WR: 0.72, TE: 0.28 },
    Q_W_R_T: { QB: 0.88, RB: 0.04, WR: 0.06, TE: 0.02 },
    SUPER_FLEX: { QB: 0.88, RB: 0.04, WR: 0.06, TE: 0.02 },
    OP: { QB: 0.88, RB: 0.04, WR: 0.06, TE: 0.02 },
};

/** Sleeper omits scoring keys that are set to zero, so we need real defaults. */
const SCORING_DEFAULTS = {
    pass_yd: 0.04,
    pass_td: 4,
    pass_int: -2,
    pass_2pt: 2,
    rush_yd: 0.1,
    rush_td: 6,
    rush_2pt: 2,
    rec: 0,
    rec_yd: 0.1,
    rec_td: 6,
    rec_2pt: 2,
    bonus_rec_te: 0,
    fum_lost: -2,
};

/**
 * Keep every scoring rule the league defines, not just the ones we thought to
 * name. Projections are scored by dot-producting these keys against matching
 * projected stats, so dropping an unrecognized key silently deletes a whole
 * scoring category -- that is how kicker and defense scoring went missing, and
 * it would quietly break any league with custom rules (first downs, big-play
 * bonuses, return yards) too.
 *
 * The defaults only fill in offensive keys Sleeper omits when they are zero.
 */
export function normalizeScoring(raw = {}) {
    const s = { ...SCORING_DEFAULTS };
    for (const [k, v] of Object.entries(raw || {})) {
        if (typeof v === 'number') s[k] = v;
    }
    return s;
}

export function scoringLabel(s) {
    const r = s.rec;
    let base;
    if (r >= 1) base = r > 1 ? `${r} PPR` : 'Full PPR';
    else if (r >= 0.4) base = 'Half PPR';
    else if (r > 0) base = `${r} PPR`;
    else base = 'Standard';
    if (s.bonus_rec_te > 0) base += ` + ${s.bonus_rec_te} TEP`;
    if (s.pass_td !== 4) base += ` · ${s.pass_td}pt PTD`;
    return base;
}

/**
 * @param {object} league  raw Sleeper /league/<id> payload
 * @param {object} [opts]  overrides for when the user is running without a synced league
 */
export function normalizeLeague(league, opts = {}) {
    const settings = league?.settings || {};
    const rosterPositions = league?.roster_positions || opts.rosterPositions || defaultRosterPositions();

    const starterSlots = rosterPositions.filter((p) => !BENCH_SLOTS.has(p));
    const benchSize = rosterPositions.filter((p) => p === 'BN').length;

    const startersByPos = {};
    for (const pos of ALL_POS) startersByPos[pos] = 0;
    let hasIdp = false;
    // Slots whose name we could not read at all. Surfaced rather than dropped:
    // a starting slot nobody can fill is a roster scoring a man short every
    // week, and it must not be invisible.
    const unreadableSlots = [];
    // How each slot was interpreted, so the League tab can show its working
    // and a mis-read league is something the user can see rather than guess at.
    const slotPositions = {};

    for (const slot of starterSlots) {
        if (IDP_SLOTS.has(slot)) {
            hasIdp = true;
            slotPositions[slot] = SLOT_ELIGIBILITY[slot] || [];
            continue;
        }

        const known = SLOT_ELIGIBILITY[slot] || null;
        const eligible = known || inferSlotEligibility(slot);
        if (!eligible?.length) {
            unreadableSlots.push(slot);
            slotPositions[slot] = [];
            continue;
        }
        slotPositions[slot] = eligible;

        const offensive = eligible.filter((p) => ALL_POS.includes(p));
        if (!offensive.length) continue;

        // A measured share where we have one, an even split where we do not.
        const share = FLEX_SHARE[slot] || (offensive.length > 1 ? inferredShare(offensive) : null);
        if (share) {
            for (const [pos, w] of Object.entries(share)) {
                if (startersByPos[pos] !== undefined) startersByPos[pos] += w;
            }
        } else {
            startersByPos[offensive[0]] += 1;
        }
    }

    if (unreadableSlots.length) {
        console.warn(
            `Roster slots this app cannot interpret: ${[...new Set(unreadableSlots)].join(', ')}. ` +
            'They are shown on the League tab and excluded from lineup solving.'
        );
    }

    const superflex = starterSlots.some((s) => s === 'SUPER_FLEX') || startersByPos.QB >= 1.5;

    return {
        id: league?.league_id ?? null,
        name: league?.name ?? opts.name ?? 'Custom League',
        season: league?.season ?? opts.season ?? null,
        avatar: league?.avatar ?? null,
        teams: settings.num_teams || league?.total_rosters || opts.teams || 12,
        rosterPositions,
        starterSlots,
        benchSize,
        rosterSize: rosterPositions.length,
        startersByPos,
        // Which positions can fill each starting slot, as the app read them.
        slotPositions,
        unreadableSlots: [...new Set(unreadableSlots)],
        superflex,
        hasIdp,
        tePremium: (league?.scoring_settings?.bonus_rec_te ?? 0) > 0,
        scoring: normalizeScoring(league?.scoring_settings),
        // Sleeper: settings.type 0 = redraft, 1 = keeper, 2 = dynasty
        format: settings.type === 2 ? 'dynasty' : settings.type === 1 ? 'keeper' : 'redraft',
        playoffTeams: settings.playoff_teams || 6,
        playoffWeekStart: settings.playoff_week_start || 15,
        // Sleeper: settings.league_average_match is 1 when the league plays an
        // extra weekly matchup against the league median, 0 otherwise. Teams in
        // such a league therefore play two games a week, and both count.
        medianScoring: settings.league_average_match === 1,

        // --- Waivers ---------------------------------------------------------
        // Sleeper: waiver_type 0 = rolling waivers, 1 = reverse standings,
        // 2 = FAAB. Cash is only a tradeable asset in the third case, and every
        // FAAB feature in the app is gated on `usesFaab` rather than on the
        // budget being non-zero -- a rolling-waiver league can still carry a
        // stale waiver_budget in its settings.
        faabBudget: settings.waiver_budget ?? 0,
        waiverType: settings.waiver_type ?? 0,
        usesFaab: settings.waiver_type === 2 && (settings.waiver_budget ?? 0) > 0,
        waiverDay: settings.waiver_day_of_week ?? null,
        waiverClearDays: settings.waiver_clear_days ?? null,
        tradeDeadline: settings.trade_deadline ?? null,

        raw: league || null,
    };
}

export function defaultRosterPositions() {
    return ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
}

/**
 * Replacement level: the positional rank of the best player a manager could
 * realistically stream off waivers. Everything above that line is what a
 * roster is actually paying for, so it is the anchor for every value number
 * in the app.
 */
export function replacementRanks(cfg) {
    const out = {};
    for (const pos of ALL_POS) {
        const startersLeaguewide = cfg.teams * (cfg.startersByPos[pos] || 0);
        // Managers roster backups at the positions that churn most, which pushes
        // the true waiver line deeper than the raw number of starting slots.
        const cushion = { QB: 0.35, RB: 0.9, WR: 0.9, TE: 0.35, K: 0.05, DEF: 0.15 }[pos] ?? 0.3;
        const depth = startersLeaguewide + (startersLeaguewide > 0 ? cfg.teams * cushion * 0.35 : 0);
        out[pos] = Math.max(1, Math.round(depth));
    }

    return out;
}

/** Which positions this league believes can fill a slot. */
export function slotEligibility(cfg, slot) {
    return cfg?.slotPositions?.[slot] || SLOT_ELIGIBILITY[slot] || inferSlotEligibility(slot) || [];
}

/**
 * Does this league start this position in a slot only it can fill?
 *
 * The question behind it is whether the position is REQUIRED. A league with a
 * TE slot forces every manager to start a tight end; a league whose tight ends
 * are only ever startable through a flex does not, and treating the two the
 * same tells a manager he has a hole where he has made a choice.
 */
export function hasDedicatedSlot(cfg, pos) {
    return (cfg?.starterSlots || []).some((slot) => {
        const eligible = slotEligibility(cfg, slot);
        return eligible.length === 1 && eligible[0] === pos;
    });
}

/**
 * Positions that compete for the same starting slots, and how many players the
 * league starts across each such group.
 *
 * Replacement level is the whole basis of every value in the app, and computing
 * it position by position is wrong the moment a league has a flex. When a RB, a
 * WR and a TE are all fighting for one slot, the worst startable player at all
 * three positions is the SAME player -- there is one waiver line, not three. Set
 * three separate lines and you invent value out of nothing: a steep positional
 * curve (running back) gets a deep, low baseline while a shallow one (receiver)
 * gets a high one, and every back on the board is silently marked up against
 * every receiver.
 *
 * So the positions are grouped by what can start where, and the group gets one
 * line. A league with no flex produces one group per position and the old
 * behaviour, exactly.
 *
 * @returns {Array<{positions: string[], startersPerTeam: number, cushion: number}>}
 */
export function flexGroups(cfg) {
    const positions = ALL_POS.filter((p) => (cfg.startersByPos[p] || 0) > 0);
    if (!positions.length) return [];

    // Union the positions that share any multi-position slot.
    const parent = new Map(positions.map((p) => [p, p]));
    const find = (p) => {
        while (parent.get(p) !== p) p = parent.get(p);
        return p;
    };
    const union = (a, b) => {
        const [ra, rb] = [find(a), find(b)];
        if (ra !== rb) parent.set(rb, ra);
    };

    const dedicated = {};
    const flexSlots = [];
    for (const slot of cfg.starterSlots) {
        // Read through the league's own interpretation of the slot, not the
        // bare table: a league that renamed its flexes would otherwise have
        // every one of them skipped here, which switches the pooling off
        // entirely and hands each position a separate waiver line again.
        const eligible = slotEligibility(cfg, slot).filter((p) => parent.has(p));
        if (!eligible.length) continue;
        if (eligible.length === 1) {
            dedicated[eligible[0]] = (dedicated[eligible[0]] || 0) + 1;
        } else {
            flexSlots.push(eligible);
            for (let i = 1; i < eligible.length; i++) union(eligible[0], eligible[i]);
        }
    }

    const CUSHION = { QB: 0.35, RB: 0.9, WR: 0.9, TE: 0.35, K: 0.05, DEF: 0.15 };
    const groups = new Map();
    for (const pos of positions) {
        const root = find(pos);
        if (!groups.has(root)) groups.set(root, { positions: [], startersPerTeam: 0, cushion: 0 });
        const g = groups.get(root);
        g.positions.push(pos);
        g.startersPerTeam += dedicated[pos] || 0;
    }
    for (const eligible of flexSlots) groups.get(find(eligible[0])).startersPerTeam += 1;
    for (const g of groups.values()) {
        // Managers roster backups at the positions that churn most, which pushes
        // the true waiver line deeper than the raw number of starting slots. A
        // group's cushion is the average over the positions in it, because the
        // benches behind a flex are shared too.
        g.cushion = g.positions.reduce((a, p) => a + (CUSHION[p] ?? 0.3), 0) / g.positions.length;
    }
    return [...groups.values()];
}

/** Weeks of fantasy regular season left to play, inclusive of the current week. */
export function weeksRemaining(cfg, currentWeek) {
    const lastRegular = (cfg.playoffWeekStart || 15) - 1;
    return Math.max(0, lastRegular - (currentWeek || 1) + 1);
}

export function slotLabel(slot) {
    return (
        {
            SUPER_FLEX: 'SFLX',
            WRRB_FLEX: 'W/R',
            WRRB_WRT: 'FLEX',
            REC_FLEX: 'W/T',
            IDP_FLEX: 'IDP',
            DEF: 'D/ST',
        }[slot] || slot
    );
}
