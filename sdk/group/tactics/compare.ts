// Run two decides over the same generated board pictures and list where their orders differ. For a refactor (old
// and new must agree on every tick) and for step-2 comparisons (how often two variants of a tactic disagree, and on
// what) without a live round.
//
// A run is a sequence of pictures 500 ms apart around one spot. Each decide keeps its own orders (the last result
// merged in, as Blackboard.setOrders does) and its own memory, so clocks and holds play out as in a coordinator. The
// decides are built from an `inner` decide (the pack's or roaming's), which the run either takes as is or replaces with
// generated updates: random phases, foci, flips, crowd control and reasons that reach branches a real pack rarely does.

import { emptyOrders } from '../blackboard';
import type { CoordinatorContext } from '../strategy';
import type { Capabilities, Contact, GroupPicture, MemberReport, Orders, OrdersUpdate, Role } from '../types';

export type Decide<S = any> = (ctx: CoordinatorContext<S>) => OrdersUpdate;

/** A small seeded random source (mulberry32), so a failing run can be replayed by its seed. */
export function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        chance: (p: number) => next() < p,
        int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
        pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    };
}
type Rng = ReturnType<typeof rng>;

export interface RosterMember {
    name: string;
    role: Role;
    className: string;
    capabilities?: Partial<Capabilities>;
}

export interface BoardOptions {
    roster: readonly RosterMember[];
    regionId: number;
    origin: { x: number; y: number };
    ticks: number;
    /** Enemy players per run, at least and at most. */
    foes?: [number, number];
    /** An effect name the server's mezz spells carry (cc.ts isMezzEffect), put on members now and then. */
    mezzEffect?: string;
}

const ROLES = ['healer', 'caster', 'cc', 'tank', 'melee', 'support'] as const;
const RACES = ['Celt', 'Lurikeen', 'Firbolg', 'Troll', 'Dwarf', 'Norseman', 'Briton', 'Avalonian'];
const REASONS = ['raid: kill Celt#481', 'pick off #482 (straggler)', 'picking up Oisin', 'stalk', 'engage: their back line', 'go home to regroup', 'recover: waiting for power', 'kill: x'];

/** One run's pictures, 500 ms apart from `t0`, with the enemy moving, getting hurt, healed, controlled, switching targets. */
export function boards(r: Rng, o: BoardOptions, t0: number): GroupPicture[] {
    const [lo, hi] = o.foes ?? [2, 7];
    const n = r.int(lo, hi);
    const near = (spread: number) => ({ x: o.origin.x + r.int(-spread, spread), y: o.origin.y + r.int(-spread, spread) });
    const members: MemberReport[] = o.roster.map((m, i) => ({
        name: m.name, bot: m.name.toLowerCase(), role: m.role, className: m.className, level: 24, experience: 0,
        objectId: 100 + i, regionId: o.regionId, ...near(500), z: 0,
        hp: 100, mana: 100, endurance: 100, load: 10, isDead: false, isSitting: false, inCombat: false, attacking: false, targetId: null,
        effects: [], capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [], ...m.capabilities },
        activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, at: t0,
    }));
    const foes: Contact[] = [];
    for (let i = 0; i < n + r.int(0, 1); i++) {
        const pet = i >= n;
        foes.push({
            objectId: 480 + i, kind: pet ? 'npc' : 'player', name: pet ? 'spirit warrior' : r.pick(RACES), level: 24, realm: 'hibernia',
            ...near(2600), z: 0, hp: 100, targetId: null, inCombat: true, swinging: false, isPet: pet || undefined,
            regionId: o.regionId, target: null, targetSince: t0, engagedAt: 0, movedAt: 0, seenBy: [], firstSeen: t0, lastSeen: t0,
            stale: false, threat: true, hostileSince: t0, cc: null,
        } as Contact);
    }
    const out: GroupPicture[] = [];
    for (let k = 0; k < o.ticks; k++) {
        const now = t0 + k * 500;
        for (const m of members) {
            if (r.chance(0.3)) { m.x += r.int(-200, 200); m.y += r.int(-200, 200); }
            if (r.chance(0.2)) m.hp = r.pick([100, 90, 60, 30, 10]);
            if (r.chance(0.2)) m.mana = r.pick([100, 70, 40, 10]);
            if (r.chance(0.03)) m.isDead = !m.isDead;
            if (r.chance(0.1)) m.inCombat = !m.inCombat;
            if (r.chance(0.04)) m.regionId = m.regionId === o.regionId ? o.regionId + 1 : o.regionId;
            if (r.chance(0.08)) m.effects = r.chance(0.5) && o.mezzEffect ? [o.mezzEffect] : [];
        }
        for (const c of foes) {
            if (r.chance(0.5)) { c.x += r.int(-250, 250); c.y += r.int(-250, 250); }
            if (r.chance(0.15)) Object.assign(c, near(r.chance(0.3) ? 1200 : 3200));
            if (r.chance(0.25)) c.hp = r.pick([100, 95, 80, 60, 45, 35, 30, 25, 20, 10, 0]);
            if (r.chance(0.1)) c.stale = r.chance(0.3);
            if (r.chance(0.12)) c.cc = r.chance(0.5) ? { by: r.pick(o.roster).name, kind: r.pick(['mezz', 'root', 'stun']), until: now + 20_000 } : null;
            if (r.chance(0.25)) {
                const on = r.chance(0.6) ? r.pick(members).name : null;
                if (on !== c.target) c.targetSince = now - r.int(0, 2500);
                c.target = on;
                c.targetBySpell = on ? r.chance(0.35) : undefined;
            }
            if (r.chance(0.2)) c.castingAt = now - r.int(0, 9000);
            if (r.chance(0.08)) c.healer = r.chance(0.6);
            if (r.chance(0.08)) c.caster = r.chance(0.6);
            if (r.chance(0.1)) c.classGuess = r.chance(0.8) ? { classes: ['X'], p: [0.8], role: r.pick(ROLES), basis: [] } : undefined;
            if (r.chance(0.05)) c.ccImmune = r.chance(0.6) ? { mezz: now + r.int(-5000, 30_000) } : undefined;
            if (r.chance(0.02)) c.isShade = !c.isShade || undefined;
            if (r.chance(0.02)) c.unattackableUntil = now + r.int(-2000, 8000);
            if (r.chance(0.03)) c.regionId = c.regionId === o.regionId ? o.regionId + 1 : o.regionId;
            c.lastSeen = now;
        }
        out.push({
            at: now,
            members: members.map(m => ({ ...m, effects: [...m.effects], capabilities: { ...m.capabilities }, at: now })),
            contacts: foes.map(c => ({ ...c, cc: c.cc && { ...c.cc }, classGuess: c.classGuess && { ...c.classGuess }, ccImmune: c.ccImmune && { ...c.ccImmune } })),
            orders: emptyOrders(t0),
        });
    }
    return out;
}

