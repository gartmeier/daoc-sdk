// Getting a group into a battleground: each realm's portal keep, its medallion
// merchant and its battleground teleporter, and the steps that take a whole group
// from a town teleporter to the battleground's arrival point.
//
// The way in (scripts/teleporters/OFTeleporters.cs): the portal keep's OFTeleporter casts
// every of_teleport_interval (120 s by default, ServerProperties.cs) and ports everyone within
// 500 of it (:190) who wears a battleground medallion in the Mythical slot (:193), at the
// battleground's levels and realm points (Thidranki: levels 20-24 below 7,125 RP, :237-244).
// The medallion picks the battleground and is used up by the port (:669-675). The Medallion
// Merchant next to it sells it for nothing. The OFTeleporter ignores whispers and carries the
// same name as every town teleporter (:712, :726), so it is found by position, never by name.
//
// Town teleporters (LiveTeleporter, InlandTeleporter, and the SimpleTeleporter "emissaries")
// answer the portal keep's exact, case-sensitive name ("Castle Sauvage", "Svasud Faste",
// "Druim Ligen"; teleport.sql), and only to their own realm. An emissary ignores whispers until
// someone has right-clicked it since the server started: only Interact loads its destinations
// (SimpleTeleporter.cs LoadDestinations), and WhisperReceive searches nothing else. The recall
// stone does not work at a portal keep or in a battleground (GatewayPersonalBind.cs:24: RvR
// zones), so a group walks to a town teleporter.
//
// A member wearing the medallion within 500 of the OFTeleporter is ported by its next cast,
// and the merchants stand about 500 from it (Gwulla 499, Sall Fadri 535, Araisa 507). So the
// whole group gets its medallions into the backpack first and puts them on together: one
// member who can't have one would otherwise stay behind in another region while the rest go.
// A medallion for somewhere else, left on by a stopped run, comes off before anyone queues: the
// cast goes by whatever is in the slot (:193, :673).
//
// Binding at the portal keep's stone first means a death outside a battleground lands next to
// the medallion merchant. Inside one, a release goes to the realm's portal keep there when
// bg_release_to_portal_keep is on (GamePlayer.Release; scripts/setup-server.ts sets it).
//
// The way out is a zone point of the member's realm, inside its own portal keep in the
// battleground (Thidranki: ids 63-65), which lands at the realm's portal keep outside. The same
// merchants sell the Medallion of City Passage, which the same OFTeleporter takes to the capital
// (OFTeleporters.cs:215, 373, 529). See leaveBattleground, portTogether and cloak-trip.ts.

import { findNpcSpawns, getZonePointsFrom, nearestBindpoint, realmId, type NpcSpawnMatch, type ZonePoint } from '../../data/index';
import type { Realm } from '../types';
import { keepDangers } from './keeps';
import type { Member } from './member';
import { safePath, type Danger } from './terrain';
import type { Point, Point3 } from './types';

export interface PortalKeep {
    name: string;
    regionId: number;
    /** What a town teleporter is told, and where that port lands. */
    keyword: string;
    landing: Point3;
    /** The OFTeleporter (named like a town teleporter: never look it up by name). */
    teleporter: Point3 & { name: string };
    merchant: Point3 & { name: string };
    bind: Point3;
}

/** Static spawn data (findNpcSpawns, teleport.sql). */
export const PORTAL_KEEPS: Record<Exclude<Realm, 'none'>, PortalKeep> = {
    albion: {
        name: 'Castle Sauvage', regionId: 1, keyword: 'Castle Sauvage', landing: { x: 584151, y: 477177, z: 2600 },
        teleporter: { name: 'Master Visur', x: 585995, y: 477187, z: 2623 }, merchant: { name: 'Sall Fadri', x: 585622, y: 476804, z: 2600 },
        bind: { x: 585891, y: 476614, z: 2600 },
    },
    midgard: {
        name: 'Svasud Faste', regionId: 100, keyword: 'Svasud Faste', landing: { x: 767242, y: 669591, z: 5736 },
        teleporter: { name: 'Stor Gothi Annark', x: 765329, y: 668749, z: 5759 }, merchant: { name: 'Gwulla', x: 765797, y: 668576, z: 5736 },
        bind: { x: 765147, y: 668315, z: 5736 },
    },
    hibernia: {
        name: 'Druim Ligen', regionId: 200, keyword: 'Druim Ligen', landing: { x: 334342, y: 419994, z: 5184 },
        teleporter: { name: 'Glasny', x: 333733, y: 420740, z: 5207 }, merchant: { name: 'Araisa', x: 333231, y: 420812, z: 5184 },
        bind: { x: 333220, y: 420510, z: 5184 },
    },
};

