// Poisons for the assassins (Infiltrator, Nightshade, Shadowblade): a damage-over-time poison on the main hand and a
// snare on the off hand, put on out of combat, so that the opener and the swing after it carry them.
//
// Server code (GameServer, read 2026-11-12):
// - A poison is used from the bag on the main hand if that is clean, else the off hand (GamePlayer.cs:6753-6761), or
//   dragged onto a weapon slot, which poisons that weapon (GamePlayerInventory.cs:678-686). We drag: it names the hand.
// - ApplyPoison (GamePlayer.cs:7243-7323): Envenom (with items) at least the poison's level, the character's level too,
//   a weapon its class may poison, not in combat (the server's 10 s: "You have been in combat recently and can't apply
//   a poison yet!"), not mezzed. Reapplying over a poison isn't refused (that check is commented out). Success says
//   "You apply <poison> to <weapon>." and takes one poison from the stack.
// - Every poison row in the DB has one charge (itemtemplate PoisonCharges 1): the first landed hit with that weapon fires it
//   and clears the weapon (GameLiving.cs:807-828). So it goes on again after each fight.
// - A poisoned weapon's delve has "- N Charges" (DetailDisplayHandler.WritePoisonInfo.Charges); a clean one has none.
//
// At 24 with gear (+5 Envenom): Mordred and Scathach Envenom 20, Hodur 22.
//   greater lethal poison (20): DamageOverTime 26 every 4 s for 20 s.
//   greater imbalancing poison (18): UnbreakableSpeedDecrease 40 % for 61 s.
//   greater weakening poison (17): StrengthDebuff 44 for 60 s.
//   minor enervating poison (22): StrengthConstitutionDebuff 55 for 60 s.
// Thidranki has no merchant: bots/gmlevel/give-poisons.ts trades them over (PackSize 1, one bag slot each).

import type { Behavior, MemberContext } from '../group/member';
import { EquipmentSlot, ObjectType, type GameMessage, type InventoryItem, type Realm } from '../types';

export interface PoisonRow { name: string; level: number; effect: 'dot' | 'snare' | 'str' | 'strcon' }
/** Best first within each effect. The id is the name with underscores, and a realm suffix: '' Albion, 2 Midgard, 3 Hibernia. */
export const POISONS: readonly PoisonRow[] = [
    { name: 'greater lethal poison', level: 20, effect: 'dot' },
    { name: 'major lethal poison', level: 15, effect: 'dot' },
    { name: 'lethal poison', level: 10, effect: 'dot' },
    { name: 'greater imbalancing poison', level: 18, effect: 'snare' },
    { name: 'major imbalancing poison', level: 13, effect: 'snare' },
    { name: 'minor enervating poison', level: 22, effect: 'strcon' },
    { name: 'greater weakening poison', level: 17, effect: 'str' },
    { name: 'major weakening poison', level: 11, effect: 'str' },
];
const SUFFIX: Record<Realm, string> = { albion: '', midgard: '2', hibernia: '3' } as Record<Realm, string>;

/** The template id for a poison in a realm (itemtemplate Id_nb). */
export const poisonId = (name: string, realm: Realm) => `${name.replace(/ /g, '_')}${SUFFIX[realm] ?? ''}`;

/** The main hand's poison (damage over time) and the off hand's (a snare, else the strongest debuff) for an Envenom level. */
export function poisonPlan(envenom: number): { main: PoisonRow | null; off: PoisonRow | null } {
    const best = (effects: PoisonRow['effect'][]) => effects.map(e => POISONS.find(p => p.effect === e && p.level <= envenom)).find(Boolean) ?? null;
    return { main: best(['dot']), off: best(['snare', 'strcon', 'str']) };
}

/** A delve's lines: the weapon still carries a poison charge. */
export function isPoisoned(lines: readonly string[]): boolean {
    return lines.some(l => { const m = /^\s*-\s*(\d+)\s+Charges\b/i.exec(l); return !!m && Number(m[1]) > 0; });
}

