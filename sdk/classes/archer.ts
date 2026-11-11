// The archer kit, shared by the Scout, the Ranger and the Hunter (learnings/classes/scout.md, ranger.md, hunter.md).
// Role nuker: the group keeps it at a caster's distance (combatRange nuker 700-1400, inside every bow's reach). Its own:
//
// - hide (the assassins' kit): out of a fight it stays hidden, and the first shot comes from stealth.
// - shoot: on the focus, from where it stands, within its bow's reach. Verified live 2026-11-11 (Tristram on a Hitback
//   Dummy at 1035, sdk bots/tristram/bow-check.ts):
//   - With a melee weapon in hand the first use of the ranged slot only takes the bow ("You wield the ... Longbow").
//   - The next use draws: "You prepare your shot (4.6s to fire, target is in range)", then "You are ready to fire!".
//   - A use before it is ready sets it to release by itself ("You will now automatically release your shot."), and one
//     more "...and reload" (RangeAttackComponent). A use after it is ready fires.
//   - Any turn while drawing interrupts it: "You move and interrupt your shot!". So it faces once, before the draw.
//   - Hidden, the shot unstealths ("You are no longer hidden!" just before "You shoot ... for 223 damage!").
//   - The target must be in front within 90 degrees at the release ("... is not in view!"), and arrows in the backpack
//     ("You must select a quiver slot"; Thidranki has no fletcher: bots/gmlevel/give-arrows.ts).
// - An enemy inside CLOSE: no draw (4.6 s is a lost fight in melee), the melee fight takes over, as killPlayer takes a
//   melee weapon in hand itself on the bow's refusal.
// - Reach by bow (AttackComponent.AttackRange): longbow 1760, recurve 1680, composite 1600.

import { foeInView, meleeFight } from '../group/behaviors';
import { isAlive } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import { EquipmentSlot, ObjectType } from '../types';
import { hide } from './stealther';

/** An enemy player this near: melee instead of a draw. */
export const CLOSE = 350;
/** Reach by bow type, less a margin for the target's own step. */
export const BOW_REACH: Readonly<Record<number, number>> = { [ObjectType.Longbow]: 1760, [ObjectType.RecurvedBow]: 1680, [ObjectType.CompositeBow]: 1600 };
const MARGIN = 150;
/** The most a shot takes, draw and flight, before the turn gives up waiting for its line. */
const SHOT_MS = 7000;
/** After "out of arrows", the bow rests this long (the melee fight goes on). */
const NO_ARROWS_MS = 300_000;

const SHOT_LINE = /^You (shoot|miss)|evades your attack|blocks your attack/i;
const SHOT_REFUSAL = /not in view|can't see your target|too far away|must select a quiver|can't use the quiver|too tired|interrupt your shot|must select a target/i;

/** The bow worn in the ranged slot, and how far it reaches. */
export function bowOf(equipment: readonly { slot: number; objectType: number }[]): { objectType: number; reach: number } | null {
    const bow = equipment.find(e => e.slot === EquipmentSlot.Ranged && BOW_REACH[e.objectType] !== undefined);
    return bow ? { objectType: bow.objectType, reach: BOW_REACH[bow.objectType]! - MARGIN } : null;
}

/** What a shot turn does at this distance: 'melee' (too close, or out of arrows), 'shoot', 'close' (walk in), or null. */
export function shotPlan(distance: number, reach: number, nearestEnemy: number, arrows: number): 'melee' | 'shoot' | 'close' {
    if (arrows <= 0 || nearestEnemy <= CLOSE) return 'melee';
    return distance <= reach ? 'shoot' : 'close';
}

const arrowsOf = (ctx: MemberContext) => ctx.sdk.getInventory().filter(i => i.slot >= EquipmentSlot.FirstBackpack && i.slot <= EquipmentSlot.LastBackpack && i.objectType === ObjectType.Arrow).reduce((n, i) => n + i.count, 0);

/** Shoot the focus from range. False when it is close or we have no bow or arrows: the melee fight below goes on. */
export const shoot = (): Behavior => ({
    name: 'shoot',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || typeof o.focus !== 'number') return false;
        const bow = bowOf(ctx.sdk.getEquipment());
        if (!bow || Date.now() < (ctx.memory.get('noArrowsUntil') ?? 0)) return false;
        const focus = ctx.focus();
        if (!focus || !isAlive(focus)) return false;
        const seen = foeInView(ctx, focus.objectId);
        if (!seen) return false;
        const nearest = Math.min(Infinity, ...ctx.sdk.getNearbyPlayers().filter(p => p.realm !== ctx.me().realm && !p.isDead).map(p => p.distance));
        const plan = shotPlan(seen.distance, bow.reach, nearest, arrowsOf(ctx));
        if (plan === 'melee') return false;
        if (plan === 'close') {
            const me = ctx.me();
            const f = (seen.distance - bow.reach * 0.85) / seen.distance;
            ctx.doing('move', seen.objectId, 'into bow reach');
            await ctx.bot.walkTo(me.x + (seen.x - me.x) * f, me.y + (seen.y - me.y) * f, { tolerance: 60, timeout: 3000 });
            return true;
        }
        return loose(ctx, seen.objectId);
    },
});

/** One shot: target, face once, bow in hand, draw, and a use before it is ready so it releases by itself. */
async function loose(ctx: MemberContext, targetId: number): Promise<boolean> {
    const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
    const said = () => ctx.sdk.getGameMessages().filter(m => m.id > since);
    ctx.doing('shoot', targetId);
    await ctx.sdk.sendStop();
    if (ctx.me().attacking) await ctx.sdk.sendAttack(false);
    if (ctx.me().targetObjectId !== targetId) await ctx.sdk.sendSetTarget(targetId);
    await ctx.sdk.sendFaceObject(targetId);
    let use = await ctx.bot.useItem(EquipmentSlot.Ranged);
    // The first use only took the bow in hand.
    if (use.success && /^You wield/i.test(use.message)) use = await ctx.bot.useItem(EquipmentSlot.Ranged);
    if (!use.success) { ctx.result('shoot', use, targetId); return true; }
    if (/prepare your shot/i.test(use.message)) await ctx.bot.useItem(EquipmentSlot.Ranged);
    await ctx.sdk.waitForCondition(() => said().some(m => SHOT_LINE.test(m.text) || SHOT_REFUSAL.test(m.text)), SHOT_MS).catch(() => null);
    const line = said().find(m => SHOT_LINE.test(m.text) || SHOT_REFUSAL.test(m.text))?.text;
    if (line && /quiver/i.test(line)) ctx.memory.set('noArrowsUntil', Date.now() + NO_ARROWS_MS);
    ctx.result('shoot', { success: !!line && SHOT_LINE.test(line), message: line ?? 'no shot line' }, targetId);
    return true;
}

/** The kit: hide above flee, shoot ahead of the melee fight. */
export function archer(): Character {
    return { role: 'nuker', instant: [hide()], fight: [shoot(), meleeFight()] };
}
