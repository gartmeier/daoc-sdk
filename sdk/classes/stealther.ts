// The assassin kit, shared by the Infiltrator, the Nightshade and the Shadowblade (learnings/classes/infiltrator.md,
// nightshade.md, shadowblade.md). roleForClass makes them melee; what is theirs:
//
// - hide: out of a fight they stay hidden (bot.stealth, a click on the Stealth spec). The server refuses for 10 s after
//   combat ("You've been in combat recently"), within 1024 - 896 x stealth / level of an enemy (about 128 at 24 with
//   Stealth 19 + 5 from gear), and 2 s after the last toggle (StealthSpecHandler.cs). Hidden they move at 115 of 191.
// - ambush: on the squad's focus, from stealth, only a soft or lone target: a healer, caster or crowd controller by the
//   class read (or its deeds), one with no other enemy player within LONE_RADIUS of it, or one already under half health.
//   Anything else they leave to the rest and stay hidden near the fight (lurk), as the stealthers in Thidranki do.
// - The opener: Perforate Artery (Critical Strike 21) from the front, Backstab II (10) or Backstab (2) from behind
//   (styles.json: openingRequirementValue 2 front, 0 back; the server's cones in StyleProcessor.cs:81-110: back
//   150-210 degrees, side 45-150 and 210-315, front the rest). The opener is the style click alone, in reach and facing:
//   a style used out of attack mode starts the attack itself (StyleProcessor.cs:159-160), whose first swing is the
//   opener, and attack mode unstealths one tick later (AttackComponent.cs:626-637) "to allow any potential opener".
//   An attack request of our own after it re-sends the target, and a target change in attack mode unstealths at once
//   (PlayerTargetHandler.cs:58-60): the opener then fails ("You fail to execute your Backstab II perfectly!").
//   Any blow taken ends stealth too (GameLiving.cs:1449-1453), so a hidden walk past an enemy that swings is lost.
//   Verified live 2026-11-11 on a Hitback Dummy: Backstab II from behind "perfectly", +158 damage and its stun.
// - After the opener the role's own assist goes on (fighterStyle; stealth styles are never its pick). Leaving a fight
//   that turned is the squad's (sdk/group/squad.ts flee), and once out of combat hide hides again.

import { foeInView, meleeFight } from '../group/behaviors';
import { isAlive } from '../group/blackboard';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import { roleOf } from '../group/tactics/focus-role';
import type { Contact } from '../group/types';
import { headingBetween } from '../index';
import type { NearbyNpc, NearbyPlayer, Style } from '../types';

/** An enemy player within this of the focus makes it no lone target. */
export const LONE_RADIUS = 1000;
/** Under this % health the focus is worth the opener whatever it is. */
export const SOFT_HP = 50;
/** The server's melee reach is 128 plus both bodies (AttackComponent.AttackRange); the opener goes from inside this. */
export const OPENER_REACH = 110;
/** Where the walk aims, in front of or behind the target. */
const STAND_OFF = 70;
/** After a refusal for combat, the next try no sooner. */
const HIDE_RETRY_MS = 3000;
/** The client's inCombat ends 8 s after the last blow, the server's 10 s (GameLiving.cs:31): wait the difference too. */
const AFTER_COMBAT_MS = 2500;

export type Side = 'front' | 'side' | 'back';

/** Where `me` stands as the target sees it, in degrees off its heading, 0..360 (GameObject.GetAngle). */
export function angleFrom(target: { x: number; y: number; heading: number }, me: { x: number; y: number }): number {
    const rel = (((headingBetween(target, me) - target.heading) % 4096) + 4096) % 4096;
    return (rel * 360) / 4096;
}

/** The server's cones (StyleProcessor.cs:89-110). */
export function sideOf(angle: number): Side {
    if (angle > 150 && angle < 210) return 'back';
    if ((angle >= 45 && angle <= 150) || (angle >= 210 && angle <= 315)) return 'side';
    return 'front';
}

/** The stealth openers we know, by the side they need: the best of each. */
export function openers(styles: readonly Style[]): { front: Style | null; back: Style | null } {
    const byName = (n: string) => styles.find(s => s.name === n) ?? null;
    return { front: byName('Perforate Artery'), back: byName('Backstab II') ?? byName('Backstab') };
}

/** The opener for where we stand, or null when we must walk round first. */
export function openerFor(styles: readonly Style[], side: Side): Style | null {
    const o = openers(styles);
    return side === 'front' ? o.front : side === 'back' ? o.back : null;
}

/** The side to walk to: the front when Perforate Artery is ours (a target facing its own fight faces away from us less often), else behind. */
export function sideToTake(styles: readonly Style[]): 'front' | 'back' | null {
    const o = openers(styles);
    return o.front ? 'front' : o.back ? 'back' : null;
}