export type PoisonApplyReason = 'applied' | 'in_combat' | 'cant_use' | 'cant_poison' | 'no_answer';
/** The server's answer to an application. */
export function applyAnswer(texts: readonly string[]): PoisonApplyReason | null {
    for (const t of texts) {
        if (/^You apply .+ to .+\.$/i.test(t)) return 'applied';
        if (/combat recently and can't apply a poison/i.test(t)) return 'in_combat';
        if (/can't use (this poison|poisons)/i.test(t)) return 'cant_use';
        if (/can't poison this weapon|Poisons can be applied only to weapons/i.test(t)) return 'cant_poison';
    }
    return null;
}

/** The weapons the plan poisons: the main hand (10) and, held, the off hand's weapon (11; a shield is no weapon). */
const HANDS = [EquipmentSlot.RightHand, EquipmentSlot.LeftHand] as const;
const inBag = (i: InventoryItem) => i.slot >= EquipmentSlot.FirstBackpack && i.slot <= EquipmentSlot.LastBackpack;
/** Look again at the weapons this long after the last look, and after every fight. */
const RECHECK_MS = 5 * 60_000;
/** After "in combat recently", the next try no sooner. */
const RETRY_MS = 4000;
const ANSWER_MS = 3000;

/** Drag a poison from the bag onto a weapon slot and read the server's answer. */
export async function applyPoison(ctx: Pick<MemberContext, 'sdk'>, poison: InventoryItem, weaponSlot: number): Promise<PoisonApplyReason> {
    const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
    const said = () => ctx.sdk.getGameMessages().filter((m: GameMessage) => m.id > since).map(m => m.text);
    await ctx.sdk.sendMoveItem(poison.slot, weaponSlot);
    await ctx.sdk.waitForCondition(() => applyAnswer(said()) !== null, ANSWER_MS).catch(() => null);
    return applyAnswer(said()) ?? 'no_answer';
}

/**
 * Out of combat, keep both hands poisoned: after a fight (or every RECHECK_MS) delve each weapon, and put the plan's
 * poison on any that carries none. A chore: it runs only when no fight or move above it has work.
 */
export const envenom = (): Behavior => ({
    name: 'envenom',
    interruptible: false,
    async run(ctx) {
        const me = ctx.me();
        const now = Date.now();
        if (me.isDead) return false;
        if (me.inCombat || me.attacking) { ctx.memory.set('poisonFightAt', now); return false; }
        // The server's in-combat lasts 2 s past the client's (GameLiving.cs:31): wait it out.
        if (now - (ctx.memory.get('poisonFightAt') ?? 0) < 2500) return false;
        if (now < (ctx.memory.get('poisonRetryAt') ?? 0)) return false;
        const fought = (ctx.memory.get('poisonFightAt') ?? 0) > (ctx.memory.get('poisonCheckAt') ?? 0);
        if (!fought && now - (ctx.memory.get('poisonCheckAt') ?? 0) < RECHECK_MS) return false;
        const spec = ctx.sdk.findSpecialization('Envenom');
        if (!spec) return false;
        const plan = poisonPlan(spec.level + (spec.bonus ?? 0));
        const bag = ctx.sdk.getInventory().filter(i => inBag(i) && i.objectType === ObjectType.Poison);
        const equipment = ctx.sdk.getEquipment();
        ctx.memory.set('poisonCheckAt', now);
        let acted = false;
        for (const slot of HANDS) {
            const weapon = equipment.find(e => e.slot === slot);
            const want = slot === EquipmentSlot.RightHand ? plan.main : plan.off;
            if (!weapon || weapon.objectType === ObjectType.Shield || !want) continue;
            const poison = bag.find(i => i.name.toLowerCase() === want.name);
            if (!poison) continue;
            const delve = await ctx.bot.delveItem(weapon);
            if (delve.success && isPoisoned(delve.lines)) continue;
            ctx.doing('poison', null, `${want.name} on ${weapon.name}`);
            const r = await applyPoison(ctx, poison, slot);
            ctx.result('poison', { success: r === 'applied', reason: r, message: `${want.name} on ${weapon.name}: ${r}` });
            acted = true;
            if (r === 'in_combat' || r === 'no_answer') { ctx.memory.set('poisonRetryAt', Date.now() + RETRY_MS); ctx.memory.set('poisonCheckAt', 0); break; }
            // That one is used up: the other hand takes another.
            bag.splice(bag.indexOf(poison), 1);
        }
        return acted;
    },
});
