// What the Bonedancer, Animist and Necromancer kits share: what a summon with a cast time waits for, and what a
// spell does when it is cast through a pet (a Necromancer's PetSpell, an Animist's turret or bomber).

import { getSpell, type SpellInfo } from '../../data/index';
import type { NearbyNpc, NearbyPlayer } from '../types';
import { ccHolds, foeInView, holdState, isDown, type TacticsSettings } from '../group/behaviors';
import { isAlive } from '../group/blackboard';
import { dist } from '../group/battleground';
import type { MemberContext } from '../group/member';
import type { SpellPick } from '../group/spells';
import { onMap } from '../group/terrain';
import type { Contact } from '../group/types';

/** A summon stands still for its cast: not with anything hostile or an enemy player this near (pets.ts summonPet's rule). */
export const SUMMON_CLEAR_RADIUS = 2500;
/** A pet comes up 64 ahead of its caster: it stands this far in from the map's edge (pets.ts). */
export const SUMMON_MAP_MARGIN = 100;

/** Anything hostile, or an enemy player, within `radius` of us in our region. */
export function hostileNear(ctx: Pick<MemberContext, 'me' | 'threats' | 'picture'>, radius = SUMMON_CLEAR_RADIUS): boolean {
    const me = ctx.me();
    const near = (c: Contact) => c.regionId === me.regionId && !c.stale && dist(c, me) < radius;
    return ctx.threats().some(near) || ctx.picture().contacts.some(c => c.kind === 'player' && !c.isPet && near(c));
}

/** Whether a summon with a cast time may go now: alive, not in a retreat, nothing hostile near, on the map. */
export function summonClear(ctx: Pick<MemberContext, 'me' | 'threats' | 'picture' | 'orders' | 'bot'>): boolean {
    const me = ctx.me();
    return !ctx.bot.isDead() && ctx.orders().phase !== 'retreat' && !hostileNear(ctx) && onMap(me.regionId, me, SUMMON_MAP_MARGIN);
}

/** The spell a pet casts for this one (a PetSpell's half, a turret's or bomber's shot), from the static data. */
export function subOf(info: Pick<SpellInfo, 'subSpellId'> | null | undefined): SpellInfo | undefined {
    return info?.subSpellId ? getSpell(info.subSpellId) : undefined;
}

/** A spell the member knows, with what it hands to its pet. */
export interface Through { pick: SpellPick; sub: SpellInfo | undefined }

/** The member's spells of `type` with their sub-spells. */
export function through(ctx: Pick<MemberContext, 'spells' | 'bot'>, type: string): Through[] {
    return ctx.spells.all().filter(p => p.type === type).map(pick => ({ pick, sub: subOf(ctx.bot.getSpellInfo(pick.spell)) }));
}

/** Sub-spell types that hurt their target. */
export const HARM_TYPES: ReadonlySet<string> = new Set(['DirectDamage', 'Lifedrain', 'DamageOverTime', 'DirectDamageWithDebuff', 'DamageSpeedDecrease', 'PowerDrainPet', 'Bolt']);

/** Whether a sub-spell hurts one enemy (not an area: that wakes a mezz beside it). */
export const hurtsOne = (sub: SpellInfo | undefined): boolean => !!sub && sub.target.toLowerCase() === 'enemy' && HARM_TYPES.has(sub.type) && sub.radius === 0;

/**
 * The orders' focus if our pet's or our own damage may go at it now: engaged, alive, in our region and view, not under crowd control,
 * and held by the tank for holdMs (an enemy player at once, as for assist). Null otherwise.
 */
export function focusToHit(ctx: MemberContext<TacticsSettings>): { mob: Contact; seen: NearbyNpc | NearbyPlayer } | null {
    const o = ctx.orders();
    const mob = ctx.focus();
    if (o.phase !== 'engage' || !mob || mob.stale || !isAlive(mob) || mob.regionId !== ctx.me().regionId || ccHolds(ctx, mob)) return null;
    const seen = foeInView(ctx, mob.objectId);
    if (!seen || isDown(ctx, seen)) return null;
    if (mob.kind !== 'player' && !holdState(mob, ctx.tank()?.name ?? null, ctx.settings.holdMs, ctx.settings.assistAfterMs, Date.now()).held) return null;
    return { mob, seen };
}

/** Memory timers: true while `key` is still waiting. */
export function waiting(memory: Map<string, any>, key: string, now = Date.now()): boolean {
    return now < (memory.get(key) ?? 0);
}
