// The standard Animist: a starting point a bot imports into bots/<bot>/character.ts and tunes. Its pets are turrets: they
// stand where they are put, on a ground target within 1000 of us, and shoot what is within 1000 of them. The group's pet
// behaviours leave a turret alone (pets.ts petControl, knowsTurret), so this kit plants and orders them itself:
//  - plantTurret: the main turret (a window pet: Forest's for Arboreal, Grove's for Creeping, Battle for Verdant) on a spot
//    between us and the focus, from where it reaches the focus; planted again when the fight has left it behind, and sent at
//    each new focus.
//  - fnfTurret: in a long fight (an enemy player, power to spare), a fire-and-forget turret that hurts, near the focus.
//  - bomb: a bomber at the focus ahead of the lifedrain: Spirit of Wrath hits 102 against Enemy's Debt's 80, for the same 13.
// The rest is the nuker's: assist's lifedrain, giving ground under a melee (theurgist.ts), Quickcast under fire.
// learnings/classes/animist.md has the runs.

import { ccHolds, foeInView, hammeredBy, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { dist } from '../group/battleground';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import type { Point } from '../group/types';
import { nukerFight, quickcastUnderFire } from './cabalist';
import { focusToHit, hurtsOne, SUMMON_MAP_MARGIN, through, waiting, type Through } from './summoner';
import { giveGround } from './theurgist';
import { onMap } from '../group/terrain';

export interface AnimistOptions {
    /** No nukes, bombers or fire-and-forget turrets below this % power; the main turret goes at any. 0 (the default): no floor. */
    saveBelow?: number;
    /** fnfTurret: a damage turret near the focus in a long fight. On by default. */
    fnf?: boolean;
    /** bomb: bombers at the focus ahead of the lifedrain. On by default. */
    bombers?: boolean;
}

/** A turret's reach and its summon's: 1000 for every Animist turret (spell.sql). */
export const TURRET_REACH = 1000;
/** Kept inside the reach: the focus moves, and the server measures in 3D. */
export const REACH_MARGIN = 200;
/** And inside the summon's range: the server moves a spot to the nearest walkable ground, then measures (summonPet). */
export const SUMMON_MARGIN = 80;
/** A focus out of the turret's reach this long: plant it again. */
export const LEFT_BEHIND_MS = 3000;
/** No new plant within this of the last. */
const PLANT_RETRY_MS = 8000;
/** The same attack order no sooner than this. */
const ORDER_MS = 3000;
/** At most this many fire-and-forget turrets of ours at once (they cost 31-35 each and last 120 s). */
export const FNF_UP = 2;
/** fnfTurret only with this % power or more. */
export const FNF_MANA = 50;
/** No fnf turret within this of the last. */
const FNF_RETRY_MS = 10_000;
/** Bombers only with our health above this: below, the lifedrain heals. */
export const BOMB_ABOVE_HP = 50;

/**
 * Where a turret goes to reach `focus`: on the line from us to it, as near us as reaches it (so it stands behind our line, not
 * among them), but at least 100 out. Null when no spot within the summon's range reaches it.
 */
export function turretSpot(me: Point, focus: Point, range = TURRET_REACH, reach = TURRET_REACH): Point | null {
    const d = dist(me, focus);
    const out = Math.max(d - (reach - REACH_MARGIN), Math.min(100, d / 2));
    if (out > range - SUMMON_MARGIN) return null;
    if (d === 0) return { x: me.x, y: me.y };
    const f = out / d;
    return { x: me.x + (focus.x - me.x) * f, y: me.y + (focus.y - me.y) * f };
}

/** The main turret summon: the top level. */
export function turretPick(known: readonly Through[]): Through | null {
    return [...known].sort((a, b) => b.pick.spell.level - a.pick.spell.level)[0] ?? null;
}

/** A fire-and-forget turret that hurts one enemy (not a vent, tangler or debuffer), the hardest hit. */
export function fnfPick(known: readonly Through[]): Through | null {
    return known.filter(k => hurtsOne(k.sub)).sort((a, b) => (b.sub!.damage - a.sub!.damage) || b.pick.spell.level - a.pick.spell.level)[0] ?? null;
}

/** A bomber that hurts one enemy (not a heal, shield or area root), the hardest hit. */
export function bomberPick(known: readonly Through[]): Through | null {
    return known.filter(k => k.pick.target === 'Enemy' && hurtsOne(k.sub)).sort((a, b) => (b.sub!.damage - a.sub!.damage) || b.pick.spell.level - a.pick.spell.level)[0] ?? null;
}

/**
 * The turret against the focus: `reach` it can shoot it, `wait` it is out of its reach for less than LEFT_BEHIND_MS (no order, which the server
 * refuses: "Briton is 1772 from it, beyond its 1000", 6 in sortie 2), `plant` none is up or the focus has been out of its reach that long.
 */
export function turretState(turret: Point | null, focus: Point, outSince: number | undefined, now: number): 'reach' | 'wait' | 'plant' {
    if (!turret) return 'plant';
    if (dist(turret, focus) <= TURRET_REACH - REACH_MARGIN / 2) return 'reach';
    return now - (outSince ?? now) >= LEFT_BEHIND_MS ? 'plant' : 'wait';
}

function turretLeftBehind(ctx: MemberContext, turret: Point | null, focus: Point, now: number): 'reach' | 'wait' | 'plant' {
    const state = turretState(turret, focus, ctx.memory.get('turretOutSince'), now);
    if (state === 'reach' || !turret) ctx.memory.delete('turretOutSince');
    else if (!ctx.memory.has('turretOutSince')) ctx.memory.set('turretOutSince', now);
    return state;
}

/** The power a summon costs at worst: a flat cost, 1.2 x with no focus item (Spellbook.powerOf). */
const affords = (ctx: MemberContext, t: Through) => ctx.me().mana >= ctx.spells.powerOf(t.pick);

/**
 * The main turret on the focus. Up and in reach: sent at the focus once, the turn going on (an order takes about 50 ms). Not up,
 * or the focus out of its reach for LEFT_BEHIND_MS: planted on turretSpot with `replace`, then sent. With the focus under crowd
 * control it is called off (passive stops a turret within a shot). Sets the ground target in the same turn.
 */
export const plantTurret = (): Behavior<TacticsSettings> => ({
    name: 'plantTurret',
    interruptible: false,
    async run(ctx) {
        const petState = ctx.sdk.getPetState();
        const focus = ctx.focus();
        if (petState && focus && ccHolds(ctx, focus) && petState.targetObjectId === focus.objectId && petState.aggression !== 'passive') {
            await ctx.sdk.sendPetCommand('passive');
            return false;
        }
        const go = focusToHit(ctx);
        if (!go) return false;
        const now = Date.now();
        const turret = petState ? ctx.sdk.getPet() : null;
        const state = turretLeftBehind(ctx, turret ?? null, go.seen, now);
        if (state === 'wait') return false;
        if (state === 'reach') {
            if (petState && petState.targetObjectId !== go.mob.objectId && !(ctx.memory.get('turretOrder') === go.mob.objectId && waiting(ctx.memory, 'turretOrderAt', now - ORDER_MS))) {
                ctx.memory.set('turretOrder', go.mob.objectId);
                ctx.memory.set('turretOrderAt', now);
                const r = await ctx.bot.petAttack(go.mob.objectId);
                if (!r.success) ctx.result('petAttack', r, go.mob.objectId);
            }
            return false;
        }
        if (waiting(ctx.memory, 'plantRetry', now)) return false;
        const t = turretPick(through(ctx, 'SummonAnimistPet'));
        if (!t || t.pick.spell.cooldownRemaining > 0 || !affords(ctx, t)) return false;
        const me = ctx.me();
        const spot = turretSpot(me, go.seen, t.pick.range || TURRET_REACH);
        if (!spot || !onMap(me.regionId, spot, SUMMON_MAP_MARGIN)) return false;
        await stopSwinging(ctx);
        ctx.memory.set('plantRetry', now + PLANT_RETRY_MS);
        ctx.doing('summon', go.mob.objectId, `${t.pick.spell.name} toward ${go.mob.name}`);
        const c = await ctx.bot.summonPet(t.pick.spell, { groundTarget: spot, replace: true });
        ctx.result('summon', c, go.mob.objectId);
        if (c.success) {
            ctx.memory.delete('turretOutSince');
            ctx.memory.set('turretOrder', go.mob.objectId);
            ctx.memory.set('turretOrderAt', Date.now());
            const r = await ctx.bot.petAttack(go.mob.objectId);
            if (!r.success) ctx.result('petAttack', r, go.mob.objectId);
        }
        return true;
    },
});

/** A fire-and-forget damage turret near the focus, in a long fight: an enemy player, FNF_MANA, fewer than FNF_UP of ours up. They pick their own targets. */
export const fnfTurret = (floor = 0): Behavior<TacticsSettings> => ({
    name: 'fnfTurret',
    interruptible: false,
    async run(ctx) {
        const go = focusToHit(ctx);
        if (!go || go.mob.kind !== 'player' || hammeredBy(ctx)) return false;
        const now = Date.now();
        if (waiting(ctx.memory, 'fnfRetry', now)) return false;
        const me = ctx.me();
        if (me.manaPercent < Math.max(FNF_MANA, floor) || (ctx.sdk.getState()?.summons?.length ?? 0) >= FNF_UP) return false;
        const t = fnfPick(through(ctx, 'SummonAnimistFnF'));
        if (!t || t.pick.spell.cooldownRemaining > 0 || !affords(ctx, t)) return false;
        const spot = turretSpot(me, go.seen, t.pick.range || TURRET_REACH, t.sub?.range || TURRET_REACH);
        if (!spot || !onMap(me.regionId, spot, SUMMON_MAP_MARGIN)) return false;
        await stopSwinging(ctx);
        ctx.memory.set('fnfRetry', now + FNF_RETRY_MS);
        ctx.doing('summon', go.mob.objectId, `${t.pick.spell.name} toward ${go.mob.name}`);
        const c = await ctx.bot.summonPet(t.pick.spell, { groundTarget: spot });
        ctx.result('summon', c, go.mob.objectId);
        return true;
    },
});

/** A bomber at the focus, ahead of the lifedrain, while we are above BOMB_ABOVE_HP and not under a melee. Counts as a nuke. */
export const bomb = (floor = 0): Behavior<TacticsSettings> => ({
    name: 'bomb',
    interruptible: false,
    async run(ctx) {
        const go = focusToHit(ctx);
        if (!go || hammeredBy(ctx)) return false;
        const me = ctx.me();
        if (me.healthPercent <= BOMB_ABOVE_HP || (floor > 0 && me.manaPercent < floor) || waiting(ctx.memory, 'bombRetry')) return false;
        const t = bomberPick(through(ctx, 'Bomber'));
        if (!t || t.pick.spell.cooldownRemaining > 0 || !affords(ctx, t)) return false;
        const seen = foeInView(ctx, go.mob.objectId);
        if (!seen || seen.distance > t.pick.range - 50) return false;
        await stopSwinging(ctx);
        ctx.doing('nuke', go.mob.objectId, t.pick.spell.name);
        const c = await ctx.bot.summonPet(t.pick.spell, { target: go.mob.objectId });
        ctx.result('nuke', c, go.mob.objectId);
        if (!c.success) ctx.memory.set('bombRetry', Date.now() + Math.max(c.retryAfterMs ?? 0, 3000));
        return true;
    },
});

export function animist({ saveBelow = 0, fnf = true, bombers = true }: AnimistOptions = {}): Character {
    return {
        role: 'nuker',
        instant: [quickcastUnderFire()],
        react: [giveGround()],
        fight: [plantTurret(), ...(fnf ? [fnfTurret(saveBelow)] : []), ...(bombers ? [bomb(saveBelow)] : []), ...nukerFight(saveBelow, true)],
    };
}
