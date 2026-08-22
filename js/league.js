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
    IDP_FLEX: ['DL', 'LB', 'DB'],
    DL: ['DL'],
    LB: ['LB'],
    DB: ['DB'],
};

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);
const IDP_SLOTS = new Set(['IDP_FLEX', 'DL', 'LB', 'DB']);

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
    SUPER_FLEX: { QB: 0.88, RB: 0.04, WR: 0.06, TE: 0.02 },
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

    for (const slot of starterSlots) {
        if (IDP_SLOTS.has(slot)) {
            hasIdp = true;
            continue;
        }
        const share = FLEX_SHARE[slot];
        if (share) {
            for (const [pos, w] of Object.entries(share)) startersByPos[pos] += w;
        } else if (startersByPos[slot] !== undefined) {
            startersByPos[slot] += 1;
        }
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