/** A point STAND_OFF in front of or behind a target, along its heading (headingBetween's inverse). */
export function standPoint(target: { x: number; y: number; heading: number }, side: 'front' | 'back', off = STAND_OFF): { x: number; y: number } {
    const t = (target.heading * Math.PI) / 2048;
    const s = side === 'front' ? 1 : -1;
    return { x: Math.round(target.x - Math.sin(t) * off * s), y: Math.round(target.y + Math.cos(t) * off * s) };
}

/** Worth an opener: soft by role, alone, or going down. By the class read and deeds, never by who it is. */
export function softTarget(focus: Contact, contacts: readonly Contact[]): boolean {
    const role = roleOf(focus);
    if (role === 'healer' || role === 'caster' || role === 'cc') return true;
    if (focus.hp < SOFT_HP) return true;
    return !contacts.some(c => c.objectId !== focus.objectId && c.kind === 'player' && isAlive(c) && !c.stale && c.regionId === focus.regionId && Math.hypot(c.x - focus.x, c.y - focus.y) <= LONE_RADIUS);
}

/** Hide when out of a fight. An instant: one click, false at once when there is nothing to do. */
export const hide = (): Behavior => ({
    name: 'hide',
    interruptible: false,
    async run(ctx) {
        const me = ctx.me();
        if (me.isDead || ctx.sdk.isStealthed() || !ctx.sdk.findSpecialization('Stealth')) return false;
        const now = Date.now();
        if (me.inCombat || me.attacking) { ctx.memory.set('hideCombatAt', now); return false; }
        if (now - (ctx.memory.get('hideCombatAt') ?? 0) < AFTER_COMBAT_MS) return false;
        if (now < (ctx.memory.get('hideRetryAt') ?? 0)) return false;
        ctx.doing('hide');
        const r = await ctx.bot.stealth();
        ctx.result('hide', r);
        if (!r.success) ctx.memory.set('hideRetryAt', Date.now() + (r.retryAfterMs ?? HIDE_RETRY_MS));
        return true;
    },
});

/**
 * From stealth on the focus: lurk by a hard target, else walk to its front (or back) and open. Not hidden: false, and
 * the role's assist fights as ever.
 */
export const ambush = (): Behavior => ({
    name: 'ambush',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || typeof o.focus !== 'number' || !ctx.sdk.isStealthed()) return false;
        const focus = ctx.focus();
        if (!focus || !isAlive(focus)) return false;
        const seen = foeInView(ctx, focus.objectId);
        if (!softTarget(focus, ctx.picture().contacts)) {
            ctx.doing('lurk', focus.objectId, 'hidden, not a soft target');
            await Bun.sleep(500);
            return true;
        }
        // Others see it and we don't: assist closes in, hidden as we are (a walk keeps the stealth).
        if (!seen) return false;
        return open(ctx, seen);
    },
});

async function open(ctx: MemberContext, target: NearbyNpc | NearbyPlayer): Promise<boolean> {
    const styles = ctx.sdk.getSkills().styles;
    const want = sideToTake(styles);
    if (!want) return false;
    const me = ctx.me();
    const side = sideOf(angleFrom(target, me));
    const style = openerFor(styles, side);
    if (!style || target.distance > OPENER_REACH) {
        // A target that moves turns its front with it: one short leg a turn, re-aimed.
        const to = standPoint(target, style ? side as 'front' | 'back' : want);
        ctx.doing('move', target.objectId, `hidden, to its ${style ? side : want}`);
        await ctx.bot.walkTo(to.x, to.y, { tolerance: 30, timeout: 2500 });
        return true;
    }
    ctx.doing('opener', target.objectId, style.name);
    const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
    if (ctx.me().targetObjectId !== target.objectId) await ctx.sdk.sendSetTarget(target.objectId);
    await ctx.sdk.sendFaceObject(target.objectId);
    const a = await ctx.sdk.sendUseSkill(style.skillIndex);
    ctx.memory.set('styleAt', Date.now());
    ctx.memory.set('openedAt', Date.now());
    const said = () => ctx.sdk.getGameMessages().filter(m => m.id > since && (m.text.includes(style.name) || /no longer hidden/i.test(m.text)));
    // "You perform your X perfectly!" or "You fail to execute your X perfectly!", with the first swing.
    await ctx.sdk.waitForCondition(() => said().some(m => /perfectly/i.test(m.text)), 3500).catch(() => null);
    const line = said().find(m => /perfectly/i.test(m.text))?.text ?? said().at(-1)?.text;
    ctx.result('opener', { success: a.success && /^You perform/i.test(line ?? ''), message: line ?? a.message }, target.objectId);
    return true;
}

/** The kit: hide above flee, the ambush ahead of the role's assist. */
export function stealther(): Character {
    return { role: 'melee', instant: [hide()], fight: [ambush(), meleeFight()] };
}
