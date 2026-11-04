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
import { backupHeal, confuse, crowdControl, flee, interrupt, rest, rez, release, retreat, shedLoad, song, sprint, holdFormation, buff } from './behaviors';
import { isAlive } from './blackboard';
import { immuneKinds } from './cc';
import { assignCc } from './pve';
import { decideRvr, focusHealed, groupRegion, homeOf, keepDangers, mainBody, pickPackFocus, realmOfGroup, runWay, rvrBehaviors, rvrFindings, rvrRoaming, RVR_SETTINGS, spotAlong, stepLeg, type RvrSettings, type Trip } from './rvr';
import type { CoordinatorContext, GroupStrategy } from './strategy';
import { clearOf } from './keeps';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3, Role } from './types';

export { focusHealed, pickPackFocus } from './rvr';

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
}

export interface PackSettings extends RvrSettings {
    pack: PackOptions;
}

export const PACK_OPTIONS: PackOptions = {
    standoff: 1500, reach: 1500, openAt: 1450, idleMs: 3000, waitMs: 0, minPack: 3, minTogether: 3,
    // User, live: fights may be joined head on, the first version avoided all of them. Only a real crowd is refused.
    maxFoes: 8, crowdRadius: 1000, raidReady: { hp: 50, mana: 25 }, restClear: 2500,
    raidMs: 8000, finishMs: 4000, finishHp: 25, closeCount: 3, closeIn: 700,
    pullBack: 1500, pullMs: 6000, maxChasers: 2, chaseGap: 800, maxLegs: 0, killMs: 12_000, preyHp: 40, healedBy: 30, droppedMs: 15_000,
    leave: 2000, cooldownMs: 0,
    rebuffMs: 20_000, rebuffReady: { hp: 90, mana: 80 }, keepRadius: 2500,
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
    rez: { holdMs: 20_000, radius: 2000, sit: false, reserve: 25, inFight: false },
    pack: PACK_OPTIONS,
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: readonly Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc;
const soft = (m: MemberReport) => m.role === 'healer' || m.role === 'support' || m.role === 'nuker';
const tag = (c: Contact) => `${c.name}#${c.objectId} (${c.hp}%${c.healer ? ' healer' : c.caster ? ' caster' : ''})`;

/**
 * Who gets mezzed, by whom; nothing but a mezz may hit a mezzed enemy, and two never go on one. The Bard takes the biggest cluster an area mezz would catch without the focus, else a
 * known healer, else the farthest: the near ones are about to be fought. A nuker's mezz costs a nuke, so it goes on
 * healers only. `roots` adds members with only a root (the Druid), for chasers: a root on a raid's target breaks at
 * the first hit and keeps her from healing.
 */
export function packCc(foes: readonly Contact[], members: readonly MemberReport[], current: readonly { targetId: number; by: string }[], o: { centre: Point; focus: Contact | null; areaRadius: number; roots?: boolean; now: number }): { targetId: number; by: string }[] {
    const pool = foes.filter(c => c.objectId !== o.focus?.objectId && !c.cc);
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

export function decidePack(ctx: CoordinatorContext<PackSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    const k = s.pack;
    const players = (c: Contact) => c.kind === 'player';
    // rvr-roam with no enemy players on the board: patrol, rest, regroup, monsters that attack us, winding down.
    const calm = () => decideRvr({ ...ctx, picture: { ...p, contacts: p.contacts.filter(c => !players(c)) } });
    const alive = p.members.filter(m => !m.isDead);
    if (!alive.length) { mem.pack = 'home'; return calm(); }
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
    const trip: Trip = { mem, now, regionId, level, avoid: keeps, travelLeg: s.travelLeg, zAt };
    const ours = new Set(p.members.map(m => m.name));
    const onUs = (c: Contact) => c.target !== null && ours.has(c.target);
    const attacked = new Set(p.contacts.filter(c => !c.stale && isAlive(c) && onUs(c)).map(c => c.target!));
    const { main, far } = mainBody(here, s.gatherRadius, mem, attacked);
    const centre = centroid(main);
    const foes = p.contacts.filter(c => players(c) && !c.stale && isAlive(c) && c.regionId === regionId && (onUs(c) || !inKeep(c)));
    const free = foes.filter(c => !c.cc).sort((a, b) => dist(a, centre) - dist(b, centre));
    const stay: Point3 = { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) };
    const facing = free[0] ? { x: free[0].x, y: free[0].y } : undefined;
    // Released members at the keep stay put until the pack is within gatherRadius of them (they are in `main` then).
    const pickups = homeSpot ? far.filter(m => dist(m, homeSpot) <= k.keepRadius) : [];
    const pickupWait = pickups.map(m => ({ name: m.name, why: 'pickup' }));
    const dead = p.members.filter(m => m.isDead && m.regionId === regionId);
    const none = { focus: null, puller: null, cc: [], retreatTo: null };
    const say = (u: OrdersUpdate): OrdersUpdate => ({ ...u, waiting: [...(u.waiting ?? []).filter(w => w.why !== 'pickup'), ...pickupWait] });
    const areaRadius = 350;

    // Chasers are the Hero's: the anchor stands on the focus, so his leash lets him at it (never into a keep's circle).
    const onFocus = (c: Contact | null): Point3 => {
        if (!c || inKeep(c)) return stay;
        const x = Math.round(c.x / 200) * 200, y = Math.round(c.y / 200) * 200;
        return { x, y, z: zAt({ x, y }) };
    };
    // The focus stays, unless it is out of reach or a healer is winning: then the next one, and that target rests a while.
    const keepFocus = (pool: readonly Contact[]): Contact | null => {
        mem.lowHp ??= {};
        mem.dropped ??= {};
        for (const [id, until] of Object.entries(mem.dropped) as [string, number][]) if (until <= now) { delete mem.dropped[id]; delete mem.lowHp[id]; }
        const held = pool.find(c => c.objectId === o.focus);
        if (held && focusHealed(mem.lowHp, held, k.healedBy)) mem.dropped[held.objectId] = now + k.droppedMs;
        const fresh = pool.filter(c => !mem.dropped[c.objectId]);
        return fresh.find(c => c.objectId === o.focus) ?? pickPackFocus(fresh.length ? fresh : pool, centre, k.reach);
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
        return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'leave and rest', reason: `leave: ${why}` });
    };
    const fight = (kind: string, focus: Contact | null, cc: { targetId: number; by: string }[], anchor: Point3, why: string): OrdersUpdate =>
        say({ phase: 'engage', puller: null, retreatTo: null, focus: focus?.objectId ?? null, cc, anchor, ...(focus ? { facing: { x: focus.x, y: focus.y } } : {}), objective: `${kind} at (${anchor.x}, ${anchor.y})`, reason: `${kind}: ${focus ? tag(focus) : 'no target in reach'}, ${why}` });
    const startRaid = (why: string): OrdersUpdate => {
        mem.pack = 'raid';
        mem.raidAt = now;
        mem.raids = (mem.raids ?? 0) + 1;
        mem.packAnchor = stay;
        mem.holdSince = undefined;
        const focus = pickPackFocus(free.filter(c => dist(c, centre) <= k.reach), centre, k.reach);
        return fight('raid', focus, packCc(free.filter(c => dist(c, centre) <= k.reach), main, [], { centre, focus, areaRadius, now }), onFocus(focus), why);
    };

    // Broken: too few alive. A scattered pack isn't: the others walk back to the anchor of its largest cluster.
    if (mem.pack !== 'home' && mem.pack !== 'rebuff' && here.length < k.minTogether) { mem.pack = 'home'; mem.legKind = null; if (dead.length) mem.hadDead = true; }
    // A run that starts at the keep starts together and buffed.
    if (!mem.pack && homeSpot && dist(centre, homeSpot) <= k.keepRadius) { mem.pack = 'rebuff'; mem.rebuffAt = now; }
    mem.pack ??= 'stalk';

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
            return fight('raid', focus, packCc(reachable, main, o.cc, { centre, focus, areaRadius, now }), focus ? onFocus(focus) : anchor, `${free.length} free of ${foes.length} vs ${main.length}`);
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
        const focus = pickPackFocus(following, centre, k.reach);
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
            return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'leave and rest', reason: 'leave: moving off' });
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
        else if (!far.length && !dead.length && main.length >= Math.min(k.minTogether, here.length)) {
            if (mem.hadDead) { mem.pack = 'rebuff'; mem.rebuffAt = now; mem.hadDead = false; } else mem.pack = 'stalk';
        } else if (homeSpot && dist(centre, homeSpot) > 1000) {
            // Toward the keep, in legs everyone follows: a scattered pack comes together on the way, and stops as soon as it has.
            if (dead.length) mem.hadDead = true;
            stepLeg(trip, 'home', homeSpot, { from: centre, movers: main, replan: Infinity });
            return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'go home to regroup', reason: pickups.length ? `picking up ${pickups.map(m => m.name).join(', ')}` : `regrouping: ${main.length} together of ${here.length}` });
        } else {
            if (dead.length) mem.hadDead = true;
            return say({ ...calm(), phase: 'recover', anchor: stay, reason: 'regrouping: waiting for the others' });
        }
    }

    if (mem.pack === 'rebuff') {
        if (free.some(c => dist(c, centre) <= k.standoff)) mem.pack = 'stalk';
        else {
            if (pickups.length || far.length || dead.length) { mem.pack = 'home'; mem.legKind = null; return say({ ...none, phase: 'recover', anchor: stay, reason: 'regrouping: someone is missing again' }); }
            const low = here.flatMap(m => [
                ...(m.hp < k.rebuffReady.hp ? [{ name: m.name, why: 'health' }] : []),
                ...(usesMana(m) && m.mana < k.rebuffReady.mana ? [{ name: m.name, why: 'power' }] : []),
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
    if (pickups.length && !free.some(c => dist(c, centre) <= k.standoff)) { mem.pack = 'home'; mem.legKind = null; stepLeg(trip, 'home', homeSpot!, { from: centre, movers: main, replan: Infinity }); return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'pick up the released', reason: `picking up ${pickups.map(m => m.name).join(', ')}` }); }
    const seen = free.filter(c => dist(c, centre) <= s.huntRadius);
    if (!seen.length) { mem.holdSince = undefined; return say(calm()); }
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
    if (mustRest) mem.resting = true;
    if (mem.resting && !main.some(m => m.hp < s.ready.hp || (usesMana(m) && m.mana < s.ready.mana))) mem.resting = false;
    if (mem.resting) {
        const who = main.filter(m => m.hp < s.ready.hp || (usesMana(m) && m.mana < s.ready.mana));
        if (onUsNow || d <= k.reach) return startLeave(`${who.map(m => m.name).join(', ')} resting, and they are on us`);
        // Moving off goes on until well clear: at one line it flipped every second (s6).
        if (d <= k.restClear + (mem.movingOff ? 800 : 0)) {
            mem.movingOff = true;
            const goal = spotAlong(trip, centre, runWay(centre, seen, homeSpot), s.huntRadius);
            stepLeg(trip, 'avoid', goal, { from: centre, movers: main, replan: 2000 });
            return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'keep away while resting', reason: `resting: ${who.map(m => m.name).join(', ')}, moving off (nearest ${Math.round(d)} away)` });
        }
        mem.movingOff = false;
        return say({ ...none, phase: 'recover', anchor: stay, objective: 'rest', waiting: who.map(m => ({ name: m.name, why: 'power' })), reason: `resting: ${who.map(m => m.name).join(', ')} (nearest enemy ${Math.round(d)} away)` });
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
            const focus = pickPackFocus(seen, centre, k.reach);
            return fight('kill', focus, packCc(seen, main, [], { centre, focus, areaRadius, roots: true, now }), onFocus(focus), `${inSight.length} in sight vs ${main.length}`);
        }
        stepLeg(trip, 'prey', lead, { from: centre, movers: main, replan: 500 });
        return say({ ...none, phase: 'travel', anchor: mem.leg, facing: { x: lead.x, y: lead.y }, objective: `hunt ${inSight.length} stragglers`, reason: `hunt ${tag(lead)}, ${Math.round(d)} away, ${inSight.length} in sight vs ${main.length}` });
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
        return say({ ...none, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, objective: 'keep away', reason: `refuse: ${refuse} (${seen.length} seen, nearest ${Math.round(d)} away)` });
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
    stepLeg(trip, 'stalk', goal, { from: centre, movers: main, replan: 800 });
    return say({ ...none, phase: 'travel', anchor: mem.leg, ...(facing ? { facing } : {}), objective: `stalk ${seen.length} round (${Math.round(lead.x)}, ${Math.round(lead.y)})`, reason: `stalk ${tag(lead)}, ${Math.round(d)} away, ${crowd} together` });
}

/**
 * rvr-roam's lists without position(): nobody steps to keep a range from the focus, they cast or wait where they
 * stand. Support is the pack's crowd control: stop casts, mezz, heal only as a backup, then confuse.
 */
export function packBehaviors(): Record<Role, Behavior<RvrSettings>[]> {
    const lists = rvrBehaviors() as Record<Role, Behavior<RvrSettings>[]>;
    const out = Object.fromEntries(Object.entries(lists).map(([role, list]) => [role, list.filter(b => b.name !== 'position')])) as Record<Role, Behavior<RvrSettings>[]>;
    out.support = [release(), sprint(), retreat(), flee(), rez(), interrupt(), crowdControl(), backupHeal(), confuse(), song(), shedLoad(), holdFormation(), buff(), rest()] as Behavior<RvrSettings>[];
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