/** Where an OFTeleporter takes a medallion: the pattern finds it, the region tells we arrived. */
export interface Passage {
    regionId: number;
    name: string;
    medallion: RegExp;
}

export interface Battleground extends Passage {
    minLevel: number;
    maxLevel: number;
    /** Ported only below this many realm points. */
    maxRealmPoints: number;
}

export const BATTLEGROUNDS: Record<number, Battleground> = {
    252: { regionId: 252, name: 'Thidranki', minLevel: 20, maxLevel: 24, maxRealmPoints: 7125, medallion: /Battlegrounds Medallion of Passage/ },
};

const CITY_MEDALLION = /Medallion of City Passage/;
/** Every medallion in the item templates has this in its name; a real Mythical item doesn't. */
const ANY_MEDALLION = /Medallion of .*Passage/;

/** Each realm's capital by city medallion, and where that port lands (OFTeleporters.cs:216, 374, 530). */
export const CAPITALS: Record<Exclude<Realm, 'none'>, Passage & { landing: Point3 }> = {
    albion: { regionId: 10, name: 'Camelot', medallion: CITY_MEDALLION, landing: { x: 36226, y: 29820, z: 7971 } },
    midgard: { regionId: 101, name: 'Jordheim', medallion: CITY_MEDALLION, landing: { x: 31746, y: 27429, z: 8792 } },
    hibernia: { regionId: 201, name: 'Tir na Nog', medallion: CITY_MEDALLION, landing: { x: 34140, y: 32058, z: 8047 } },
};

/** Mythical slot, where the medallion is worn. */
const MYTHICAL = 37;
/** Town teleporters that answer a portal keep's name. */
const TOWN_TELEPORTERS = /LiveTeleporter|InlandTeleporter|SimpleTeleporter/;
/** How far a member may stand from the town teleporter that takes it to the portal keep. */
const TOWN_RANGE = 4000;
/** The OFTeleporter ports players within 500; stand well inside that. */
const PORT_RANGE = 150;
/** The port interval (120 s), the 5 s cast and the second port 10 s later, plus slack. */
const PORT_WAIT_MS = 150_000;
/** walkTogether keeps members this close: to the first one at the start (its route is everyone's), to each leg's end after a failed walk. */
const TOGETHER = 1500;
/** Everyone stands this near a battleground's exit before anyone takes it. The server checks no distance (RegionChangeRequestHandler.cs). */
const EXIT_RANGE = 300;

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const me = (m: Member) => m.sdk.getPlayer()!;
const nameOf = (m: Member) => m.sdk.getPlayer()?.name ?? m.bot;
export const at = (m: Member) => `r${me(m).regionId} (${Math.round(me(m).x)}, ${Math.round(me(m).y)})`;

/** The portal keep of a member's realm. */
export function portalKeepOf(m: Member): PortalKeep {
    const realm = me(m).realm;
    if (realm === 'none') throw new Error(`${nameOf(m)} has no realm`);
    return PORTAL_KEEPS[realm];
}

/** The capital of a member's realm. */
export function capitalOf(m: Member): Passage & { landing: Point3 } {
    const realm = me(m).realm;
    if (realm === 'none') throw new Error(`${nameOf(m)} has no realm`);
    return CAPITALS[realm];
}

export const inCapital = (m: Member) => me(m).regionId === capitalOf(m).regionId;

export const inBattleground = (m: Member, bg: Battleground) => me(m).regionId === bg.regionId;
export const atPortalKeep = (m: Member, keep: PortalKeep) => me(m).regionId === keep.regionId && dist(me(m), keep.teleporter) < 3000;

