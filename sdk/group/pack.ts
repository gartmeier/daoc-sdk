// Hit and run in a battleground, the wolf pack: join a fight head on, area mezz, every member's damage on one
// target from where it stands, run a bit, turn, pick the next target, kill it, and so on (user, live: the first
// version kept away and avoided all fights). It walks off only when hurt or out of power. Nobody walks alone: a member released to the portal
// keep waits there until the pack comes for it, and a broken pack goes home, rebuffs and starts over together.
//
// Why it isn't rvr-roam with other numbers (round 9, 20261103-203805): both groups hunted each other head-on on
// speed songs, nothing made anyone stop at range, and every cast walked to 85 % of its range from its own target,
// so Hibernia ended up on the far side of Midgard with its first hit 8 s after the engage.
//
// Server rules it leans on (server/core/GameServer):
//  - Every mezz here reaches 1500. A mezz leaves a player immune for 60 s after it ends, so raids on one group
//    can't come much faster than the cooldown below.
//  - A speed song doesn't take on anyone in combat in the last 10 s (SpeedEnhancementSpellHandler.cs:69,
//    GameLiving.IN_COMBAT_DURATION): the first stretch of a pull back runs on sprint alone. Leave before contact.
//  - Enemy classes aren't visible: a healer is known once it healed (Contact.healer), a caster once it cast.
//
// decidePack only writes orders; rvr-roam's decideRvr still does patrol, rest, monsters and winding down.

import { estimateZ } from '../../data/index';
import type { Realm } from '../types';
import type { Behavior } from './member';
import { backupHeal, confuse, crowdControl, flee, interrupt, rest, rez, release, retreat, SAVING_POWER, shedLoad, song, sprint, holdFormation, buff } from './behaviors';
import { isAlive, untouchable } from './blackboard';
import { immuneKinds } from './cc';
import { assignCc } from './pve';
import { aggroZones } from './terrain';
import { decideRvr, focusHealed, groupRegion, homeOf, keepDangers, legAnchor, mainBody, monsterAdds, onWhom, patrolRing, pickPackFocus, realmOfGroup, runWay, rvrBehaviors, rvrFindings, rvrRoaming, RVR_SETTINGS, spotAlong, staysDry, stepLeg, type RvrSettings, type Trip } from './rvr';
import type { CoordinatorContext, GroupStrategy } from './strategy';
import { clearOf } from './keeps';
import type { ColumnOrder, Contact, MemberReport, OrdersUpdate, Point, Point3, Role } from './types';
import { drySpot, isWet, waitAshore } from './water';

export { focusHealed, pickPackFocus } from './rvr';

/** The pack's waitAshore memory key: decideRvr, run for its quiet times, has its own. */
const PACK_ASHORE = 'packAshoreSince';

export interface PackOptions {
    /** Stop this far from the nearest enemy of a group we mean to raid. */
    standoff: number;
    /** What a cast reaches: a raid's focus and mezzes are chosen within it. */
    reach: number;
    /** A raid opens when the nearest enemy stands this close to our centre, so that the casters behind it reach too. */
    openAt: number;
    /** A raid with nothing in reach for this long ends: nothing is coming. */
    idleMs: number;
    /** After this long at the stand-off with nobody coming, move in to reach. */
    waitMs: number;
    /** At least this many together to start a raid. */
    minPack: number;
    /** Fewer than this together: the pack is broken and goes home. */
    minTogether: number;
    /** Below this a member makes the pack rest, up to settings.ready ... */
    raidReady: { hp: number; mana: number };
    /** ... where it stands, with enemies no nearer than this; nearer, it moves off first. */
    restClear: number;
    /**
     * With a free enemy player this close to the centre nobody rests: the fight goes on (resting walked the pack away from
     * enemies on it, arena round 4, 2026-11-09: the Bard died in that leave). 0: off, resting may leave as before.
     */
    fightOn?: number;
    /**
     * Bolt this far when losing: a member dead and as many enemies near as we have left, or a second realm arriving with us
     * three short (shouldBolt). 0: never, the pack fights on in short pull backs. boltMs: how long at most, and no second bolt for boltCoolMs.
     */
    boltRun: number;
    boltMs: number;
    boltCoolMs: number;
    /** A focus whose health didn't change for this long is a phantom: left alone for phantomMs. */
    frozenMs: number;
    phantomMs: number;
    /** Refuse more free enemies than this round their nearest. */
    maxFoes: number;
    /** ... counting those within this of it. */
    crowdRadius: number;
    /** How long the burst lasts ... */
    raidMs: number;
    /** ... with this much more to finish a focus below finishHp ... */
    finishMs: number;
    finishHp: number;
    /** ... and it ends at once when this many free enemies stand within closeIn of one of our casters. */
    closeCount: number;
    closeIn: number;
    /** How far a pull back runs before it turns round. */
    pullBack: number;
    /** A pull back that hasn't arrived after this long turns round anyway (rooted, or far behind). */
    pullMs: number;
    /** Turn on at most this many chasers arriving together, within chaseGap of the first. */
    maxChasers: number;
    chaseGap: number;
    /** More than that: run on, at most this many more times; then stand, since running on gets us killed from behind. */
    maxLegs: number;
    /** Give up a focus whose health climbs this much above the lowest we had it at ... */
    healedBy: number;
    /** ... and leave it alone for this long. */
    droppedMs: number;
    /** Stop fighting chasers after this long. */
    killMs: number;
    /** Don't turn on stragglers with a member below this % health. */
    preyHp: number;
    /** How far to leave after a raid. */
    leave: number;
    /** No new raid for this long after the last one ended. */
    cooldownMs: number;
    /** After a wipe or a pickup: at least this long to let the buffs go round ... */
    rebuffMs: number;
    /** ... and everyone at least this ready. */
    rebuffReady: { hp: number; mana: number };
    /** Released members within this of the keep's arrival wait there for the pack. */
    keepRadius: number;
    /**
     * Travel as a column (Orders.column) while no enemy player stands within this of our centre: the crowd controller in
     * front (columnOrder), the others behind him. The first enemy this close spreads the pack into its slots, before a raid
     * opens at openAt. Members see 3000 (agent.sightRadius) round themselves, which the pack's centre can put 4800 off
     * (live, a hunt began there), so a large value (99999) spreads on the first enemy anyone sees.
     * 0: never, slots all the way (as before).
     */
    column: number;
    /**
     * The slots stay this long after the last enemy within `column`, so one that goes stale or out of view for a moment
     * doesn't string the pack out again mid-stalk (live, it flipped back for a second as the nearest foe went stale).
     */
    columnCalmMs: number;
    /**
     * The focus goes on the back line: known casters, then healers, never one in melee with us while another is in reach
     * (pickPackFocus soft), and a focus that is neither gives way to one that is, once one is known. User, live
     * 2026-11-09: our whole group burnt their tank first. Off: the nearest, as before.
     */
    focusSoft: boolean;
    /**
     * Casters (nukers and the healer) in a fight stand at least this far from the nearest free enemy player and step back
     * when one comes closer (fanOut), and fanGap from each other. User, live 2026-11-09: casters fanned out, stayed as far
     * off as they could and picked off what came close. 0: off, they hold where they stand.
     */
    fanMin: number;
    fanGap: number;
    /** Steps between places in the column. */
    columnGap: number;
    /** The driver's share of full speed; the others walk at full speed (the mover's default), so one that fell back closes up. */
    columnSpeed: number;
}

