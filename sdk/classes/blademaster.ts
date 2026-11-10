// The standard Blademaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. Two blades, no shield:
// every Shields style needs one in the left hand (StyleProcessor.cs:167), so at 24 his only stun is Ice Storm (Celtic Dual
// 18, from the side, 4 s, a proc only Blademasters get). What is the class's own:
// - `bladeStyle`: at a player, Ice Storm once per stun immunity with Hurricane behind it (the server keeps a first style and
//   a backup, and swings the backup when the side isn't met); between stuns the reacting tank's pick (follow-ups, reactions,
//   a positional while the target is on someone else, then the best plain style), never a taunt: with taunts in the list the
//   fighter's pick ranks Taunting Blade and Squall above Hurricane per endurance (round 121: Taunting Blade on a player).
// - `tripleWield` (level 20, 30 s, 7 min): each hit adds about half its weapon damage as Body, on the first player he swings at.
// - His fight by the role the group gives him: the tank's (peels divers off our casters, anchors the pack) when the line-up
//   has no tank, else the melee's assist on the focus. So the kit sets no role: the group's roleOf does.
// learnings/classes/blademaster.md says why, and what was measured.

import { assist, foeInView, tank, type StylePick, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { canWield } from '../group/styles';
import type { Style } from '../types';
import { noteStun, stunnable, type StunLog } from './hero';
import { reactingStyle } from './reacting-tank';

/** His stun at 24 by the build, with its length (StyleStun spell 20400). */
export const BLADEMASTER_STUNS: Readonly<Record<string, number>> = { 'Ice Storm': 4000 };
/** What goes behind the stun: the best plain Celtic Dual style at 21, then the Blades one. */
const BACKUPS = ['Hurricane', 'Fire Blade'] as const;

/**
 * The stun queue for the next swing, or null to leave it to the fighter's pick: Ice Storm and the first backup he can wield
 * and pay for, both paid for. Without a backup a failed positional would swing nothing styled, so no backup, no stun queue.
 */
export function bladeStunQueue(styles: readonly Style[], equipment: Parameters<typeof canWield>[1], endurancePercent: number): string[] | null {
    const affordable = (name: string) => styles.find(s => s.name === name && s.details && canWield(s, equipment) && endurancePercent >= s.details.fatigue);
    const stun = affordable('Ice Storm');
    const backup = BACKUPS.map(affordable).find(Boolean);
    return stun && backup ? [stun.name, backup.name] : null;
}

/** The Blademaster's pick: Ice Storm at a player once per immunity, else the reacting tank's (no taunts). */
export function bladeStyle(log: StunLog = new Map(), now: () => number = Date.now, fighter: StylePick = reactingStyle): StylePick {
    return seen => {
        const { target, player, state, styles } = seen;
        noteStun(log, state, player.objectId, BLADEMASTER_STUNS);
        if (target.kind === 'player' && stunnable(log, target.objectId, now())) {
            const q = bladeStunQueue(styles, state.equipment, player.endurancePercent);
            if (q) return q;
        }
        return fighter(seen);
    };
}

/** Triple Wield's reuse (TripleWieldAbilityHandler.cs: 7 min), and the wait after a refusal. */
export const TRIPLE_WIELD_REUSE_MS = 7 * 60_000;
const TRIPLE_WIELD_RETRY_MS = 30_000;
/** A player this near counts as the one he is swinging at. */
const IN_MELEE = 350;

/** Use it now: in an engage, swinging, with a living enemy player in melee reach, and it is ready by our clock. */
export function tripleWieldNow(o: { phase: string; attacking: boolean; readyAt: number; now: number; nearestPlayer: number }): boolean {
    return o.phase === 'engage' && o.attacking && o.now >= o.readyAt && o.nearestPlayer <= IN_MELEE;
}

/**
 * The wait in a refusal, "You must wait 6 minutes 12 seconds to use this ability." (CastingComponent.cs FormatCooldown,
 * Util.FormatSeconds), in ms; null when the message says none. The reuse outlives a round: round 129 opened with "You must
 * wait 14 seconds", the last round's use, which a fresh run's clock can't know.
 */
export function waitOf(message: string | undefined): number | null {
    const m = /must wait (?:(\d+) minutes?)? ?(?:(\d+) seconds?)?/.exec(message ?? '');
    if (!m || (!m[1] && !m[2])) return null;
    return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
}

export const tripleWield = (): Behavior<TacticsSettings> => ({
    name: 'tripleWield',
    interruptible: false,
    async run(ctx) {
        const now = Date.now();
        const me = ctx.me();
        if (!ctx.sdk.findAbility('Triple Wield')) return false;
        const near = Math.min(Infinity, ...ctx.threats().filter(t => t.kind === 'player' && !t.stale && t.hp > 0).map(t => {
            const v = foeInView(ctx, t.objectId);
            return !v || ('isDead' in v && v.isDead) ? Infinity : v.distance;
        }));
        if (!tripleWieldNow({ phase: ctx.orders().phase, attacking: !!me.attacking, readyAt: ctx.memory.get('tripleWieldReadyAt') ?? 0, now, nearestPlayer: near })) return false;
        const r = await ctx.bot.useAbility('Triple Wield');
        ctx.memory.set('tripleWieldReadyAt', now + (r.success ? TRIPLE_WIELD_REUSE_MS : waitOf(r.message) ?? TRIPLE_WIELD_RETRY_MS));
        ctx.result('tripleWield', r);
        return true;
    },
});

/**
 * His fight by the role he plays this run: with the tank's role the tank's fight (peels, the leash, the anchor), else the
 * melee's assist (holdMs 0, as meleeFight). Both with bladeStyle; one stun log for both.
 */
export function bladeFight(style: StylePick = bladeStyle()): Behavior<TacticsSettings> {
    const asTank = tank({ style });
    const asMelee = assist({ melee: true, holdMs: 0, style });
    return { name: 'bladeFight', run: ctx => (ctx.role === 'tank' ? asTank : asMelee).run(ctx) };
}

export function blademaster(): Character {
    return { react: [tripleWield()], fight: [bladeFight()] };
}
