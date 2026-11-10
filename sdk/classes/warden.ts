// The standard Warden: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list already
// heals, buffs and rezzes from whatever the bot knows. What is the class's own:
// - Her pulsing damage add, Nature's Retaliation (Nurture 19, instant, no power, group within 1500): the healer's list has no
//   song(), so it was never cast. `damageAdd` keeps it on, fight or not, and never stops it: song() would play her endurance
//   chant in a fight (songs.ts wantedSongs), and it recast a running pulse whose effect dropped out between pulses, ending it.
// - Her group bladeturn, Nature's Shield (Nurture 18, 4 s, 12 % power, every member within 1250, absorbs one melee hit):
//   buff() keeps it up out of a fight; `bladeturnInFight` puts it back once ours is gone, only while the fight is calm.
// - Group Revigoration (33-41 to everyone, 3 s) through the Druid kit's groupHeal, when four or more each miss most of it.
// Her single heals are half a Druid's rate (Major Regeneration 136 per 3.2 s), so a line-up with her as its only healer
// starts its heals earlier (groups/hibernia/rvr.ts ownMakeUp). learnings/classes/warden.md says why.

import { hammeredBy, type TacticsSettings } from '../group/behaviors';
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

/** Her damage chant's effect missing this long before she casts it again (a pulse's effect drops out between pulses). */
export const DAMAGE_ADD_MISSING_MS = 12_000;
/** At most one cast per this long: a cast at a pulse still running ends it ("You cancel your effect."). */
export const DAMAGE_ADD_EVERY_MS = 15_000;

/** Cast it now: its effect unseen for DAMAGE_ADD_MISSING_MS (or never seen), our last cast DAMAGE_ADD_EVERY_MS ago, ready. */
export function damageAddNow(o: { now: number; seenAt: number | undefined; castAt: number | undefined; startedAt: number; ready: boolean }): boolean {
    const unseenSince = o.seenAt ?? o.startedAt;
    return o.ready && o.now - unseenSince >= DAMAGE_ADD_MISSING_MS && o.now - (o.castAt ?? -Infinity) >= DAMAGE_ADD_EVERY_MS;
}

/**
 * Nature's Retaliation kept on, in a fight and out of one: free, instant, and nothing else of hers needs the pulse slot (her
 * speed and endurance chants stay unplayed: the Bard's speed is faster, 174 % against 138 %). Never stopped. Round 145: the
 * shared song() took it for stopped whenever its effect dropped out between pulses for 6 s and cast it again, which ends a
 * pulse that runs ("You cancel your effect.", twice in one fight). So it is cast only once its effect has been missing for
 * DAMAGE_ADD_MISSING_MS, at most once per DAMAGE_ADD_EVERY_MS. Swinging, it goes out raw (castSpell would select her and drop
 * the swing's target), as song() does.
 */
export function damageAdd(): Behavior<TacticsSettings> {
    return {
        name: 'damageAdd',
        interruptible: false,
        async run(ctx) {
            if (ctx.bot.isDead()) return false;
            const sp = ctx.spells.songs().find(s => s.kind === 'damage');
            if (!sp) return false;
            const now = Date.now();
            const startedAt: number = ctx.memory.get('damageAddSince') ?? now;
            ctx.memory.set('damageAddSince', startedAt);
            if ((ctx.sdk.getState()?.effects ?? []).some(e => e.name === sp.spell.name)) ctx.memory.set('damageAddSeen', now);
            if (!damageAddNow({ now, seenAt: ctx.memory.get('damageAddSeen'), castAt: ctx.memory.get('damageAddCast'), startedAt, ready: sp.spell.cooldownRemaining <= 0 })) return false;
            ctx.memory.set('damageAddCast', now);
            ctx.doing('song', null, sp.spell.name);
            if (ctx.me().attacking) {
                if (sp.spell.skillIndex !== undefined) await ctx.sdk.sendUseSkill(sp.spell.skillIndex);
                else await ctx.sdk.sendCastSpell(sp.spell.lineIndex, sp.spell.spellIndex);
                ctx.result('damageAdd', { success: true, message: `${sp.spell.name} (sent while swinging)` });
                return false;
            }
            ctx.result('damageAdd', await ctx.bot.castSpell(sp.spell));
            return true;
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