export interface PackSettings extends RvrSettings {
    pack: PackOptions;
}

export const PACK_OPTIONS: PackOptions = {
    standoff: 1500, reach: 1500, openAt: 1450, idleMs: 3000, waitMs: 0, minPack: 3, minTogether: 3,
    // User, live: fights may be joined head on, the first version avoided all of them. Only a real crowd is refused.
    boltRun: 0, boltMs: 15_000, boltCoolMs: 30_000, frozenMs: 20_000, phantomMs: 120_000, maxFoes: 8, crowdRadius: 1000, raidReady: { hp: 50, mana: 25 }, restClear: 2500,
    raidMs: 8000, finishMs: 4000, finishHp: 25, closeCount: 3, closeIn: 700,
    pullBack: 1500, pullMs: 6000, maxChasers: 2, chaseGap: 800, maxLegs: 0, killMs: 12_000, preyHp: 40, healedBy: 30, droppedMs: 15_000,
    leave: 2000, cooldownMs: 0,
    rebuffMs: 20_000, rebuffReady: { hp: 90, mana: 80 }, keepRadius: 2500,
    // Off until rounds compare it with the slots: --pack.column=3500.
    column: 0, columnCalmMs: 30_000, columnGap: 120, columnSpeed: 0.9,
    // Off until pair rounds compare them with the current pack: --pack.focusSoft=true --pack.fanMin=1100.
    focusSoft: false, fanMin: 0, fanGap: 400,
};

