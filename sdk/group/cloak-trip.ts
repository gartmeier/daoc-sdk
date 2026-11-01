// A group's trip out of a battleground for cloaks. A battleground has no merchants, and the recall
// stone doesn't work there (GatewayPersonalBind.cs:24), so: the realm's zone point out to the portal
// keep (leaveBattleground), the free city medallion to the capital (portTogether), a cloak for each
// member lacking one, and back in through the capital's town teleporter (enterBattleground).
//
// Plain cloaks in the capitals are sold by Radek Silven (Camelot), 1,215 from the landing, Hyndla
// Gunderson (Jordheim), 8,931, and Dierdra (Tir na Nog), 6,201 (static data, nearestCloakSeller).
// Jordheim's second Stor Gothi Annark stands 1,826 from Hyndla; Tir na Nog's one teleporter is 5,652
// from Dierdra, past the 4000 toPortalKeep asks from, so the group walks back there. Capitals have
// no aggressive mobs (aggroZones), so everyone just walks at once. Their zones (26, 120, 209) have no
// navmesh built today, which makes those walks straight lines.
//
// Each step looks at where each member stands now, so a stop partway resumes on the next run.

import type { NpcSpawnMatch } from '../../data/index';
import { at, atPortalKeep, BATTLEGROUNDS, capitalOf, dist, enterBattleground, entryProblem, inBattleground, inCapital, leaveBattleground, me, portalKeepOf, portTogether, releaseDead, stepLog, toPortalKeep, townTeleporter, wearsMedallion, type EnterResult } from './battleground';
import { buyCloak, holdsCloak, nearestCloakSeller, wearAccessories } from './gear';
import type { Member } from './member';

/** Covers a whole capital: the farthest seller from a landing is 8,931 away, the farthest teleporter from a seller 7,800. */
export const CAPITAL_RADIUS = 12_000;

const walkToSpawn = async (m: Member, s: NpcSpawnMatch) => {
    const w = await m.actions.walkTo(s.x, s.y, { z: s.z, tolerance: 150 });
    return w.success ? `walked to ${s.name}` : `walk to ${s.name}: ${w.reason} ${w.message}`;
};

/**
 * Get every member a cloak, and end in the battleground (or with `stay`, in the capital). A member
 * holding a cloak needs no trip: in the battleground it stays there, at the portal keep it waits
 * for the rest, in the capital it buys nothing. With `stay` everyone goes to the capital, cloak or
 * not. Everyone who has to come back must be able to (entryProblem), checked before anyone leaves, except a member dead at the start.
 * The dead are released wherever they stand, a holder inside included: a dead member can't put a
 * cloak on (GamePlayerInventory.cs:653-661), and one still dead after that stops the run.
 */
export async function cloakTrip(members: Member[], opts: { regionId?: number; stay?: boolean; bind?: boolean; log?: (line: string) => void } = {}): Promise<EnterResult> {
    const bg = BATTLEGROUNDS[opts.regionId ?? 252];
    if (!bg) throw new Error(`no battleground data for region ${opts.regionId}`);
    const run = stepLog(members, opts.log);
    const { report, note, each, failed } = run;
    const name = (m: Member) => me(m).name;
    const merge = (r: EnterResult) => { for (const [n, lines] of Object.entries(r.report)) report[n]!.push(...lines); };
    // A city medallion already on goes at the next cast, wanted or not.
    const wants = (m: Member) => !!opts.stay || !holdsCloak(m) || wearsMedallion(m, capitalOf(m));
    const concerned = members.filter(m => me(m).isDead || !inBattleground(m, bg) || wants(m));

    if (!opts.stay) {
        const problems = concerned.filter(m => !me(m).isDead).map(m => [m, entryProblem(m, bg)] as const).filter(([, p]) => p);
        if (problems.length) return { success: false, message: `could not come back: ${problems.map(([m, p]) => `${name(m)}: ${p}`).join('; ')}`, report };
    }
    await releaseDead(concerned, run);
    const dead = members.filter(m => me(m).isDead);
    if (dead.length) return failed('still dead', dead.map(m => [m, at(m)]));

    const leaving = members.filter(m => inBattleground(m, bg) && wants(m));
    if (leaving.length) {
        const out = await leaveBattleground(leaving, { regionId: bg.regionId, log: opts.log });
        merge(out);
        if (!out.success) return { ...out, report };
    }

    const going = members.filter(m => !inBattleground(m, bg) && !inCapital(m) && wants(m));
    const stranded = going.filter(m => !atPortalKeep(m, portalKeepOf(m)) && !townTeleporter(m));
    if (stranded.length) return failed('neither at the portal keep nor by a town teleporter', stranded.map(m => [m, at(m)]));
    await each(going.filter(m => !atPortalKeep(m, portalKeepOf(m))), m => toPortalKeep(m, portalKeepOf(m)));
    const away = going.filter(m => !atPortalKeep(m, portalKeepOf(m)));
    if (away.length) return failed('not at the portal keep', away.map(m => [m, at(m)]));
    if (going.length) {
        const stopped = await portTogether(going, capitalOf, run);
        if (stopped) return stopped;
        const missed = going.filter(m => !inCapital(m));
        if (missed.length) return failed('not ported to the capital', missed.map(m => [m, at(m)]));
    }

    // All at once to the seller, then one at a time at the merchant, as with the medallions.
    const buyers = members.filter(m => inCapital(m) && !holdsCloak(m));
    await each(buyers, async m => {
        const s = nearestCloakSeller(me(m), CAPITAL_RADIUS)?.spawn;
        return !s || dist(me(m), s) <= 300 ? null : walkToSpawn(m, s);
    });
    for (const m of buyers) for (const line of await buyCloak(m, { radius: CAPITAL_RADIUS })) note(m, line);
    const lacking = buyers.filter(m => !holdsCloak(m));
    if (lacking.length) return failed('no cloak', lacking.map(m => [m, at(m)]));
    for (const m of members) for (const line of await wearAccessories(m)) note(m, line);

    const where = () => members.map(m => `${name(m)} ${at(m)}`).join(', ');
    if (opts.stay) return { success: members.every(inCapital), message: where(), report };

    await each(members.filter(m => inCapital(m) && !townTeleporter(m)), async m => {
        const s = townTeleporter(m, CAPITAL_RADIUS);
        return s ? walkToSpawn(m, s) : `no town teleporter in ${capitalOf(m).name}`;
    });
    const back = await enterBattleground(members, { regionId: bg.regionId, bind: opts.bind, log: opts.log });
    merge(back);
    return { ...back, report };
}