/**
 * The nearest town teleporter of the member's realm within `radius` (default 4000; static spawns),
 * at that default the one toPortalKeep asks. Realms' teleporters can stand 150 apart (Atlantis),
 * and another realm's never answers.
 */
export function townTeleporter(m: Member, radius = TOWN_RANGE): NpcSpawnMatch | undefined {
    const p = me(m);
    return findNpcSpawns({ regionId: p.regionId, near: p, radius, classType: TOWN_TELEPORTERS, realm: p.realm, limit: 1 })[0];
}

/**
 * The members a walk to a town teleporter is for: outside the battleground, away from their
 * portal keep and with no town teleporter within 4000. The others stay where they are.
 */
export function viaWalkers(members: Member[], bg: Battleground): Member[] {
    return members.filter(m => !inBattleground(m, bg) && !atPortalKeep(m, portalKeepOf(m)) && !townTeleporter(m));
}

/** Why a member can't be ported into `bg`, or null. */
export function entryProblem(m: Member, bg: Battleground): string | null {
    const p = me(m);
    if (p.isDead) return 'dead';
    if (p.level < bg.minLevel || p.level > bg.maxLevel) return `level ${p.level}: ${bg.name} takes ${bg.minLevel}-${bg.maxLevel}`;
    if (p.realmPoints >= bg.maxRealmPoints) return `${p.realmPoints} realm points: ${bg.name} takes fewer than ${bg.maxRealmPoints}`;
    return null;
}

/** Run `f` and wait (up to `ms`) for a region change or a jump of more than 3000. */
async function jump(m: Member, f: () => Promise<unknown>, ms: number): Promise<boolean> {
    const from = me(m);
    await f();
    const moved = await m.sdk.waitForCondition(s => !!s.player && (s.player.regionId !== from.regionId || dist(s.player, from) > 3000), ms).then(() => true).catch(() => false);
    // Let the new area's objects arrive.
    if (moved) await Bun.sleep(2000);
    return moved;
}

/**
 * Walk the members to `to` together: legs of `leg` along a route around aggressive mobs,
 * regrouping at each. The route is planned from the first member, so the others must start in
 * its region within 1500 of it. Null when everyone arrived, else why the walk stopped (someone
 * was attacked: the caller decides whether to fight; `pressOn` decides now, and walks on). `avoid`
 * adds circles the route stays out of (keepDangers). Without `to.z` the last leg leaves the height
 * to walkTo.
 */
export async function walkTogether(members: Member[], to: Point & { z?: number }, opts: { leg?: number; tolerance?: number; avoid?: readonly Danger[]; pressOn?: boolean; log?: (line: string) => void } = {}): Promise<string | null> {
    if (!members.length) return null;
    const leg = opts.leg ?? 3000;
    const start = me(members[0]!);
    const apart = members.filter(m => me(m).regionId !== start.regionId || dist(me(m), start) > TOGETHER);
    if (apart.length) return `not together: ${apart.map(m => `${nameOf(m)} ${at(m)}`).join(', ')}, more than ${TOGETHER} from ${nameOf(members[0]!)} ${at(members[0]!)}`;
    const route = [start, ...safePath(start.regionId, start.level, start, to, opts.avoid)];
    const points: Point[] = [];
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!, b = route[i]!;
        const n = Math.max(1, Math.ceil(dist(a, b) / leg));
        for (let k = 1; k <= n; k++) points.push({ x: Math.round(a.x + (b.x - a.x) * k / n), y: Math.round(a.y + (b.y - a.y) * k / n) });
    }
    opts.log?.(`walking ${points.length} legs (${Math.round(dist(start, to))} straight) to (${to.x}, ${to.y})`);
    for (const [i, pt] of points.entries()) {
        const last = i === points.length - 1;
        // Health lost during the leg is an attack; a member that set out hurt from a fight is not.
        const before = members.map(m => me(m).healthPercent);
        const walks = await Promise.all(members.map(m => m.actions.walkTo(pt.x, pt.y, last ? { z: to.z, tolerance: opts.tolerance ?? 200 } : { tolerance: 250 })));
        const hurt = members.filter((m, j) => me(m).inCombat || me(m).healthPercent < before[j]!).map(m => `${nameOf(m)} ${me(m).healthPercent}%`);
        if (hurt.length) {
            const attacked = `attacked on leg ${i + 1}/${points.length} at (${pt.x}, ${pt.y}): ${hurt.join(', ')}`;
            if (!opts.pressOn) return attacked;
            opts.log?.(attacked);
        }
        const failed = walks.map((w, j) => (w.success ? null : `${nameOf(members[j]!)}: ${w.reason} ${w.message}`)).filter(Boolean);
        if (failed.length && members.some(m => dist(me(m), pt) > TOGETHER)) return `leg ${i + 1}/${points.length}: ${failed.join('; ')}`;
        if ((i + 1) % 5 === 0 || last) opts.log?.(`leg ${i + 1}/${points.length}, ${Math.round(dist(me(members[0]!), to))} to go`);
    }
    return null;
}