export const PACK_SETTINGS: PackSettings = {
    ...RVR_SETTINGS,
    standGround: true,
    standStep: 500,
    areaMezzMin: 2,
    strongestNuke: true,
    // The Hero stands in front of the casters and hits what reaches them; he doesn't charge.
    chaseLeash: 800,
    // Everyone has to reach the same enemy from where they stand: rvr-roam's 700 behind the anchor leaves a nuker out of range.
    // The Bard leads: his mezz reaches 1500 like everyone's, and he has to be first in reach of the far ones.
    formation: { tank: { back: 0, angle: 0 }, healer: { back: 200, angle: 0.6 }, support: { back: -200, angle: 0 }, nuker: { back: 250, angle: 0.3 }, melee: { back: 120, angle: 0.8 } },
    ready: { hp: 70, mana: 50 },
    // Only between raids, from a corpse close by: a corpse the pack has left releases and is picked up.
    // Nobody releases while the raid, its pull backs or a bolt go on (rvr-roam's fightHoldMs).
    rez: { holdMs: 20_000, radius: 2000, sit: false, reserve: 25, inFight: false, fightHoldMs: RVR_SETTINGS.rez!.fightHoldMs },
    // These orders walk off and rest with an enemy in sight, so a pet's fight has to come off by itself (petControl).
    pet: { ...RVR_SETTINGS.pet!, strayFightsOff: true },
    pack: PACK_OPTIONS,
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: readonly Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc || !!m.capabilities.pet;
/** What a member short of power waits on: its summon's, shown as SAVING_POWER, as decideRvr and decidePve say, or its own. */
const powerWhy = (m: MemberReport) => (m.activity?.detail === SAVING_POWER ? 'pet power' : 'power');
const soft = (m: MemberReport) => m.role === 'healer' || m.role === 'support' || m.role === 'nuker';
const tag = (c: Contact) => `${c.name}#${c.objectId} (${c.hp}%${c.healer ? ' healer' : c.caster ? ' caster' : ''})`;

/**
 * Who gets mezzed, by whom; nothing but a mezz may hit a mezzed enemy, and two never go on one. The Bard takes the biggest cluster an area mezz would catch without the focus, else a
 * known healer, else the farthest: the near ones are about to be fought. A nuker's mezz costs a nuke, so it goes on
 * healers only. `roots` adds members with only a root (the Druid), for chasers: a root on a raid's target breaks at
 * the first hit and keeps her from healing.
 */
export function packCc(foes: readonly Contact[], members: readonly MemberReport[], current: readonly { targetId: number; by: string }[], o: { centre: Point; focus: Contact | null; areaRadius: number; roots?: boolean; now: number; keep?: readonly Contact[] }): { targetId: number; by: string }[] {
    // `keep`: where an assignment already made may stay though its target left `foes` (the raid's reach). A 2.5 s mezz can't
    // finish on a target that changes every 2 s: arena round 5, 2026-11-09, Oisin's went 482, 481, 488 in the opening.
    const kept = (o.keep ?? []).filter(c => !foes.includes(c) && current.some(a => a.targetId === c.objectId));
    const pool = [...foes, ...kept].filter(c => c.objectId !== o.focus?.objectId && !c.cc);
    const catches = (c: Contact) => (o.focus && dist(c, o.focus) <= o.areaRadius ? 0 : pool.filter(n => dist(n, c) <= o.areaRadius).length);
    const order = [...pool].sort((a, b) => catches(b) - catches(a) || Number(!!b.healer) - Number(!!a.healer) || dist(b, o.centre) - dist(a, o.centre));
    const mezzers = members.filter(m => m.capabilities.cc && (m.role === 'support' || m.role === 'nuker' || o.roots));
    const out = assignCc(order, [...mezzers], [...current]);
    const roleOf = (a: { by: string }) => members.find(m => m.name === a.by)?.role;
    const at = (a: { targetId: number }) => pool.find(c => c.objectId === a.targetId);
    // A root landing on a mezzed enemy wakes it (GameLiving.cs:1716-1727), so a root stays clear of what the Bard's mezz can catch.
    const bard = out.filter(a => roleOf(a) === 'support').map(at).filter(c => !!c);
    return out.filter(a => {
        const role = roleOf(a), c = at(a);
        if (!c) return false;
        if (role === 'healer') return !immuneKinds(c).includes('root') && !bard.some(b => dist(b, c) <= o.areaRadius);
        if (immuneKinds(c).includes('mezz')) return false;
        return role !== 'nuker' || !!c.healer;
    });
}

/** Who follows nearer the driver: the tank meets what comes first, the healers walk last. */
const COLUMN_RANK: Record<Role, number> = { tank: 0, melee: 1, nuker: 2, support: 3, healer: 4 };

/**
 * Who leads the column and in what order the others follow. The driver is the crowd controller, as humans' Bard or
 * Sorcerer: the support with a mezz, else a nuker with one, else anyone with one, else the tank. His mezz opens a
 * raid, so he should be first in reach. Null with fewer than two.
 */
export function columnOrder(main: readonly MemberReport[]): { driver: string; order: string[] } | null {
    if (main.length < 2) return null;
    const lead = (m: MemberReport) => (m.capabilities.cc ? (m.role === 'support' ? 0 : m.role === 'nuker' ? 1 : 2) : m.role === 'tank' ? 3 : 4);
    const driver = [...main].sort((a, b) => lead(a) - lead(b) || a.name.localeCompare(b.name))[0]!;
    const order = main.filter(m => m !== driver).sort((a, b) => COLUMN_RANK[a.role] - COLUMN_RANK[b.role] || a.name.localeCompare(b.name)).map(m => m.name);
    return { driver: driver.name, order };
}

/**
 * Whether a pack in a fight should run for it. Live, it lost four or five within a minute or so when two groups converged,
 * one at a time, still turning on its chasers after each 1500-unit pull back.
 */
export function shouldBolt(near: readonly Pick<Contact, 'realm'>[], alive: number, dead: number): boolean {
    if (dead > 0 && near.length >= alive) return true;
    return new Set(near.map(c => c.realm)).size >= 2 && near.length >= alive + 3;
}

/**
 * Leave alone a focus whose health stands still. Live, a Briton frozen at 33 %, in no member's view and never hit, held the
 * pack in hunt, kill and pull back for two whole rounds. Anything really fought changes health well within frozenMs.
 */
export function noticePhantom(mem: Record<string, any>, contacts: readonly Contact[], focusId: number | null, now: number, k: Pick<PackOptions, 'frozenMs' | 'phantomMs'>): void {
    mem.phantoms ??= {};
    for (const [id, until] of Object.entries(mem.phantoms) as [string, number][]) if (until <= now) delete mem.phantoms[id];
    const focus = focusId === null ? undefined : contacts.find(c => c.objectId === focusId);
    if (!focus) return;
    const f = mem.frozen;
    if (f?.id !== focus.objectId || f.hp !== focus.hp) mem.frozen = { id: focus.objectId, hp: focus.hp, since: now };
    else if (now - f.since >= k.frozenMs) { mem.phantoms[focus.objectId] = now + k.phantomMs; mem.frozen = undefined; }
}

export function decidePack(ctx: CoordinatorContext<PackSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    const k = s.pack;
    const players = (c: Contact) => c.kind === 'player';
    // rvr-roam with no enemy players on the board: patrol, rest, regroup, monsters that attack us, winding down.
    const calm = () => decideRvr({ ...ctx, picture: { ...p, contacts: p.contacts.filter(c => !players(c)) } });
    const alive = p.members.filter(m => !m.isDead);
    if (!alive.length) { mem.pack = 'home'; return { ...calm(), column: null, spread: false }; }
    const regionId = groupRegion(alive);
    if (!mem.realm || mem.realm === 'none') mem.realm = realmOfGroup(p.members);
    const realm: Realm = mem.realm;
    const homeSpot = homeOf(regionId, realm)?.arrival ?? null;
    const here = alive.filter(m => m.regionId === regionId);
    const leader = here.find(m => m.role === 'tank') ?? here[0]!;
    const level = Math.min(...here.map(m => m.level));
    const keeps = keepDangers(regionId, realm, s);
    const inKeep = (c: Point) => !clearOf(c, keeps);
    const zAt = (q: Point) => estimateZ(regionId, q.x, q.y, leader.z, { radius: 8000 });
    const dry = staysDry(s);
    const trip: Trip = { mem, now, regionId, level, avoid: keeps, travelLeg: s.travelLeg, zAt, dry };
    /** `q` as a place to stand: with stayDry, on the nearest bank (the one nearest `toward`) when it is in a river. */
    const onLand = (q: Point, toward: Point): Point3 => {
        const d = dry ? drySpot(regionId, q, { toward, ok: c => clearOf(c, keeps) }) : q;
        return { x: Math.round(d.x), y: Math.round(d.y), z: zAt(d) };
    };
    const ours = new Set(p.members.map(m => m.name));
    // A member whose pet is attacked counts as attacked, as in decideRvr.
    const onUs = (c: Contact) => { const n = onWhom(c); return n !== null && ours.has(n); };
    const attacked = new Set(p.contacts.filter(c => !c.stale && isAlive(c) && onUs(c)).map(c => onWhom(c)!));
    const { main, far } = mainBody(here, s.gatherRadius, mem, attacked);
    const centre = centroid(main);
    // A shade is no foe, as in decideRvr: no focus, no mezz, nobody to count (AbstractServerRules.cs:449-455).
    noticePhantom(mem, p.contacts, o.phase === 'engage' ? o.focus : null, now, k);
    // With stayDry, one swimming that isn't fighting us waits until it is ashore. User, live 2026-11-09: with the pair spot on
    // Hibernia's bank, Midgard swam across and the pack hunted it in the river (us 10-43 % of fight time wet, them 60-100 %).
    const swimming = (c: Contact) => dry && !onUs(c) && isWet(regionId, c);
    const foes = p.contacts.filter(c => players(c) && !mem.phantoms[c.objectId] && !untouchable(c, now) && !c.stale && isAlive(c) && c.regionId === regionId && (onUs(c) || !inKeep(c)) && !swimming(c));
    const free = foes.filter(c => !c.cc).sort((a, b) => dist(a, centre) - dist(b, centre));
    const stay: Point3 = onLand(centre, centre);
    const facing = free[0] ? { x: free[0].x, y: free[0].y } : undefined;
    // Released members at the keep stay put until the pack is within gatherRadius of them (they are in `main` then).
    // In a pair round nobody is picked up: those released walk out to the pack at its ring, which rests there for them (decideRvr).
    const pairRound = !s.patrol && !!s.opponent && !!patrolRing(regionId, realm, s.opponent)?.pair;
    const pickups = homeSpot && !pairRound ? far.filter(m => dist(m, homeSpot) <= k.keepRadius) : [];
    const pickupWait = pickups.map(m => ({ name: m.name, why: 'pickup' }));
    const dead = p.members.filter(m => m.isDead && m.regionId === regionId);
    const none = { focus: null, puller: null, cc: [], retreatTo: null };
    // Travelling with nobody near, nor anybody lately: a column behind the crowd controller. Every update says, as orders merge (setOrders).
    const foeNear = !!k.column && foes.some(c => dist(c, centre) <= k.column);
    if (foeNear) mem.columnFoeAt = now;
    const settled = mem.columnFoeAt === undefined || now - mem.columnFoeAt >= k.columnCalmMs;
    const column = (u: OrdersUpdate): ColumnOrder | null => {
        if (!k.column || (u.phase ?? o.phase) !== 'travel' || foeNear || !settled) return null;
        const c = columnOrder(main);
        return c && { ...c, gap: k.columnGap, speed: k.columnSpeed };
    };
    // spread: an enemy player is known, so casters take their wider slots (spreadOnSight) from the first sight on.
    const say = (u: OrdersUpdate): OrdersUpdate => ({ ...u, column: column(u), spread: foes.length > 0, waiting: [...(u.waiting ?? []).filter(w => w.why !== 'pickup'), ...pickupWait] });
    const areaRadius = 350;

    // Chasers are the Hero's: the anchor stands on the focus, so his leash lets him at it (never into a keep's circle).
    // A focus in a river: the bank nearest it, so he goes in no farther than his leash.
    // Nor into a monster camp: the casters reach a foe standing in one, and the Hero would bring its monsters into the fight.
    const onFocus = (c: Contact | null): Point3 => {
        if (!c || inKeep(c) || !clearOf(c, aggroZones(regionId, level))) return stay;
        const x = Math.round(c.x / 200) * 200, y = Math.round(c.y / 200) * 200;
        return onLand({ x, y }, c);
    };
    // The focus stays, unless it is out of reach or a healer is winning: then the next one, and that target rests a while.
    const keepFocus = (pool: readonly Contact[]): Contact | null => {
        mem.lowHp ??= {};
        mem.dropped ??= {};
        for (const [id, until] of Object.entries(mem.dropped) as [string, number][]) if (until <= now) { delete mem.dropped[id]; delete mem.lowHp[id]; }
        const held = pool.find(c => c.objectId === o.focus);
        if (held && focusHealed(mem.lowHp, held, k.healedBy)) mem.dropped[held.objectId] = now + k.droppedMs;
        const fresh = pool.filter(c => !mem.dropped[c.objectId]);
        const kept = fresh.find(c => c.objectId === o.focus);
        // focusSoft: a fighter we opened on gives way to a caster or healer as soon as one shows itself (casting), if that
        // one is free: a mezzed one pulled the focus off the free fighter, the raid took it back next tick (round 128).
        const backLine = (c: Contact) => !!c.caster || !!c.healer;
        const free = fresh.filter(c => !c.cc);
        if (kept && !(k.focusSoft && !backLine(kept) && free.some(backLine))) return kept;
        return pickPackFocus(free.length ? free : fresh.length ? fresh : pool, centre, k.reach, k.focusSoft);
    };
    const startPull = (why: string, legs = 0): OrdersUpdate => {
        mem.pack = 'pull';
        mem.pullAt = now;
        mem.pullLegs = legs;
        const to = spotAlong(trip, centre, runWay(centre, free.length ? free : foes, homeSpot), k.pullBack);
        return say({ ...none, phase: 'retreat', retreatTo: to, anchor: to, objective: 'pull back and see what follows', reason: `pull back: ${why}` });
    };
    const startLeave = (why: string): OrdersUpdate => {
        mem.pack = 'leave';
        mem.raidEnd = now;
        mem.leaveTo = spotAlong(trip, centre, runWay(centre, free.length ? free : foes, homeSpot), k.leave);
        stepLeg(trip, 'leave', mem.leaveTo, { from: centre, movers: main, replan: Infinity });
        return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'leave and rest', reason: `leave: ${why}` });
    };
    // Monsters on us in a player fight (a camp it came near): whoever can mezz and has no player to mezz takes them, those on a
    // healer or the Bard first (monsterAdds). Killed when they wake, after the players: decideRvr's calm fights monsters on us.
    const withBeasts = (cc: { targetId: number; by: string }[], focus: Contact | null) => {
        const beasts = monsterAdds(p.contacts.filter(c => c.regionId === regionId), focus?.objectId ?? null, here);
        const ranked = [...beasts.first, ...beasts.last].filter(c => !cc.some(a => a.targetId === c.objectId));
        if (!ranked.length) return cc;
        const spare = main.filter(m => m.capabilities.cc && !cc.some(a => a.by === m.name));
        return [...cc, ...assignCc(ranked, spare, o.cc.filter(a => ranked.some(c => c.objectId === a.targetId)), now)];
    };
    const fight = (kind: string, focus: Contact | null, cc0: { targetId: number; by: string }[], anchor: Point3, why: string): OrdersUpdate =>
        say({ phase: 'engage', puller: null, retreatTo: null, focus: focus?.objectId ?? null, cc: withBeasts(cc0, focus), anchor, ...(focus ? { facing: { x: focus.x, y: focus.y } } : {}), objective: `${kind} at (${anchor.x}, ${anchor.y})`, reason: `${kind}: ${focus ? tag(focus) : 'no target in reach'}, ${why}` });
    const startRaid = (why: string): OrdersUpdate => {
        mem.pack = 'raid';
        mem.raidAt = now;
        mem.raids = (mem.raids ?? 0) + 1;
        mem.packAnchor = stay;
        mem.holdSince = undefined;
        const focus = pickPackFocus(free.filter(c => dist(c, centre) <= k.reach), centre, k.reach, k.focusSoft);
        return fight('raid', focus, packCc(free.filter(c => dist(c, centre) <= k.reach), main, [], { centre, focus, areaRadius, now }), onFocus(focus), why);
    };

    // Broken: too few alive. A scattered pack isn't: the others walk back to the anchor of its largest cluster.
    if (mem.pack !== 'home' && mem.pack !== 'rebuff' && here.length < k.minTogether) { mem.pack = 'home'; mem.legKind = null; if (dead.length) mem.hadDead = true; }
    // A run that starts at the keep starts together and buffed.
    if (!mem.pack && homeSpot && dist(centre, homeSpot) <= k.keepRadius) { mem.pack = 'rebuff'; mem.rebuffAt = now; }
    mem.pack ??= 'stalk';

    if (mem.pack === 'bolt') {
        const chased = free.some(c => dist(c, centre) <= k.reach);
        if (now - mem.boltAt >= k.boltMs || !chased) { mem.pack = 'stalk'; mem.legKind = null; }
        else return say({ ...none, phase: 'retreat', retreatTo: mem.boltTo, anchor: mem.boltTo, objective: 'bolt: away from both', reason: 'bolt: running' });
    }
    if (k.boltRun && (mem.pack === 'raid' || mem.pack === 'pull' || mem.pack === 'kill') && now >= (mem.boltCool ?? 0)
        && shouldBolt(free.filter(c => dist(c, centre) <= k.reach + 500), main.length, dead.length)) {
        mem.pack = 'bolt';
        mem.boltAt = now;
        mem.boltCool = now + k.boltCoolMs;
        mem.boltTo = spotAlong(trip, centre, runWay(centre, free, homeSpot), k.boltRun);
        return say({ ...none, phase: 'retreat', retreatTo: mem.boltTo, anchor: mem.boltTo, objective: 'bolt: away from both', reason: `bolt: ${dead.length} dead, ${free.length} free vs ${main.length}` });
    }

    // ── Picking off: every enemy in sight crowd-controlled, but the focus. Break one on purpose and kill it, everyone on it and no
    // raid clock, then the next, one at a time, until none is left (ccHolds lets the members break it). User, live in Thidranki: with
    // all of them mezzed `free` was empty, so the pack stood by them and rebuffed until they woke. Winding down, only the focus in hand.
    const sight = foes.filter(c => dist(c, centre) <= s.huntRadius);
    // A focus given up as healed (keepFocus's dropped) is no longer in hand: free, it is the raid's to keep or replace. Counted
    // as in hand, it emptied `loose`, the pick broke a mezz on another, and the next tick it was loose again: a flip each tick.
    const givenUp = (mem.dropped?.[o.focus ?? -1] ?? 0) > now;
    const target = o.phase === 'engage' && !givenUp ? sight.find(c => c.objectId === o.focus) : undefined;
    const held = sight.filter(c => c.cc && c !== target);
    const loose = sight.filter(c => !c.cc && c !== target);
    if (!loose.length && (held.length || (mem.pack === 'pick' && target)) && main.length >= k.minPack && (!ctx.windingDown || target)) {
        mem.pack = 'pick';
        const near = sight.filter(c => dist(c, centre) <= k.reach);
        // The one in hand stays wherever it is; a new one is the pack's pick (pickPackFocus) among those in reach, if any are.
        const focus = keepFocus(target ? sight : near.length ? near : sight)!;
        // Nothing free to mezz, and the focus is to be broken: no cc orders.
        return fight('pick off', focus, [], onFocus(focus), `${sight.filter(c => c.cc && c !== focus).length} more crowd-controlled, ${main.length} of us`);
    }
    // Something woke or came: the pack's own fight, the focus kept while it is in reach (keepFocus).
    if (mem.pack === 'pick') {
        if (loose.some(c => dist(c, centre) <= k.reach)) { mem.pack = 'raid'; mem.raidAt = now; mem.packAnchor = stay; mem.holdSince = undefined; }
        else mem.pack = 'stalk';
    }

    if (mem.pack === 'raid') {
        const anchor: Point3 = mem.packAnchor;
        const reachable = free.filter(c => dist(c, centre) <= k.reach);
        const focus = keepFocus(reachable);
        const elapsed = now - mem.raidAt;
        const casters = main.filter(soft);
        const close = free.filter(c => casters.some(m => dist(m, c) <= k.closeIn)).length;
        const done = elapsed >= k.raidMs + (focus && focus.hp < k.finishHp ? k.finishMs : 0);
        if (close >= k.closeCount) return startPull(`${close} enemies on our casters`);
        // Nobody left in reach: on with the stalk, which finds the next target.
        if (!foes.length || (!reachable.length && elapsed >= k.idleMs)) mem.pack = 'stalk';
        else {
            if (done) return startPull(`${Math.round(elapsed / 1000)} s are up`);
            return fight('raid', focus, packCc(reachable, main, o.cc, { centre, focus, areaRadius, now, keep: free }), focus ? onFocus(focus) : anchor, `${free.length} free of ${foes.length} vs ${main.length}`);
        }
    }

    if (mem.pack === 'pull') {
        const reached = o.retreatTo ? dist(centre, o.retreatTo) < 600 : true;
        if (!reached && now - mem.pullAt < k.pullMs) return say({ phase: 'retreat', reason: o.reason });
        const following = free.filter(c => dist(c, centre) <= k.reach + 500);
        // Nobody followed: go on, the stalk below finds the next target or rests.
        if (!following.length) mem.pack = 'stalk';
        else {
        const lead = following[0]!;
        const together = following.filter(c => dist(c, lead) <= k.chaseGap).length;
        if (together > k.maxChasers && (mem.pullLegs ?? 0) < k.maxLegs) return startPull(`${together} followed together`, (mem.pullLegs ?? 0) + 1);
        mem.pack = 'kill';
        mem.killAt = now;
        mem.packAnchor = stay;
        const focus = pickPackFocus(following, centre, k.reach, k.focusSoft);
        return fight('kill', focus, packCc(following, main, [], { centre, focus, areaRadius, roots: true, now }), onFocus(focus), `${together} followed`);
        }
    }

    if (mem.pack === 'kill') {
        const close = free.filter(c => dist(c, centre) <= k.reach + 200);
        // Run a bit, pick the next target. Nobody near: on with the stalk.
        if (now - mem.killAt >= k.killMs && close.length) return startPull('run a bit');
        if (!close.length) mem.pack = 'stalk';
        else {
        const near = close.filter(c => dist(c, centre) <= k.crowdRadius).length;
        if (near > k.maxChasers + 1 && (mem.pullLegs ?? 0) < k.maxLegs) return startPull(`${near} on us`, (mem.pullLegs ?? 0) + 1);
        const focus = keepFocus(close);
        return fight('kill', focus, packCc(close, main, o.cc, { centre, focus, areaRadius, roots: true, now }), onFocus(focus), `${close.length} chasers vs ${main.length}`);
        }
    }

    if (mem.pack === 'leave') {
        // Enemies that come to us are fought, cooldown or not. Live, Midgard caught the pack with its back turned.
        if (free.some(c => onUs(c) || dist(c, centre) <= k.openAt)) mem.pack = 'stalk';
        else if (mem.leaveTo && dist(centre, mem.leaveTo) > 800 && now - mem.raidEnd < 30_000) {
            stepLeg(trip, 'leave', mem.leaveTo, { from: centre, movers: main, replan: Infinity });
            return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'leave and rest', reason: 'leave: moving off' });
        }
        else mem.pack = 'stalk';
    }

    if (mem.pack === 'home') {
        const pressed = free.some(c => dist(c, centre) <= k.reach && (onUs(c) || dist(c, centre) <= k.closeIn));
        // On a pickup trip with enough of us: fight what comes, and go on after it.
        if (pressed && main.length >= k.minTogether) mem.pack = 'stalk';
        else if (pressed) {
            const to = spotAlong(trip, centre, runWay(centre, free, homeSpot), k.pullBack);
            return say({ ...none, phase: 'retreat', retreatTo: to, anchor: to, objective: 'go home to regroup', reason: 'broken pack: running' });
        }
        else if ((!far.length || pairRound) && !dead.length && main.length >= Math.min(k.minTogether, here.length)) {
            if (mem.hadDead) { mem.pack = 'rebuff'; mem.rebuffAt = now; mem.hadDead = false; } else mem.pack = 'stalk';
        } else if (homeSpot && dist(centre, homeSpot) > 1000) {
            // Toward the keep, in legs everyone follows: a scattered pack comes together on the way, and stops as soon as it has.
            if (dead.length) mem.hadDead = true;
            stepLeg(trip, 'home', homeSpot, { from: centre, movers: main, replan: Infinity });
            return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'go home to regroup', reason: pickups.length ? `picking up ${pickups.map(m => m.name).join(', ')}` : `regrouping: ${main.length} together of ${here.length}` });
        } else {
            if (dead.length) mem.hadDead = true;
            return say({ ...calm(), phase: 'recover', anchor: stay, reason: 'regrouping: waiting for the others' });
        }
    }

    if (mem.pack === 'rebuff') {
        // A monster on one of ours: the calm side fights it (decideRvr), rebuff or not. Arena round 46 (2026-11-10): a mature boar
        // interrupted 75 heals in 9 minutes of "rebuffing ... waiting for Cuchulainn's health" and the Hero never swung at it.
        const beastOnUs = p.contacts.some(c => c.kind !== 'player' && !c.isPet && !c.stale && isAlive(c) && c.regionId === regionId && here.some(m => m.name === onWhom(c)));
        if (beastOnUs) return say(calm());
        if (free.some(c => dist(c, centre) <= k.standoff)) mem.pack = 'stalk';
        else {
            if (pickups.length || (far.length && !pairRound) || dead.length) { mem.pack = 'home'; mem.legKind = null; return say({ ...none, phase: 'recover', anchor: stay, reason: 'regrouping: someone is missing again' }); }
            const low = here.flatMap(m => [
                ...(m.hp < k.rebuffReady.hp ? [{ name: m.name, why: 'health' }] : []),
                ...(usesMana(m) && m.mana < k.rebuffReady.mana ? [{ name: m.name, why: powerWhy(m) }] : []),
            ]);
            const buffing = here.filter(m => m.activity?.kind === 'buff');
            if (now - mem.rebuffAt < k.rebuffMs || low.length || buffing.length) {
                return say({ ...none, phase: 'recover', anchor: stay, waiting: low, objective: 'rebuff and rest together', reason: `rebuffing: ${buffing.length} casting, waiting for ${low.map(w => `${w.name}'s ${w.why}`).join(', ') || 'the buffs to go round'}` });
            }
            mem.pack = 'stalk';
            mem.raids = mem.raids ?? 0;
        }
    }

    // ── Stalking ──
    if (dead.length) mem.hadDead = true;
    if (mem.hadDead && !dead.length && !far.length && !free.some(c => dist(c, centre) <= k.standoff)) { mem.hadDead = false; mem.pack = 'rebuff'; mem.rebuffAt = now; return say({ ...none, phase: 'recover', anchor: stay, reason: 'rebuffing: someone is back' }); }
    if (pickups.length && !free.some(c => dist(c, centre) <= k.standoff)) { mem.pack = 'home'; mem.legKind = null; stepLeg(trip, 'home', homeSpot!, { from: centre, movers: main, replan: Infinity }); return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'pick up the released', reason: `picking up ${pickups.map(m => m.name).join(', ')}` }); }
    const seen = free.filter(c => dist(c, centre) <= s.huntRadius);
    if (!seen.length) {
        mem.holdSince = undefined;
        // Only enemies swimming in sight: wait for them on dry ground, facing them, instead of patrolling on (waitAshore).
        const wet = p.contacts.filter(c => players(c) && swimming(c) && !c.stale && isAlive(c) && c.regionId === regionId && !inKeep(c) && dist(c, centre) <= s.huntRadius);
        if (waitAshore(mem, wet.length, now, PACK_ASHORE)) {
            const them = centroid(wet);
            return say({ ...none, phase: 'travel', anchor: stay, facing: { x: Math.round(them.x), y: Math.round(them.y) }, objective: `wait for ${wet.length} swimming`, reason: `wait ashore: ${wet.length} swimming ${Math.round(dist(centre, them))} away` });
        }
        return say(calm());
    }
    mem[PACK_ASHORE] = undefined;
    const lead = seen[0]!;
    const d = dist(lead, centre);
    const onUsNow = seen.some(onUs);
    const crowd = seen.filter(c => dist(c, lead) <= k.crowdRadius).length;
    const short = main.filter(m => m.hp < k.raidReady.hp || (usesMana(m) && m.mana < k.raidReady.mana));
    const cooling = now - (mem.raidEnd ?? -Infinity) < k.cooldownMs;
    // Low on power or hurt: rest until settings.ready, and stick to it. Live (s5) the pack flipped every second between hunting
    // two stragglers and walking off from a third that came into sight, so it neither rested nor fought. Rest where we stand
    // unless enemies are near (walking regenerates nothing): the Bard's power song and sitting come with 'recover'.
    // One nuker low doesn't stop five (s6: resting 23 % of the round, Ciaran's 197 power is 13 nukes): the healer or the Bard low does, or anyone badly hurt, or two nukers.
    const mustRest = short.some(m => m.hp < k.raidReady.hp || m.role === 'healer' || m.role === 'support') || short.length >= 2;
    const fightOn = (k.fightOn ?? 0) > 0 && seen.some(c => dist(c, centre) <= k.fightOn!);
    if (fightOn) { mem.resting = false; mem.movingOff = false; }
    else if (mustRest) mem.resting = true;
    if (mem.resting && !main.some(m => m.hp < s.ready.hp || (usesMana(m) && m.mana < s.ready.mana))) mem.resting = false;
    if (mem.resting) {
        const who = main.filter(m => m.hp < s.ready.hp || (usesMana(m) && m.mana < s.ready.mana));
        if (onUsNow || d <= k.reach) return startLeave(`${who.map(m => m.name).join(', ')} resting, and they are on us`);
        // Moving off goes on until well clear: at one line it flipped every second (s6).
        if (d <= k.restClear + (mem.movingOff ? 800 : 0)) {
            mem.movingOff = true;
            const goal = spotAlong(trip, centre, runWay(centre, seen, homeSpot), s.huntRadius);
            stepLeg(trip, 'avoid', goal, { from: centre, movers: main, replan: 2000 });
            return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'keep away while resting', reason: `resting: ${who.map(m => m.name).join(', ')}, moving off (nearest ${Math.round(d)} away)` });
        }
        mem.movingOff = false;
        return say({ ...none, phase: 'recover', anchor: stay, objective: 'rest', waiting: who.map(m => ({ name: m.name, why: powerWhy(m) })), reason: `resting: ${who.map(m => m.name).join(', ')} (nearest enemy ${Math.round(d)} away)` });
    }
    // Prey: all that is in sight is a couple of stragglers and we clearly outnumber them. No cooldown, no stand-off and no
    // raid clock for those: turn round and kill them, the Hero too. Live, 5 v 2 at the end of a round was refused as "still cooling down".
    const inSight = foes.filter(c => dist(c, centre) <= s.huntRadius);
    const prey = inSight.length <= k.maxChasers && main.length >= inSight.length + 2 && !main.some(m => m.hp < k.preyHp);
    if (prey && !ctx.windingDown) {
        if (d <= k.reach) {
            mem.pack = 'kill';
            mem.killAt = now;
            mem.pullLegs = 0;
            const focus = pickPackFocus(seen, centre, k.reach, k.focusSoft);
            return fight('kill', focus, packCc(seen, main, [], { centre, focus, areaRadius, roots: true, now }), onFocus(focus), `${inSight.length} in sight vs ${main.length}`);
        }
        stepLeg(trip, 'prey', lead, { from: centre, movers: main, replan: 500 });
        return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: { x: lead.x, y: lead.y }, objective: `hunt ${inSight.length} stragglers`, reason: `hunt ${tag(lead)}, ${Math.round(d)} away, ${inSight.length} in sight vs ${main.length}` });
    }
    const refuse = main.length < k.minPack ? `only ${main.length} together`
        : crowd > k.maxFoes ? `${crowd} enemies together`
        : cooling && d > k.openAt && !onUsNow ? 'still cooling down'
        : ctx.windingDown ? 'time is up'
        : null;
    if (refuse) {
        if (onUsNow || d <= k.reach) return short.length ? startLeave(refuse) : startPull(`${refuse}, and they are on us`);
        const goal = spotAlong(trip, centre, runWay(centre, seen, homeSpot), s.huntRadius);
        stepLeg(trip, 'avoid', goal, { from: centre, movers: main, replan: 2000 });
        return say({ ...none, phase: 'travel', anchor: legAnchor(mem), facing: mem.legFacing, objective: 'keep away', reason: `refuse: ${refuse} (${seen.length} seen, nearest ${Math.round(d)} away)` });
    }
    if (onUsNow || d <= k.openAt) return startRaid(`${crowd} enemies round the nearest, ${main.length} of us`);
    if (d <= k.standoff) {
        mem.holdSince ??= now;
        // The centre can't get the last few units: formation slack parked a live round 1469 from a Briton for 5 minutes. Casters step in.
        if (now - mem.holdSince >= k.idleMs) { mem.holdSince = undefined; return startRaid(`parked ${Math.round(d)} away, ${main.length} of us`); }
        const moving = now - mem.holdSince >= k.waitMs;
        const f = Math.max(0, d - (k.openAt - 100)) / d;
        const to = moving ? { x: Math.round(centre.x + (lead.x - centre.x) * f), y: Math.round(centre.y + (lead.y - centre.y) * f) } : stay;
        return say({ ...none, phase: 'travel', anchor: { ...to, z: zAt(to) }, ...(facing ? { facing } : {}), objective: 'stand off', reason: `${moving ? 'closing in on' : 'standing off from'} ${tag(lead)}, ${Math.round(d)} away` });
    }
    mem.holdSince = undefined;
    // Past the stand-off, or a pack that arrives a little short stays out of it for good.
    const f = (d - (k.openAt - 100)) / d;
    const goal = { x: centre.x + (lead.x - centre.x) * f, y: centre.y + (lead.y - centre.y) * f };
    // A leg counts as reached with every member within 1200 of it (rvr.ts LEG_REACHED), so a stalk can stop short of the
    // stand-off for good: two packs stalking each other stood ~1700 apart for 6 minutes (rounds 125 and 132, 0/0 at the cap).
    // Not closer by STALK_GAIN for STALK_STALL_MS near it: the anchor goes straight to the goal, as at the stand-off, unless
    // that is in water. It holds until the stand-off takes over, the lead changes, or the stalk is left.
    if (d <= k.standoff + STALK_STALL_BAND) {
        if (now - (mem.stalkSeen ?? -Infinity) > 5000 || mem.stalkLead !== lead.objectId) {
            mem.stalkLead = lead.objectId; mem.stalkBest = d; mem.stalkBestAt = now; mem.stalkClosing = false;
        }
        mem.stalkSeen = now;
        if (d < mem.stalkBest - STALK_GAIN) { mem.stalkBest = d; mem.stalkBestAt = now; }
        if ((mem.stalkClosing || now - mem.stalkBestAt >= STALK_STALL_MS) && !isWet(regionId, goal)) {
            mem.stalkClosing = true;
            const to = { x: Math.round(goal.x), y: Math.round(goal.y) };
            return say({ ...none, phase: 'travel', anchor: { ...to, z: zAt(to) }, ...(facing ? { facing } : {}), objective: 'stand off', reason: `closing in on ${tag(lead)}, ${Math.round(d)} away: the stalk stalled` });
        }
    }
    stepLeg(trip, 'stalk', goal, { from: centre, movers: main, replan: 800 });
    return say({ ...none, phase: 'travel', anchor: legAnchor(mem), ...(facing ? { facing } : {}), objective: `stalk ${seen.length} round (${Math.round(lead.x)}, ${Math.round(lead.y)})`, reason: `stalk ${tag(lead)}, ${Math.round(d)} away, ${crowd} together` });
}

