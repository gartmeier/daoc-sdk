// The standard Warden: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list already
// heals, buffs and rezzes from whatever the bot knows. What is the class's own:
// - Her pulsing damage add, Nature's Retaliation (Nurture 19, instant, no power, group within 1500): the healer's list has no
//   song(), so it was never cast. `damageAdd` is song() with her damage chant alone: song() itself would play her endurance
//   chant (Attack Unending) in a fight, ahead of damage (songs.ts wantedSongs), and one pulse of hers ends the other.
// - Her group bladeturn, Nature's Shield (Nurture 18, 4 s, 12 % power, every member within 1250, absorbs one melee hit):
//   buff() keeps it up out of a fight; `bladeturnInFight` puts it back once ours is gone, only while the fight is calm.
// - Group Revigoration (33-41 to everyone, 3 s) through the Druid kit's groupHeal, when four or more each miss most of it.
// Her single heals are half a Druid's rate (Major Regeneration 136 per 3.2 s), so a line-up with her as its only healer
// starts its heals earlier (groups/hibernia/rvr.ts ownMakeUp). learnings/classes/warden.md says why.

import { hammeredBy, song, type TacticsSettings } from '../group/behaviors';
import type { MemberContext } from '../group/member';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import { groupHeal } from './druid';

/** In a fight: below this % power the bubble waits, the power is for heals. */
export const BUBBLE_FLOOR = 40;
/** In a fight: everyone in our region at or above this % health, or the bubble waits (a 4 s cast is a heal not cast). */
export const BUBBLE_CALM = 80;
/** In a fight: at most one bubble per this long. */
export const BUBBLE_EVERY_MS = 20_000;

/** Her bladeturns, the group one first: a group spell covers her too. */
export function bladeturns(all: readonly SpellPick[]): SpellPick[] {
    const rank = (s: SpellPick) => (s.target === 'Group' ? 0 : s.target === 'Self' ? 1 : 2);
    return all.filter(s => /Bladeturn/i.test(s.type) && s.target !== 'Enemy' && (s.target === 'Group' || s.target === 'Self'))
        .sort((a, b) => rank(a) - rank(b) || b.spell.level - a.spell.level);
}

/**
 * Bubble now, in a fight: ours is gone (popped by a hit, the best sign the others' are too: we can't see their effects), the
 * fight is calm (everyone at or above BUBBLE_CALM), nobody aims at her, her power is above the floor, and the last one is
 * BUBBLE_EVERY_MS ago.
 */
export function bubbleNow(o: { engaged: boolean; ownBubble: boolean; lowestHp: number; aimedAt: boolean; manaPercent: number; sinceLast: number }): boolean {
    return o.engaged && !o.ownBubble && o.lowestHp >= BUBBLE_CALM && !o.aimedAt && o.manaPercent >= BUBBLE_FLOOR && o.sinceLast >= BUBBLE_EVERY_MS;
}

export const bladeturnInFight = (): Behavior<TacticsSettings> => ({
    name: 'bladeturn',
    interruptible: false,
    async run(ctx) {
        const engaged = ctx.orders().phase === 'engage' && ctx.threats().length > 0;
        if (!engaged) return false;
        const sp = bladeturns(ctx.spells.all()).find(s => ctx.spells.powerOf(s) <= ctx.me().mana && s.spell.cooldownRemaining <= 0);
        if (!sp) return false;
        const me = ctx.me();
        const effects = (ctx.sdk.getState()?.effects ?? []).map(e => e.name);
        const ownBubble = bladeturns(ctx.spells.all()).some(s => effects.includes(s.spell.name));
        const region = ctx.members().find(m => m.name === ctx.name)?.regionId;
        const lowestHp = Math.min(100, ...ctx.members().filter(m => !m.isDead && m.regionId === region).map(m => m.hp));
        const aimedAt = !!hammeredBy(ctx) || ctx.threats().some(t => !t.stale && !t.cc && t.target === ctx.name);
        const sinceLast = Date.now() - (ctx.memory.get('bubbleAt') ?? 0);
        if (!bubbleNow({ engaged, ownBubble, lowestHp, aimedAt, manaPercent: me.maxMana > 0 ? me.manaPercent : 100, sinceLast })) return false;
        ctx.memory.set('bubbleAt', Date.now());
        ctx.doing('buff', me.objectId, sp.spell.name);
        ctx.result('buff', await ctx.bot.castSpell(sp.spell), me.objectId);
        return true;
    },
});

/**
 * song() over her damage chant alone (a pulsing DamageAdd: songs.ts 'damage'): in a fight it starts Nature's Retaliation and
 * keeps it, after the fight it stops it once, as song() does with a song nobody wants. Her speed and endurance chants stay
 * unplayed: the Bard's speed is faster (174 % against 138 %), and a second pulse of hers would end the damage add.
 */
export function damageAdd(): Behavior<TacticsSettings> {
    const inner = song();
    return {
        ...inner,
        name: 'damageAdd',
        run(ctx) {
            const spells = Object.create(ctx.spells, { songs: { value: () => ctx.spells.songs().filter(s => s.kind === 'damage') } });
            const view = Object.create(ctx, { spells: { value: spells } }) as MemberContext<TacticsSettings>;
            return inner.run(view);
        },
    };
}

export interface WardenOptions {
    /** groupHeal: how many members (her too) must each miss most of Group Revigoration. */
    groupHealMin?: number;
}

export function warden({ groupHealMin = 4 }: WardenOptions = {}): Character {
    // The damage add first among her idle turns: instant and free, so it costs no heal.
    return { role: 'healer', urgent: [groupHeal(groupHealMin, 25)], react: [damageAdd(), bladeturnInFight()] };
}
