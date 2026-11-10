// The standard Enchanter: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role
// list already nukes, buffs and mezzes from whatever the bot knows; what is the class's own is its heat
// debuff. learnings/classes/enchanter.md says what that is worth at which level, and why it does nothing
// on a Mana line below 27.

import { foeInView, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import { resistDebuff } from '../group/debuff';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import { nukerFight, quickcastUnderFire } from './cabalist';
import { slowTarget } from './healer';
import { quickFlash } from './mentalist';

/** His instant single-target debuffs on a melee, best first: attack speed (Blinding Scintillation), then melee damage (Dazzling Torch). */
const DAZZLES = ['CombatSpeedDebuff', 'MeleeDamageDebuff'] as const;

/** The instant single-target debuffs he can cast now, in DAZZLES order. Never an area one (Field of Scintillation): it would wake a mezz beside the target. */
export function dazzleSpells(all: readonly SpellPick[], mana: number): SpellPick[] {
    return all.filter(s => (DAZZLES as readonly string[]).includes(s.type) && s.target === 'Enemy' && s.castTime === 0 && s.radius === 0 && s.range > 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => DAZZLES.indexOf(a.type as typeof DAZZLES[number]) - DAZZLES.indexOf(b.type as typeof DAZZLES[number]) || b.spell.level - a.spell.level);
}

/**
 * In the instant slot: Blinding Scintillation, else Dazzling Torch, at a free enemy player or pet in melee on him, else on
 * one of our soft members (the Midgard Healer kit's slowTarget), never one crowd-controlled. Instant, so it goes while he
 * is chased. Arena round 33: Ciaran moved 85 % of a 251 s fight, cast 2 nukes and died; both debuffs were unused.
 */
export const dazzle = (): Behavior<TacticsSettings> => ({
    name: 'dazzle',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const me = ctx.me();
        const self = ctx.members().find(m => m.name === ctx.name);
        if (!self) return false;
        const threats = ctx.threats().filter(t => !t.cc);
        const distanceTo = (id: number) => foeInView(ctx, id)?.distance ?? Infinity;
        for (const sp of dazzleSpells(ctx.spells.all(), me.mana)) {
            const key = `dazzleUntil:${sp.type}`;
            const until: Map<number, number> = ctx.memory.get(key) ?? new Map();
            ctx.memory.set(key, until);
            const target = slowTarget(self, ctx.members(), threats, until, distanceTo, sp.range);
            if (!target) continue;
            ctx.doing('debuff', target.objectId, sp.spell.name);
            const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
            ctx.result('debuff', c.success && c.resisted ? { ...c, success: false, reason: 'resisted' } : c, target.objectId);
            until.set(target.objectId, Date.now() + (c.success && !c.resisted ? sp.duration * 1000 : 3000));
            return true;
        }
        return false;
    },
});

export interface EnchanterOptions {
    /** Other casters nuking heat beside this one: a Hibernian group's Light Mentalist counts. */
    heatAllies?: number;
    /** Nukes on a free enemy in reach while the focus is out of it (offFocus, from the Cabalist kit). On by default. */
    offFocus?: boolean;
}

/** Arena round 10 (2026-11-09): wiped by Albion in 79 s, Ciaran 2 nukes, moving 73 % with the focus on their back line out of reach. */
export function enchanter({ heatAllies = 0, offFocus = true }: EnchanterOptions = {}): Character {
    return { role: 'nuker', instant: [quickFlash(), dazzle(), quickcastUnderFire()], react: [resistDebuff({ allies: heatAllies })], fight: nukerFight(0, offFocus) };
}