/** A stalk this near the stand-off (rvr.ts LEG_REACHED) ... */
const STALK_STALL_BAND = 1200;
/** ... that got no closer by STALK_GAIN for STALK_STALL_MS closes in on a direct anchor. */
const STALK_STALL_MS = 10_000;
const STALK_GAIN = 150;

/** A fan-out step is this long at most (one turn, then it looks again). */
const FAN_LEG = 500;

/**
 * Where a caster in a fight steps to (pack.fanMin, fanGap), or null to stay: away from the nearest free enemy player
 * when it stands within fanMin, to fanMin + 300 from it; else sideways, away from a caster of ours within fanGap.
 * Never into water or within fanMin of another free enemy.
 */
export function fanOutStep(me: Point, foes: readonly Point[], mates: readonly Point[], k: Pick<PackOptions, 'fanMin' | 'fanGap'>, wet: (p: Point) => boolean = () => false): Point | null {
    if (!k.fanMin || !foes.length) return null;
    const near = [...foes].sort((a, b) => dist(a, me) - dist(b, me))[0]!;
    const d = dist(me, near);
    const ok = (p: Point) => !wet(p) && foes.every(f => f === near || dist(f, p) >= k.fanMin);
    const u = d >= 1 ? { x: (me.x - near.x) / d, y: (me.y - near.y) / d } : { x: 1, y: 0 };
    if (d < k.fanMin) {
        const back = Math.min(FAN_LEG, k.fanMin + 300 - d);
        // Straight away, else up to 60° off it.
        for (const off of [0, 0.5, -0.5, 1, -1]) {
            const c = Math.cos(off), s = Math.sin(off);
            const to = { x: Math.round(me.x + (u.x * c - u.y * s) * back), y: Math.round(me.y + (u.x * s + u.y * c) * back) };
            if (ok(to) && dist(near, to) > d) return to;
        }
        return null;
    }
    const mate = mates.filter(m => dist(m, me) < k.fanGap).sort((a, b) => dist(a, me) - dist(b, me))[0];
    if (!mate) return null;
    // Across the line to the enemy, on the side away from the mate.
    const side = (mate.x - me.x) * -u.y + (mate.y - me.y) * u.x > 0 ? -1 : 1;
    const step = k.fanGap - dist(mate, me) + 100;
    const to = { x: Math.round(me.x - u.y * side * step), y: Math.round(me.y + u.x * side * step) };
    return ok(to) && dist(near, to) >= k.fanMin ? to : null;
}