/** Ask our realm's town teleporter within 4000 for the portal keep (walking to it first). */
export async function toPortalKeep(m: Member, keep: PortalKeep): Promise<string> {
    if (atPortalKeep(m, keep)) return `already at ${keep.name}`;
    const p = me(m);
    const spot = townTeleporter(m);
    if (!spot) return `no ${p.realm} town teleporter within ${TOWN_RANGE} of (${Math.round(p.x)}, ${Math.round(p.y)})`;
    if (dist(p, spot) > 400) {
        const route = safePath(p.regionId, p.level, p, spot);
        await m.actions.followPath([...route.slice(0, -1), { x: spot.x, y: spot.y, z: spot.z }], { tolerance: 150 });
    }
    // An emissary answers whispers only once a right-click has loaded its destinations.
    const emissary = /SimpleTeleporter/.test(spot.classType);
    for (let attempt = 0; attempt < 3; attempt++) {
        const w = await m.actions.walkToObject(spot.name, { range: 250 });
        if (!w.success) return `can't reach ${spot.name}: ${w.message}`;
        if (emissary) await m.actions.talkTo(spot.name);
        if (await jump(m, () => m.actions.whisper(spot.name, keep.keyword), 20_000) && atPortalKeep(m, keep)) return `teleported to ${keep.name} by ${spot.name}`;
    }
    return `${spot.name} did not port us to ${keep.name}`;
}

/**
 * /bind at the portal keep's stone. "/bind" answers "You are now bound to this location.",
 * or "You must wait N seconds to bind again!" (a cooldown after the last bind).
 */