/** Stand-ins for the inner decide's result on each picture: engage most of the time, a focus that flips now and then. */
export function innerUpdates(r: Rng, pictures: readonly GroupPicture[]): OrdersUpdate[] {
    let focus: number | null = null;
    return pictures.map(p => {
        const ids = p.contacts.map(c => c.objectId);
        if (focus === null || r.chance(0.3)) focus = r.chance(0.05) ? null : r.pick(ids);
        const phase = r.chance(0.75) ? 'engage' : r.pick(['recover', 'travel', 'idle', 'retreat'] as const);
        const target = p.contacts.find(c => c.objectId === focus);
        const cc = Array.from({ length: r.int(0, 2) }, () => ({ targetId: r.pick(ids), by: r.pick(p.members).name }));
        const reason = r.pick(REASONS);
        return {
            phase, focus: phase === 'engage' ? focus : r.chance(0.5) ? null : focus, cc,
            anchor: r.chance(0.1) ? null : target ? { x: target.x + r.int(-300, 300), y: target.y + r.int(-300, 300), z: 0 } : { x: p.members[0]!.x, y: p.members[0]!.y, z: 0 },
            facing: target ? { x: target.x, y: target.y } : null,
            reason, objective: reason === 'go home to regroup' ? 'go home to regroup' : 'fight',
            ...(r.chance(0.1) ? { waiting: [{ name: r.pick(p.members).name, why: r.pick(['pickup', 'health', 'dead']) }] } : {}),
        } satisfies OrdersUpdate;
    });
}

/** Keys sorted, undefined properties dropped: two updates that would merge into the same orders print the same. */
export function canonical(v: unknown): string {
    return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
}

export interface Difference { seed: number; tick: number; a: OrdersUpdate; b: OrdersUpdate }

export interface CompareOptions<S> extends Omit<BoardOptions, 'ticks'> {
    /** Each decide, built around an inner decide. */
    a: (inner: Decide<S>) => Decide<S>;
    b: (inner: Decide<S>) => Decide<S>;
    settings: S;
    seeds: readonly number[];
    ticks?: number;
    /** The real inner decide: runs with it as well as with generated updates. */
    inner?: Decide<S>;
    /** Memory both decides start a run with (copied for each), e.g. a pack already in a raid. */
    memory?: (r: Rng, t0: number, pictures: readonly GroupPicture[]) => Record<string, any>;
}

/**
 * Every seed is one run with generated updates as the inner decide, and one more with `inner` when given. Returns
 * the number of ticks compared and the first difference of each run.
 */
export function compareDecides<S>(o: CompareOptions<S>): { ticks: number; differences: Difference[] } {
    const differences: Difference[] = [];
    let ticks = 0;
    const t0 = Date.now();
    for (const seed of o.seeds) {
        const r = rng(seed);
        const pictures = boards(r, { ...o, ticks: o.ticks ?? 40 }, t0);
        const stub = innerUpdates(r, pictures);
        const memory = o.memory?.(r, t0, pictures) ?? {};
        const inners: Decide<S>[] = [(ctx: CoordinatorContext<S>) => structuredClone(stub[(ctx.now - t0) / 500]!)];
        if (o.inner) inners.push(o.inner);
        for (const inner of inners) {
            const side = (make: (i: Decide<S>) => Decide<S>) => ({ decide: make(inner), orders: emptyOrders(t0) as Orders, memory: structuredClone(memory) });
            const A = side(o.a), B = side(o.b);
            for (let k = 0; k < pictures.length; k++) {
                const p = pictures[k]!;
                const run = (s: typeof A) => {
                    const picture = structuredClone({ ...p, orders: s.orders });
                    const u = s.decide({ picture, orders: picture.orders, memory: s.memory, settings: o.settings, now: p.at, windingDown: false });
                    s.orders = { ...s.orders, ...structuredClone(u) };
                    return u;
                };
                const ua = run(A), ub = run(B);
                ticks++;
                if (canonical(ua) !== canonical(ub)) { differences.push({ seed, tick: k, a: ua, b: ub }); break; }
            }
        }
    }
    return { ticks, differences };
}