/** A healer keeps every member within this of it (heals reach 2000, Druid L24: Minor Restoration, Regrowth) ... */
export const HEAL_REACH = 1700;
/** ... and on its way to them stays this share of fanMin off every free enemy. */
const HEAL_FOE_SHARE = 0.7;

/**
 * Where a healer in a fight steps to keep the group in its heals' reach (user, 2026-11-09: spread round the enemy,
 * a Druid on one side can't heal the other), or null when every member is within HEAL_REACH: toward the members being
 * hit (`hit`), else toward all of them, FAN_LEG at most, up to 60° off the straight way to keep clear of the enemy.
 */
export function healerStep(me: Point, members: readonly Point[], hit: readonly Point[], foes: readonly Point[], k: Pick<PackOptions, 'fanMin'>, wet: (p: Point) => boolean = () => false): Point | null {
    if (!members.some(m => dist(m, me) > HEAL_REACH)) return null;
    const to = centroid(hit.length ? hit : members);
    const d = dist(me, to);
    if (d < 1) return null;
    const leg = Math.min(FAN_LEG, d);
    const base = Math.atan2(to.y - me.y, to.x - me.x);
    for (const off of [0, 0.5, -0.5, 1, -1]) {
        const p = { x: Math.round(me.x + Math.cos(base + off) * leg), y: Math.round(me.y + Math.sin(base + off) * leg) };
        if (!wet(p) && foes.every(f => dist(f, p) >= k.fanMin * HEAL_FOE_SHARE)) return p;
    }
    return null;
}

