// A point-blank area bomb (range 0, centred on the caster): the Mana Enchanter's Disenchanting Emission (Mana 20: 133,
// radius 300, 2.5 s, 12 power) and the Ice Wizard's Steaming Blast (Cold 24: 133, radius 300). The role lists never cast one:
// pickNuke wants range above 0. `pbae` does, when enemies stand on her: in a fight, MIN_FOES or more enemy players or
// their pets within the radius (less a margin), none of them nor anything else in the radius under our crowd control
// (the bomb would wake it), and no melee swinging at her (a swing ends a 2.5 s cast half way). From any stand: the
// keep's gate inside and its stair (milestone 5, groups/stint-lives-on-its-own.md), or the field when a dive reaches her.
// learnings/classes/enchanter.md "The bomb".

import { hammeredBy, stopSwinging, type TacticsSettings } from '../group/behaviors';
import type { Behavior, MemberContext } from '../group/member';
import type { SpellPick } from '../group/spells';

/** Enemies it takes to be worth a bomb's 2.5 s: one is a nuke's job. */
export const MIN_FOES = 2;
/** A rank weaker than this isn't worth the 2.5 s: a Light Enchanter's Minor Disenchanting Emanation (52, Mana 9) against his 140 nuke. */
export const MIN_DAMAGE = 100;
/** The server measures 3D at the cast's end, from where it last had both: a margin inside the radius. */
const RADIUS_MARGIN = 60;
/** Crowd control this far outside the radius still counts: a mezzed enemy can be pushed, and positions are a moment old. */
const CC_MARGIN = 80;

/** The top rank of a point-blank damage spell we can cast now. */
export function pbaeSpell(all: readonly SpellPick[], mana = Infinity, minDamage = MIN_DAMAGE): SpellPick | null {
    return all.filter(s => s.target === 'Enemy' && s.range === 0 && s.radius > 0 && s.type === 'DirectDamage' && s.damage >= minDamage && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;
}

export interface Near { id: number; x: number; y: number; z: number }

/** Whether a bomb of `radius` from `me` is worth it: `min` foes inside it, no held one near it. Null when it is; else why not. */
export function bombVerdict(me: { x: number; y: number; z: number }, foes: readonly Near[], held: readonly Near[], radius: number, min = MIN_FOES): { hit: number } | { none: 'few' | 'cc' } {
    const d = (p: Near) => Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
    if (held.some(p => d(p) <= radius + CC_MARGIN)) return { none: 'cc' };
    const hit = foes.filter(p => d(p) <= radius - RADIUS_MARGIN).length;
    return hit >= min ? { hit } : { none: 'few' };
}

/** Enemy players and their pets in her client, alive; and which of them (any contact, monsters too) we hold under crowd control. */
function around(ctx: MemberContext<any>): { foes: Near[]; held: Near[] } {
    const me = ctx.me();
    const now = Date.now();
    const cc = new Set(ctx.picture().contacts.filter(c => c.cc && c.cc.until > now).map(c => c.objectId));
    const pets = new Set(ctx.picture().contacts.filter(c => c.isPet && c.kind !== 'player').map(c => c.objectId));
    const players = ctx.sdk.getNearbyPlayers().filter(p => p.realm !== me.realm && !p.isDead && !p.isShade);
    const npcs = ctx.sdk.getNearbyNpcs().filter(n => pets.has(n.objectId) && n.healthPercent > 0);
    const all = [...players, ...npcs].map(p => ({ id: p.objectId, x: p.x, y: p.y, z: p.z }));
    const heldNpcs = ctx.sdk.getNearbyNpcs().filter(n => cc.has(n.objectId)).map(p => ({ id: p.objectId, x: p.x, y: p.y, z: p.z }));
    return { foes: all.filter(p => !cc.has(p.id)), held: [...all.filter(p => cc.has(p.id)), ...heldNpcs.filter(n => !all.some(p => p.id === n.id))] };
}

/** In a fight, the bomb when bombVerdict says so; quiet otherwise. Above `above` % power. */
export const pbae = (above = 0, min = MIN_FOES): Behavior<TacticsSettings> => ({
    name: 'pbae',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (!ctx.threats().length && o.phase !== 'engage' && o.phase !== 'retreat') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < above) return false;
        const sp = pbaeSpell(ctx.spells.all(), me.mana);
        if (!sp || hammeredBy(ctx)) return false;
        const { foes, held } = around(ctx);
        const v = bombVerdict(me, foes, held, sp.radius, min);
        if ('none' in v) return v.none === 'cc' && foes.length >= min ? ctx.skip('pbae: crowd control in its radius') : false;
        await stopSwinging(ctx);
        ctx.doing('nuke', null, `${sp.spell.name} on ${v.hit} around us`);
        ctx.result('pbae', await ctx.bot.castSpell(sp.spell));
        return true;
    },
});
