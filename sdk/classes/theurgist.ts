// The standard Theurgist: a starting point a bot imports into bots/<bot>/character.ts and tunes. Its one
// direct nuke empties the pool every fight, so what is the class's own is stopping at a floor of power, and,
// with every cast he has 2.5-3 s long, casting nothing while a melee is on him: he gives ground instead.
// learnings/classes/theurgist.md says what that was worth, and what it costs.

import { onMember, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { dist } from '../group/battleground';
import type { Behavior } from '../group/member';
import type { Character } from '../group/character';
import type { Contact, MemberReport, Point } from '../group/types';
import { nukerFight } from './cabalist';

export interface TheurgistOptions {
    /** No nukes below this % power, nor his pets, which count as nukes (fnfPet). 40 is what was measured. */
    saveBelow?: number;
    /** Below the fight, as a group adds them. */
    chores?: Behavior<TacticsSettings>[];
    /** Its nukes on a free enemy in reach while the focus is out of it (cabalist.ts offFocus). On by default. */
    offFocus?: boolean;
    /** Give ground instead of casting while a melee is on him (giveGround). On by default. */
    giveGround?: boolean;
}

/** flee() runs to the tank until within this of him; giveGround keeps inside it, so the two don't pull him back and forth. */
const AT_HAVEN = 150;
/** How far from the haven he circles. */
export const HAVEN_ORBIT = 130;
/** A haven this far off is no haven: flee() gives the tank up there too. */
const HAVEN_FAR = 5000;
/** A spot this near where he stands is no step: turn a quarter round the haven instead. */
const MIN_STEP = 80;

type Who = Pick<MemberReport, 'name' | 'role' | 'isDead' | 'regionId' | 'x' | 'y'>;

/** Who he gives ground toward: the living tank, else the healer, in his region and within HAVEN_FAR. */
export function havenOf(me: Who, members: readonly Who[]): Who | null {
    const near = (m: Who) => m.name !== me.name && !m.isDead && m.regionId === me.regionId && dist(me, m) <= HAVEN_FAR;
    return members.find(m => m.role === 'tank' && near(m)) ?? members.find(m => m.role === 'healer' && near(m)) ?? null;
}

/**
 * Where to step with `attackers` on him: beside the haven on its far side from them (their centre), HAVEN_ORBIT out, so the melee has
 * to come round it and through the peel. Already there (they haven't moved), a quarter turn round the haven, the way away from them.
 */
export function giveGroundStep(me: Point, attackers: readonly Point[], haven: Point): Point {
    const c = { x: attackers.reduce((s, a) => s + a.x, 0) / attackers.length, y: attackers.reduce((s, a) => s + a.y, 0) / attackers.length };
    let ax = haven.x - c.x, ay = haven.y - c.y;
    const len = Math.hypot(ax, ay) || 1;
    ax /= len; ay /= len;
    const spot = { x: haven.x + ax * HAVEN_ORBIT, y: haven.y + ay * HAVEN_ORBIT };
    if (dist(me, spot) >= MIN_STEP) return spot;
    // A quarter turn: of the two, the one farther from the attackers' centre.
    const turns = [{ x: haven.x - ay * HAVEN_ORBIT, y: haven.y + ax * HAVEN_ORBIT }, { x: haven.x + ay * HAVEN_ORBIT, y: haven.y - ax * HAVEN_ORBIT }];
    return dist(turns[0]!, c) >= dist(turns[1]!, c) ? turns[0]! : turns[1]!;
}

/** The enemies in melee on him, as flee() reads them, a rooted one in reach included. */
export function meleeOn(me: Point & { name: string }, threats: readonly Contact[]): Contact[] {
    return threats.filter(t => !t.stale && (onMember(t, me) || (t.cc?.kind === 'root' && t.target === me.name && dist(t, me) <= 400)));
}

/**
 * A caster whose casts are all 2.5 s or more doesn't cast while a melee is on him: each is interrupted (a swing, a miss too,
 * starts a 3 s timer that ends a cast short of its half; SpellHandler.cs), and fnfPet's summon died with him (arena round 1).
 * Far from the haven flee() runs him there; beside it he keeps stepping round it, away from them, which takes the turn from
 * fnfPet and assist below. The peel is the group's: Nimue's stun and Merlin's mezz on the diver.
 */
export const giveGround = (): Behavior<TacticsSettings> => ({
    name: 'giveGround',
    async run(ctx) {
        if (ctx.isTank()) return false;
        const me = ctx.me();
        const on = meleeOn({ ...me, name: ctx.name }, ctx.threats());
        if (!on.length) return false;
        const haven = havenOf({ ...me, name: ctx.name, role: ctx.role, isDead: false }, ctx.members());
        if (!haven || (haven.role === 'tank' && dist(me, haven) > AT_HAVEN * 2)) return false;   // flee() runs him to the tank first
        const to = giveGroundStep(me, on, haven);
        await stopSwinging(ctx);
        ctx.doing('flee', on[0]!.objectId, `round ${haven.name}, away from ${on.map(t => t.name).join(', ')}`);
        const w = await ctx.bot.walkTo(to.x, to.y, { tolerance: 30, timeout: 2500 });
        if (!w.success && w.reason !== 'timeout') ctx.result('walk', w);
        return true;
    },
});

export function theurgist({ saveBelow = 40, chores = [], giveGround: give = true, offFocus: off = true }: TheurgistOptions = {}): Character {
    return {
        role: 'nuker',
        ...(give ? { react: [giveGround()] } : {}),
        fight: nukerFight(saveBelow, off),
        pet: { fnfFloor: saveBelow },
        ...(chores.length ? { chores } : {}),
    };
}