/**
 * Casters fan out in a fight (pack.fanMin): off the nearest free enemy and apart from each other, so one enemy
 * reaches one of them at a time and an area spell catches one. Between casts: a turn that moves casts nothing.
 * The healer first keeps everyone in its reach (healerStep), moving where the damage goes; it spreads from nobody.
 */
export const fanOut = (): Behavior<PackSettings> => ({
    name: 'fanOut',
    async run(ctx) {
        // A pack list run under other settings (a test's, or a strategy that borrows the lists) has no pack options.
        const k = ctx.settings.pack as PackOptions | undefined;
        if (!k?.fanMin || ctx.orders().phase !== 'engage') return false;
        const me = ctx.me();
        const now = Date.now();
        const foes = ctx.picture().contacts.filter(c => c.kind === 'player' && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && c.regionId === me.regionId);
        const wet = (p: Point) => isWet(me.regionId, p);
        const others = ctx.members().filter(m => m.name !== ctx.name && !m.isDead && m.regionId === me.regionId);
        if (ctx.role === 'healer') {
            const hit = others.filter(m => foes.some(f => f.target === m.name));
            const toThem = healerStep(me, others, hit, foes, k, wet);
            if (toThem) {
                ctx.doing('move', null, hit.length ? `toward ${hit.map(m => m.name).join(', ')}, in heal reach` : 'back in heal reach of the group');
                await ctx.bot.walkTo(toThem.x, toThem.y, { tolerance: 60, timeout: 3000 });
                return true;
            }
        }
        const mates = ctx.role === 'healer' ? [] : others.filter(m => m.role === 'nuker' || m.role === 'healer');
        const to = fanOutStep(me, foes, mates, k, wet);
        if (!to) return false;
        ctx.doing('move', null, 'fan out');
        await ctx.bot.walkTo(to.x, to.y, { tolerance: 60, timeout: 3000 });
        return true;
    },
});

