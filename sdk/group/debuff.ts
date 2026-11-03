// A resist debuff on the focus, for a caster whose nuke does the same damage type. It goes in a character's
// `react` (bots/<bot>/character.ts), so it runs just above the role's assist, which then does the nuking.
// learnings/classes/enchanter.md has the numbers. C# refs are relative to server/core/GameServer.

import { ckey, foeInView, holdState, type TacticsSettings } from './behaviors';
import type { Behavior, MemberContext } from './member';
import type { SpellPick } from './spells';

const RESIST_DEBUFF = /^(Body|Cold|Energy|Heat|Matter|Spirit)ResistDebuff$/;
/** An on-line debuff at or above its spell level lands at 1.23-1.25 times its value (SingleStatBuff.cs:46-50). */
const SPEC_BONUS = 1.24;
/** Seconds a real cast takes beyond its listed time, nuke and debuff: 10 nukes in 28.5 s, 4.8 debuffs in the 11.6 s left. */
const NUKE_TURN = 0.25;
const DEBUFF_TURN = 0.4;
/** A debuff is resisted like any spell; 13 of 94 on targets of the caster's level. */
const LANDS = 0.86;
/** Below this % health the nukes it would speed up are mostly not going to happen. */
const ABOVE_HP = 40;

/** The strongest debuff we know of the resist `nuke`'s damage is checked against, or null. */
export function matchingDebuff(picks: SpellPick[], nuke: Pick<SpellPick, 'damageType'>): SpellPick | null {
    const ok = picks.filter(s => RESIST_DEBUFF.test(s.type) && s.target === 'Enemy' && s.radius === 0 && s.damageType === nuke.damageType);
    return ok.sort((a, b) => b.value - a.value)[0] ?? null;
}

/**
 * Whether the extra damage in its window pays for the nuke the cast costs. A resist below 0 counts half on a
 * player and in full on a monster (ResistCalculator.cs:76-79), and the window ends where the debuff does: the
 * 8 s Heat ranks raise 2 nukes. Alone that takes Empower Heat on a monster, which measured even at best.
 * `allies` is the same-type damage other casters deal beside us, in multiples of ours.
 */
export function debuffPays(debuff: Pick<SpellPick, 'value' | 'duration' | 'castTime'>, nuke: Pick<SpellPick, 'castTime'>, target: { player: boolean; allies?: number }): boolean {
    const gain = debuff.value * SPEC_BONUS * (target.player ? 0.5 : 1) / 100;
    const hits = Math.floor(debuff.duration / (nuke.castTime + NUKE_TURN)) * (1 + (target.allies ?? 0));
    return hits * gain * LANDS >= (debuff.castTime + DEBUFF_TURN) / (nuke.castTime + NUKE_TURN);
}

/**
 * Debuff the focus before the nukes, and again when the next nuke would land after it ran out or the server says
 * it faded (a resist on the target shortens it, ResistDebuff.cs:25-38). The client sees no effect on someone else,
 * so the debuff is remembered per target from our own casts; a resisted one isn't on, and gets another try after
 * a nuke. Never on a target nearly dead, and it falls through whenever the debuff doesn't pay (debuffPays),
 * leaving the turn to assist.
 */
export const resistDebuff = (opts: { allies?: number; aboveHp?: number } = {}): Behavior<TacticsSettings> => ({
    name: 'resistDebuff',
    interruptible: false,
    async run(ctx: MemberContext<TacticsSettings>) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const mob = ctx.focus();
        if (!mob || mob.cc || mob.hp <= (opts.aboveHp ?? ABOVE_HP) || !foeInView(ctx, mob.objectId)) return false;
        const now = Date.now();
        if (mob.kind !== 'player' && !holdState(mob, ctx.tank()?.name ?? null, ctx.settings.holdMs, ctx.settings.assistAfterMs, now).held) return false;
        const nuke = ctx.spells.nuke({ targetHp: 0 });
        const debuff = nuke && matchingDebuff(ctx.spells.all(), nuke);
        if (!nuke || !debuff) return false;
        if (!debuffPays(debuff, nuke, { player: mob.kind === 'player', allies: opts.allies })) return false;
        // Kept per mob (object ids are reused at once), like the DoTs in assist.
        const live = new Set(ctx.picture().contacts.map(c => `debuff:${ckey(c)}`));
        for (const k of [...ctx.memory.keys()]) if (k.startsWith('debuff:') && !live.has(k)) ctx.memory.delete(k);
        const key = `debuff:${ckey(mob)}`;
        const on: { until: number; since: number } | undefined = ctx.memory.get(key);
        const faded = on && ctx.sdk.getGameMessages().some(m => m.id > on.since && m.text.includes(mob.name) && /vulnerability fades/.test(m.text));
        if (on && !faded && now + nuke.castTime * 1000 < on.until) return false;
        if ((ctx.me().mana ?? 0) < debuff.power + nuke.power) return false;
        if (ctx.me().attacking) await ctx.sdk.sendAttack(false);
        ctx.doing('debuff', mob.objectId, debuff.spell.name);
        const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
        const c = await ctx.bot.castSpell(debuff.spell, mob.objectId);
        ctx.result('debuff', c, mob.objectId);
        const landed = c.success && !c.resisted;
        ctx.memory.set(key, { until: Date.now() + (landed ? debuff.duration * 1000 : nuke.castTime * 1000 + 500), since });
        if (!c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        return true;
    },
});