export async function bindAtPortalKeep(m: Member, keep: PortalKeep): Promise<string> {
    const p = me(m);
    const b = nearestBindpoint(p.regionId, p.x, p.y, p.realm);
    if (!b || dist(b, keep.bind) > 500) return `no bind stone at ${keep.name}`;
    await m.actions.walkTo(b.x, b.y, { z: b.z, tolerance: 60 });
    for (let attempt = 0; attempt < 3; attempt++) {
        const since = m.sdk.getGameMessages().at(-1)?.id ?? 0;
        await m.sdk.sendCommand('/bind');
        const answer = () => m.sdk.getGameMessages().find(g => g.id > since && /now bound|must wait|can't bind|cannot bind|not close/i.test(g.text))?.text;
        await m.sdk.waitForCondition(() => !!answer(), 5000).catch(() => null);
        const text = answer() ?? 'no answer to /bind';
        const wait = text.match(/must wait (\d+) second/i);
        if (!wait) return text;
        await Bun.sleep((Number(wait[1]) + 1) * 1000);
    }
    return 'bind: still on cooldown';
}

export interface MedallionResult {
    /** The member has the medallion: worn, or in the backpack for getMedallion. */
    ok: boolean;
    note: string;
}

/** Worn medallions are in the equipment (slots 10-37), never in the backpack list. */
export const wearsMedallion = (m: Member, to: Passage) => to.medallion.test(m.sdk.getEquipmentItem(MYTHICAL)?.name ?? '');
const carriesMedallion = (m: Member, to: Passage) => m.sdk.getInventory().some(i => to.medallion.test(i.name));
const wearsOtherMedallion = (m: Member, to: Passage) => ANY_MEDALLION.test(m.sdk.getEquipmentItem(MYTHICAL)?.name ?? '') && !wearsMedallion(m, to);

/** Have the free medallion: worn already, in the backpack, or bought from the keep's merchant into it. */
export async function getMedallion(m: Member, keep: PortalKeep, to: Passage): Promise<MedallionResult> {
    if (wearsMedallion(m, to)) return { ok: true, note: 'medallion already worn' };
    if (carriesMedallion(m, to)) return { ok: true, note: 'medallion in the backpack' };
    const b = await m.actions.buyItem(keep.merchant.name, to.medallion);
    await m.actions.closeMerchant();
    if (!b.success) return { ok: false, note: `buy from ${keep.merchant.name}: ${b.reason} ${b.message}` };
    return carriesMedallion(m, to) ? { ok: true, note: 'medallion bought' } : { ok: false, note: `bought from ${keep.merchant.name}, but no medallion in the backpack` };
}

/** Get the free medallion (getMedallion) and wear it: it goes to the Mythical slot. */
export async function wearMedallion(m: Member, keep: PortalKeep, to: Passage): Promise<MedallionResult> {
    if (wearsMedallion(m, to)) return { ok: true, note: 'medallion already worn' };
    const got = await getMedallion(m, keep, to);
    if (!got.ok) return got;
    const e = await m.actions.equipItem(to.medallion);
    if (!e.success) return { ok: false, note: `equip: ${e.reason} ${e.message}` };
    // The equip result can come a snapshot before the equipment shows the item in its slot.
    const worn = await m.sdk.waitForCondition(s => s.equipment.some(i => i.slot === MYTHICAL && to.medallion.test(i.name)), 3000).then(() => true).catch(() => false);
    return worn ? { ok: true, note: 'medallion worn' } : { ok: false, note: 'medallion not in the Mythical slot' };
}

/**
 * Stand by the keep's OFTeleporter until its next cast ports us to `to`. Only from the keep's own
 * region: its coordinates elsewhere are a walk across the map, which ends at the script timeout.
 */
export async function waitForPort(m: Member, keep: PortalKeep, to: Passage): Promise<string> {
    if (me(m).regionId !== keep.regionId) return `not at ${keep.name}: ${at(m)}`;
    const t = keep.teleporter;
    const w = await m.actions.walkTo(t.x, t.y, { z: t.z, tolerance: PORT_RANGE });
    if (!w.success && dist(me(m), t) > 400) return `walk to the teleporter: ${w.reason} ${w.message}`;
    const ported = await m.sdk.waitForCondition(s => s.player?.regionId === to.regionId, PORT_WAIT_MS).then(() => true).catch(() => false);
    if (ported) await Bun.sleep(2000);
    return ported ? `in ${to.name}` : `not ported after ${PORT_WAIT_MS / 1000} s (${Math.round(dist(me(m), t))} from the teleporter)`;
}

export interface EnterResult {
    success: boolean;
    message: string;
    /** What happened to each member, in order. */
    report: Record<string, string[]>;
}

/** Writes a run's per-member report: a line for one member, a step for several at once, the result when a step stops the run. */
export function stepLog(members: Member[], log?: (line: string) => void) {
    const report: Record<string, string[]> = Object.fromEntries(members.map(m => [nameOf(m), []]));
    const note = (m: Member, s: string) => { report[nameOf(m)]!.push(s); log?.(`${nameOf(m)}: ${s}`); };
    const each = async (list: Member[], f: (m: Member) => Promise<string | null>) => {
        const r = await Promise.all(list.map(m => f(m).catch(e => `failed: ${(e as Error).message}`)));
        list.forEach((m, i) => { if (r[i]) note(m, r[i]!); });
    };
    const failed = (what: string, why: [Member, string][]): EnterResult => ({ success: false, message: `${what}: ${why.map(([m, w]) => `${nameOf(m)} ${w}`).join(', ')}`, report });
    return { report, note, each, failed };
}
export type StepLog = ReturnType<typeof stepLog>;

/**
 * Port the members from their keep's OFTeleporter to `to(m)`: a medallion for elsewhere off, then
 * everyone's medallion into the backpack, one member at a time at the merchant (five buy windows
 * at once on one NPC gain nothing), and nobody wears one before all have one. Null once the waits
 * are over (the caller looks at who arrived), else why it stopped before anyone could be ported.
 */
export async function portTogether(going: Member[], to: (m: Member) => Passage, { note, each, failed }: StepLog): Promise<EnterResult | null> {
    // The next cast would take it wherever it says, and the queue can outlast the wait for that cast.
    const other = () => going.filter(m => wearsOtherMedallion(m, to(m)));
    await each(other(), async m => {
        const u = await m.actions.unequipItem(MYTHICAL);
        return u.success ? 'medallion for elsewhere taken off' : `unequip: ${u.reason} ${u.message}`;
    });
    if (other().length) return failed('medallion for elsewhere still on', other().map(m => [m, at(m)]));
    const lacking: [Member, string][] = [];
    for (const m of going) {
        const r = await getMedallion(m, portalKeepOf(m), to(m)).catch(e => ({ ok: false, note: `failed: ${(e as Error).message}` }));
        note(m, r.note);
        if (!r.ok) lacking.push([m, `(${r.note})`]);
    }
    if (lacking.length) return failed('no medallion', lacking);
    const bare = going.filter(m => !wearsMedallion(m, to(m)));
    const worn = await Promise.all(bare.map(m => wearMedallion(m, portalKeepOf(m), to(m)).catch(e => ({ ok: false, note: `failed: ${(e as Error).message}` }))));
    bare.forEach((m, i) => note(m, worn[i]!.note));
    const unworn = bare.flatMap((m, i): [Member, string][] => (worn[i]!.ok ? [] : [[m, `(${worn[i]!.note})`]]));
    if (unworn.length) {
        // Off again for the others, so the next cast can't take them without the rest.
        await each(going.filter(m => wearsMedallion(m, to(m))), async m => {
            const u = await m.actions.unequipItem(MYTHICAL);
            return u.success ? 'medallion taken off again' : `unequip: ${u.reason} ${u.message}`;
        });
        return failed('medallion not worn', unworn);
    }
    const away = () => going.filter(m => me(m).regionId !== to(m).regionId);
    await each(away(), m => waitForPort(m, portalKeepOf(m), to(m)));
    // A port that missed someone: the medallion is still worn, the next cast takes them.
    const missed = away();
    if (missed.length) await each(missed, m => waitForPort(m, portalKeepOf(m), to(m)));
    return null;
}

/** Release the dead among `list`. In a battleground that lands at the realm's portal keep there, next to its exit (GamePlayer.Release). */
export async function releaseDead(list: Member[], { each }: StepLog): Promise<void> {
    await each(list.filter(m => me(m).isDead), async m => {
        const r = await m.actions.releaseAndRespawn();
        return r.success ? `released: ${at(m)}` : `release: ${r.reason} ${r.message}`;
    });
}

/** The zone point out of a battleground for a member's realm, from static data. */
export function battlegroundExit(m: Member, bg: Battleground): ZonePoint | undefined {
    const realm = realmId(me(m).realm);
    return getZonePointsFrom(bg.regionId).find(z => z.realm === realm);
}

/** Members who can walkTogether: one region, within 1500 of the first of their cluster. */
function clustersOf(members: Member[]): Member[][] {
    const clusters: Member[][] = [];
    for (const m of members) {
        const c = clusters.find(c => me(c[0]!).regionId === me(m).regionId && dist(me(c[0]!), me(m)) <= TOGETHER);
        if (c) c.push(m);
        else clusters.push([m]);
    }
    return clusters;
}

/**
 * Take every member still in the battleground out through its realm's zone point, to the portal
 * keep outside: the dead released first, each cluster of members walking together (walkTogether
 * round aggressive mobs and enemy keeps, on through an attack: the exit stands in our own keep),
 * and nobody jumps before all stand by the exit. After an RvR run members stand all over (the
 * released ones at the keep). Members already out are left alone, so it can simply run again.
 */
export async function leaveBattleground(members: Member[], opts: { regionId?: number; log?: (line: string) => void } = {}): Promise<EnterResult> {
    const bg = BATTLEGROUNDS[opts.regionId ?? 252];
    if (!bg) throw new Error(`no battleground data for region ${opts.regionId}`);
    const run = stepLog(members, opts.log);
    const { report, note, each, failed } = run;
    const inside = () => members.filter(m => inBattleground(m, bg));
    await releaseDead(inside(), run);
    const dead = inside().filter(m => me(m).isDead);
    if (dead.length) return failed('still dead', dead.map(m => [m, at(m)]));

    const going = inside();
    const exit = going.length ? battlegroundExit(going[0]!, bg) : undefined;
    if (going.length && !exit) return failed(`no zone point out of ${bg.name}`, going.map(m => [m, at(m)]));
    if (exit) {
        const spot = { x: exit.sourceX, y: exit.sourceY, z: exit.sourceZ };
        const off = () => going.filter(m => dist(me(m), spot) > EXIT_RANGE);
        const avoid = keepDangers(bg.regionId, me(going[0]!).realm);
        for (const m of off()) note(m, `walking to the exit (${spot.x}, ${spot.y})`);
        const stops = await Promise.all(clustersOf(off()).map(c => walkTogether(c, spot, { avoid, pressOn: true, tolerance: EXIT_RANGE - 100, log: opts.log })));
        const stop = stops.filter(Boolean);
        if (stop.length) return { success: false, message: stop.join('; '), report };
        if (off().length) return failed('not at the exit', off().map(m => [m, at(m)]));
        await each(going, async m => {
            const r = await m.actions.useZonePoint(exit, { tolerance: EXIT_RANGE });
            return r.success ? `out: ${at(m)}` : `zone point ${exit.id}: ${r.reason} ${r.message}`;
        });
        // Let the new area's objects arrive.
        await Bun.sleep(2000);
    }
    return { success: !inside().length, message: members.map(m => `${nameOf(m)} ${at(m)}`).join(', '), report };
}

/**
 * Take every member into the battleground: a town teleporter to the realm's portal keep, a
 * bind at its stone (`bind`, default true), the medallion, then the wait by the OFTeleporter.
 * Each member must stand within 4000 of a town teleporter of its realm, or at the portal keep
 * already; `via` first walks the members who stand by neither there, together (walkTogether). Members
 * already in the battleground are left alone; the steps already done are skipped, so it can
 * simply run again. Every step that could leave one member behind is checked for the whole
 * group before anyone takes it.
 */
export async function enterBattleground(members: Member[], opts: { regionId?: number; bind?: boolean; via?: Point & { z?: number }; log?: (line: string) => void } = {}): Promise<EnterResult> {
    const bg = BATTLEGROUNDS[opts.regionId ?? 252];
    if (!bg) throw new Error(`no battleground data for region ${opts.regionId}`);
    const run = stepLog(members, opts.log);
    const { report, note, each, failed } = run;
    const pending = () => members.filter(m => !inBattleground(m, bg));
    const problems = pending().map(m => [m, entryProblem(m, bg)] as const).filter(([, p]) => p);
    if (problems.length) return { success: false, message: problems.map(([m, p]) => `${nameOf(m)}: ${p}`).join('; '), report };

    if (opts.via) {
        const walkers = viaWalkers(members, bg);
        for (const m of walkers) note(m, `walking to (${opts.via.x}, ${opts.via.y})`);
        const stop = await walkTogether(walkers, opts.via, { log: opts.log });
        if (stop) return { success: false, message: stop, report };
    }
    // Nobody ports before everyone can: the first ones would stand in another region.
    const stranded = pending().filter(m => !atPortalKeep(m, portalKeepOf(m)) && !townTeleporter(m));
    if (stranded.length) return failed(`no town teleporter of their realm within ${TOWN_RANGE}`, stranded.map(m => [m, at(m)]));
    await each(pending(), m => toPortalKeep(m, portalKeepOf(m)));
    const away = pending().filter(m => !atPortalKeep(m, portalKeepOf(m)));
    if (away.length) return failed('not at the portal keep', away.map(m => [m, at(m)]));
    if (opts.bind !== false) await each(pending(), m => bindAtPortalKeep(m, portalKeepOf(m)));

    const stopped = await portTogether(pending(), () => bg, run);
    if (stopped) return stopped;
    const where = members.map(m => `${nameOf(m)} ${at(m)}`);
    return { success: !pending().length, message: where.join(', '), report };
}