/**
 * rvr-roam's lists without position(): nobody steps to keep a range from the focus, they cast or wait where they
 * stand. Support is the pack's crowd control: stop casts, mezz, heal only as a backup, then confuse.
 * fanOut (off unless pack.fanMin) goes before a nuker's assist and after a healer's heal.
 */
export function packBehaviors(): Record<Role, Behavior<RvrSettings>[]> {
    const lists = rvrBehaviors() as Record<Role, Behavior<RvrSettings>[]>;
    const out = Object.fromEntries(Object.entries(lists).map(([role, list]) => [role, list.filter(b => b.name !== 'position')])) as Record<Role, Behavior<RvrSettings>[]>;
    out.support = [release(), sprint(), retreat(), flee(), rez(), interrupt(), crowdControl(), backupHeal(), confuse(), song(), shedLoad(), holdFormation(), buff(), rest()] as Behavior<RvrSettings>[];
    const before = (list: Behavior<RvrSettings>[], name: string) => { const i = list.findIndex(b => b.name === name); return i < 0 ? list : [...list.slice(0, i), fanOut() as unknown as Behavior<RvrSettings>, ...list.slice(i)]; };
    out.nuker = before(out.nuker, 'assist');
    out.healer = before(out.healer, 'crowdControl');
    return out;
}

export const rvrPack: GroupStrategy<PackSettings> = {
    ...(rvrRoaming as unknown as GroupStrategy<PackSettings>),
    name: 'rvr-pack',
    description: 'Hit and run: stalk, stand off, mezz healers and far members, burst one target, pull back, kill who follows, leave. Nobody walks alone; a broken pack regroups at the keep.',
    settings: PACK_SETTINGS,
    behaviors: packBehaviors() as Record<Role, Behavior<PackSettings>[]>,
    decide: decidePack,
    findings: rvrFindings,
};
