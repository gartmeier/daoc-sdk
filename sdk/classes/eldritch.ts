// The standard Eldritch: a starting point a bot imports into bots/<bot>/character.ts and tunes. The nuker's list already
// nukes and buffs from whatever the bot knows. What is the class's own:
// - His nukes come from the Light lines only (Way of the Sun, Shadow Control). He is given every Void baseline spell too, at
//   Void 1, where the server rolls them down to about 60 % (SpellHandler.cs:2748-2763); with the pack's strongestNuke the
//   Spellbook took Void Fissure (115 on paper, about 69, 20 s timer) whenever it was ready. Shadowcrash (Shadow Control 22,
//   102, 2.8 s, 13 power) is his best per second and per power. onlyLines is the Runemaster kit's view.
// - Prismatic Flash (Way of the Sun, 2.5 s stun) as the Mentalist kit throws it: stunCaster at a caster on our Bard or
//   healer, quickFlash with Quickcast on a melee on him.
// - `veil`: Paralyzing Veil (Shadow Control 15, 3 s, area mezz, radius 350 round the target, 15 s). The group's crowd control
//   never gives him a turn (Spellbook.capabilities counts a single-target mezz only), so the kit casts it itself, only when
//   it catches two or more free enemy players, not the focus, and nobody another member was told to mezz: a 15 s mezz
//   leaves 60 s of immunity, which would spoil the Bard's 42 s one.
// learnings/classes/eldritch.md says why.

import { areaMezzCatch, foeInView, hammeredBy, stopSwinging, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact, Orders } from '../group/types';
import { quickcastUnderFire } from './cabalist';
import { casterFight, noteTooFar, petOnMe, quickFlash, stunCaster, tooFarOf, viewDistance } from './mentalist';
import { unlessAimedAt } from './druid';
import { onlyLines } from './runemaster';
import { wallStep } from './healer-stand';

/** His damage lines by the names the server sends (Light baseline and spec); the Void and Mana nukes stay out. */
export const ELDRITCH_NUKE_LINES: readonly string[] = ['Way of the Sun', 'Shadow Control'];

/** The veil waits below this % power: Shadowcrash is his job. */
export const VEIL_FLOOR = 25;
/** At most one veil per this long. */
export const VEIL_EVERY_MS = 20_000;
/** It must catch at least this many. */
export const VEIL_MIN = 2;
/** After a mezz ends a player takes no other for 60 s (CrowdControlECSEffect.cs:14-21). */
const MEZZ_IMMUNE_MS = 60_000;
/** As the Flash's (mentalist.ts): the server measures in 3D at the cast's end. */
const RANGE_MARGIN = 150;

/**
 * Where to put the veil: the enemy player in range (by `distanceTo`) whose area catches the most, at least `min`, none of
 * them the focus (areaMezzCatch gives none then) nor one another member is assigned; a healer or caster caught counts on a
 * tie. Null when none.
 */
export function veilTarget(contacts: readonly Contact[], o: Pick<Orders, 'focus' | 'cc'>, me: string, radius: number, range: number, distanceTo: (c: Contact) => number, min = VEIL_MIN, now = Date.now()): { target: Contact; caught: Contact[] } | null {
    const assigned = new Set(o.cc.filter(a => a.by !== me).map(a => a.targetId));
    const soft = (cs: Contact[]) => cs.filter(c => c.healer || c.caster || c.classGuess?.role === 'healer' || c.classGuess?.role === 'caster').length;
    return contacts
        .filter(c => c.kind === 'player' && !c.stale && !c.cc && !c.isPet && c.hp > 0 && c.objectId !== o.focus && distanceTo(c) <= range - RANGE_MARGIN)
        .map(c => ({ target: c, caught: areaMezzCatch(c, contacts, radius, o.focus, now) }))
        .filter(x => x.caught.length >= min && !x.caught.some(c => assigned.has(c.objectId)))
        .sort((a, b) => b.caught.length - a.caught.length || soft(b.caught) - soft(a.caught) || distanceTo(a.target) - distanceTo(b.target))[0] ?? null;
}

export const veil = (): Behavior<TacticsSettings> => ({
    name: 'veil',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < VEIL_FLOOR) return false;
        const now = Date.now();
        if (now - (ctx.memory.get('veilAt') ?? 0) < VEIL_EVERY_MS) return false;
        const sp = ctx.spells.areaMezz();
        if (!sp || sp.power > me.mana || sp.spell.cooldownRemaining > 0) return false;
        // A swing at him would only interrupt the 3 s cast: flee's turn, and quickFlash's.
        if (hammeredBy(ctx) || petOnMe(ctx.threats(), me.name)) return false;
        const far = tooFarOf(ctx.memory);
        const raw = (c: Contact) => { const v = foeInView(ctx, c.objectId); return !v || ('isDead' in v && v.isDead) ? Infinity : v.distance; };
        const pick = veilTarget(ctx.picture().contacts, o, ctx.name, sp.radius, sp.range, c => viewDistance(far, c.objectId, raw(c), now), VEIL_MIN, now);
        if (!pick) return false;
        ctx.memory.set('veilAt', now);
        await stopSwinging(ctx);
        ctx.doing('cc', pick.target.objectId, `${sp.spell.name} on ${pick.caught.length}`);
        const c = await ctx.bot.castSpell(sp.spell, pick.target.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune ? 'immune' : c.alreadyOn ? 'already_on' : c.resisted ? 'resisted' : c.effectLanded === false ? 'no_effect' : null;
        ctx.result('cc', refused ? { ...c, success: false, reason: refused } : c, pick.target.objectId);
        noteTooFar(far, pick.target.objectId, c.reason, raw(pick.target), Date.now());
        if (refused === 'immune' || refused === 'already_on') ctx.markCcImmune(pick.target.objectId, 'mezz', MEZZ_IMMUNE_MS);
        else if (c.success && !refused) {
            // Every one it caught is crowd-controlled: the group's damage keeps off them.
            ctx.markCc(pick.target.objectId, 'mezz', sp.duration * 1000, c.landedOn);
            for (const n of pick.caught) if (n.objectId !== pick.target.objectId) ctx.markCc(n.objectId, 'mezz', sp.duration * 1000);
        }
        return true;
    },
});

export interface EldritchOptions {
    /** Nukes on a free enemy in reach while the focus is out of it (offFocus, the Cabalist kit's). On by default. */
    offFocus?: boolean;
    /** The lines he nukes from (default: Light). */
    lines?: readonly string[];
    /** Cast the area mezz of his own (veil). On by default. */
    areaMezz?: boolean;
}

export function eldritch({ offFocus = true, lines = ELDRITCH_NUKE_LINES, areaMezz = true }: EldritchOptions = {}): Character {
    return {
        role: 'nuker',
        instant: [quickFlash(), onlyLines(quickcastUnderFire(), lines)],
        // The veil only while nothing aims at him (unlessAimedAt, the Druid kit's): a 3 s cast under fire is a cast lost. Rounds
        // 128, 133 and 137 against Albion: he was their target (in melee 27-81 %), and 137's veil was cut by an enemy pet.
        urgent: [stunCaster(), ...(areaMezz ? [unlessAimedAt(veil())] : []), wallStep()],
        fight: casterFight(offFocus).map(b => onlyLines(b, lines)),
    };
}
