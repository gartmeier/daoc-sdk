// The first blow on a crowd-controlled enemy. Any swing breaks a mezz, a miss too (GameLiving.cs:1700-1704), so the one
// that does should count: a style, best one that stuns or snares, so the target neither runs nor hits back when it wakes.
// A mezzed or stunned target doesn't turn, so a side or back style is in reach: walk round first. The user, playing Niamh
// (2026-11-14, 10:04 UTC, hibernia): Fiacra's mezz on a Briton, the pick-off, and Laoghaire, Fionn and Cuchulainn broke it
// with plain swings. "When it's mezzed: get close and open with a style, best with a snare or a stun."
//
// One member opens: the one who claims it (activity 'open'), else the nearest melee bot. The other melee wait a short way
// off, swinging nothing, and on a mezz everyone else holds too (ccHolds: nukes, pets) until it is broken, OPEN_WAIT_MS at
// most. The opener stands in reach, faces it and only then queues: the server clears a style queued out of reach in
// 250 ms (AttackAction.PrepareMeleeAttack), and a style sent while not swinging starts the swing itself with the style
// already queued (StyleProcessor.TryToUseStyle), so the first swing is that style.

import { canWield, procUnknown, raisesThreat, shedsThreat, styleValue } from './styles';
import { ccImmuneTo } from './cc';
import { headingBetween } from '../index';
import type { MemberContext } from './member';
import type { Contact, MemberReport, Point } from './types';
import type { InventoryItem, NearbyNpc, NearbyPlayer, Style } from '../types';

/** Where the opener stands from the target: inside melee reach (AttackRange 128, MELEE_APPROACH 90). */
export const OPEN_REACH = 80;
/** Close enough to swing from where we stand. */
const SWING_REACH = 110;
/** The others wait this far off: a step from a swing once it is broken. */
export const OPEN_WAIT_RANGE = 300;
/** A claim this old no longer holds anyone, and everyone holds for the opener at most this long. */
export const OPEN_WAIT_MS = 10_000;
/** After this long walking round, the opener swings what fires from where it stands. */
export const OPEN_WALK_MS = 5000;
/** A melee member this far from it is none to wait for. */
const OPENER_REACH = 2500;
/** How long the opener watches for its swing: a slow two-hander's round is about 4.5 s. */
const SWING_WATCH_MS = 5000;

export type ProcKind = 'stun' | 'snare' | null;

/** What a style's proc does to the target, in the server's words (StunSpellHandler, SpeedDecreaseSpellHandler ShortDescription). */
export function procKind(s: Style): ProcKind {
    const text = s.details?.procSpell?.description ?? '';
    if (/is stunned/i.test(text)) return 'stun';
    if (/is slowed by|rooted in place/i.test(text)) return 'snare';
    return null;
}

/** A style with no opening to meet: it fires on any swing that lands. */
const anytime = (s: Style) => s.details!.opening === 'offensive' && !s.details!.result && !s.details!.openingStyle;

export interface Opener {
    /** The queue: the opener, and behind it a style that fires wherever we stand, or the one alone when it needs no spot. */
    queue: string[];
    /** Where the first needs us: 'side', 'back' or 'front' of the target; null for anywhere. */
    position: 'side' | 'back' | 'front' | null;
    /** What its proc does. */
    proc: ProcKind;
}

/**
 * The opener on a crowd-controlled target, best first: a stun (unless it's immune to one), then a snare, then the most
 * damage; at each, a positional (it can't turn) before an anytime style. A positional only with an anytime backup, so a
 * spot not met still swings a style. Reactions and follow-ups can't open, and a detaunt hits for nothing. Null without one.
 */
export function openerFor(styles: readonly Style[], equipment: readonly Pick<InventoryItem, 'slot' | 'objectType'>[], endurancePercent: number, o: { stunImmune?: boolean } = {}): Opener | null {
    const usable = styles.filter(s => s.details && !s.details.stealth && !procUnknown(s) && !shedsThreat(s) && canWield(s, equipment) && endurancePercent >= s.details.fatigue);
    const proc = (s: Style): ProcKind => { const k = procKind(s); return k === 'stun' && o.stunImmune ? null : k; };
    const rank = (s: Style) => (proc(s) === 'stun' ? 2 : proc(s) === 'snare' ? 1 : 0);
    // A taunt last: a melee wants no threat, and on a player it is only its damage.
    const backups = usable.filter(anytime).sort((a, b) => rank(b) - rank(a) || Number(raisesThreat(a)) - Number(raisesThreat(b)) || styleValue(b) - styleValue(a));
    const backup = backups[0];
    const firsts = usable.filter(s => anytime(s) || (s.details!.opening === 'positional' && s.details!.position && backup))
        .sort((a, b) => rank(b) - rank(a) || Number(b.details!.opening === 'positional') - Number(a.details!.opening === 'positional') || Number(raisesThreat(a)) - Number(raisesThreat(b)) || b.details!.openingDamage - a.details!.openingDamage);
    const first = firsts[0];
    if (!first) return null;
    const position = first.details!.opening === 'positional' ? first.details!.position : null;
    return { queue: position && backup ? [first.name, backup.name] : [first.name], position, proc: proc(first) };
}

/** Where `me` stands as the target sees it, in degrees off its heading, 0..360 (GameObject.GetAngle). */
export function angleOff(target: Point & { heading: number }, me: Point): number {
    return ((((headingBetween(target, me) - target.heading) % 4096) + 4096) % 4096) * 360 / 4096;
}

/** The server's cones (StyleProcessor.cs:89-110). */
export function standsAt(angle: number): 'front' | 'side' | 'back' {
    if (angle > 150 && angle < 210) return 'back';
    if ((angle >= 45 && angle <= 150) || (angle >= 210 && angle <= 315)) return 'side';
    return 'front';
}

/** The spot OPEN_REACH from the target that meets `position`, the nearer side for 'side'. */
export function openSpot(target: Point & { heading: number }, position: 'side' | 'back' | 'front', me: Point): Point {
    const at = (h: number) => {
        const a = (h * 2 * Math.PI) / 4096;
        return { x: Math.round(target.x - Math.sin(a) * OPEN_REACH), y: Math.round(target.y + Math.cos(a) * OPEN_REACH) };
    };
    if (position === 'front') return at(target.heading);
    if (position === 'back') return at((target.heading + 2048) % 4096);
    const left = at((target.heading + 1024) % 4096), right = at((target.heading + 3072) % 4096);
    return Math.hypot(me.x - left.x, me.y - left.y) <= Math.hypot(me.x - right.x, me.y - right.y) ? left : right;
}

/** The crowd control the opener is for: a mezz or a stun. A root leaves it free to swing at the front. */
export const openable = (c: Pick<Contact, 'cc'> | null | undefined): boolean => !!c?.cc && (c.cc.kind === 'mezz' || c.cc.kind === 'stun');

const meleeBot = (m: MemberReport) => !m.observed && !m.isDead && (m.role === 'melee' || m.role === 'tank');

/**
 * Who opens on `c`: a member claiming it (activity 'open' on it within OPEN_WAIT_MS, the earliest), else the nearest melee
 * bot within OPENER_REACH of it (by name on a tie). Null with none.
 */
export function openerOf(members: readonly MemberReport[], c: Contact, now = Date.now()): string | null {
    const near = members.filter(m => meleeBot(m) && m.regionId === c.regionId && Math.hypot(m.x - c.x, m.y - c.y) <= OPENER_REACH);
    const claims = near.filter(m => m.activity.kind === 'open' && m.activity.targetId === c.objectId && now - m.activity.since < OPEN_WAIT_MS)
        .sort((a, b) => a.activity.since - b.activity.since || a.name.localeCompare(b.name));
    if (claims[0]) return claims[0].name;
    const d = (m: MemberReport) => Math.hypot(m.x - c.x, m.y - c.y);
    return near.sort((a, b) => d(a) - d(b) || a.name.localeCompare(b.name))[0]?.name ?? null;
}

/** When this member first saw `c` crowd-controlled as a target to open on: the wait for the opener counts from it. */
function firstSeen(ctx: MemberContext, c: Contact, now: number): number {
    const seen: Map<string, number> = ctx.memory.get('ccOpenSeen') ?? new Map();
    ctx.memory.set('ccOpenSeen', seen);
    const key = `${c.objectId}:${c.firstSeen}:${c.cc?.by}:${c.cc?.until}`;
    for (const [k, at] of seen) if (now - at > 60_000) seen.delete(k);
    if (!seen.has(key)) seen.set(key, now);
    return seen.get(key)!;
}

/**
 * Whether we keep our hands off `c` for someone else's opener: a mezz on it, unbroken, a melee bot to open on it that
 * isn't us, within OPEN_WAIT_MS of when we first saw it so. A stun breaks on nothing: there the nukes go in at once.
 */
export function waitForOpener(ctx: MemberContext, c: Contact, now = Date.now()): boolean {
    if (c.cc?.kind !== 'mezz') return false;
    const by = openerOf(ctx.members(), c, now);
    if (!by || by === ctx.name) return false;
    return now - firstSeen(ctx, c, now) < OPEN_WAIT_MS;
}

/** We have opened on it, by key, with when. */
function opened(ctx: MemberContext): Map<string, number> {
    const m: Map<string, number> = ctx.memory.get('ccOpened') ?? new Map();
    ctx.memory.set('ccOpened', m);
    return m;
}

/**
 * A melee member's turn at a crowd-controlled focus `c`, before its swing: the opener walks round to its spot, faces it
 * and queues the opener; another melee member waits OPEN_WAIT_RANGE off, swinging nothing. 'acted' when the turn went on
 * that, `{ wait }` with the reason when we hold, null when it's none of ours: not mezzed or stunned, already opened on by
 * us, or no opener we can swing (then the plain path goes on).
 */
export async function openOnCc(ctx: MemberContext, c: Contact): Promise<'acted' | { wait: string } | null> {
    if (!openable(c)) return null;
    const now = Date.now();
    const key = `${c.objectId}:${c.firstSeen}`;
    const done = opened(ctx);
    for (const [k, at] of done) if (now - at > 60_000) done.delete(k);
    if ((done.get(key) ?? 0) >= now - 15_000) return null;
    const since = firstSeen(ctx, c, now);
    if (now - since >= OPEN_WAIT_MS) return null;
    const view: NearbyNpc | NearbyPlayer | null = ctx.sdk.getNearbyNpc(c.objectId) ?? ctx.sdk.getNearbyPlayer(c.objectId);
    if (!view) return null;
    const me = ctx.me();
    const by = openerOf(ctx.members(), c, now);
    if (by && by !== ctx.name) {
        // A mezz waits for it. On a stun it would only hold our swing back.
        if (c.cc!.kind !== 'mezz') return null;
        if (me.attacking) await ctx.sdk.sendAttack(false);
        if (view.distance > OPEN_WAIT_RANGE + 50) {
            ctx.doing('move', c.objectId, `up to the mezzed ${c.name}, ${by} opens`);
            // Aim 50 inside, so the walk's tolerance ends it inside the 350 that counts as there.
            const f = (view.distance - (OPEN_WAIT_RANGE - 50)) / view.distance;
            await ctx.bot.walkTo(me.x + (view.x - me.x) * f, me.y + (view.y - me.y) * f, { z: view.z, tolerance: 40, timeout: 3000 });
            return 'acted';
        }
        return { wait: `${by} opens on the mezzed ${c.name}` };
    }
    const state = ctx.sdk.getState();
    if (!state) return null;
    const op = openerFor(ctx.sdk.getSkills().styles ?? [], state.equipment, me.endurancePercent, { stunImmune: ccImmuneTo(c, 'stun', now) });
    if (!op) return null;
    const detail = `opener ${op.queue.join(' / ')} on the ${c.cc!.kind === 'mezz' ? 'mezzed' : 'stunned'} ${c.name}`;
    const walkedSince: number = ctx.memory.get(`ccOpenWalk:${key}`) ?? now;
    ctx.memory.set(`ccOpenWalk:${key}`, walkedSince);
    // Long enough round: what fires from here.
    const roundTooLong = now - walkedSince > OPEN_WALK_MS;
    const queue = op.position && roundTooLong ? op.queue.slice(1) : op.queue;
    const where = op.position && !roundTooLong ? op.position : null;
    const placed = where ? standsAt(angleOff(view, me)) === where : true;
    if (me.attacking && me.targetObjectId !== c.objectId) await ctx.sdk.sendAttack(false);
    if (!placed || view.distance > SWING_REACH) {
        ctx.doing('open', c.objectId, detail);
        const to = where ? openSpot(view, where, me) : null;
        const w = to
            ? await ctx.bot.walkTo(to.x, to.y, { z: view.z, tolerance: 20, timeout: 3000 })
            : await ctx.bot.walkToObject(view, { range: OPEN_REACH, timeout: 3000 });
        if (!w.success && w.reason !== 'timeout') ctx.result('opener', w, c.objectId);
        return 'acted';
    }
    if (!queue.length) return null;
    ctx.doing('open', c.objectId, detail);
    if (state.movement.moving) await ctx.sdk.sendStop();
    if (me.targetObjectId !== c.objectId) await ctx.sdk.sendSetTarget(c.objectId);
    await ctx.sdk.sendFaceObject(c.objectId);
    const before = state.combatEvents.findLast(e => e.kind === 'melee' && e.attackerObjectId === me.objectId)?.id ?? null;
    const sendQueue = async () => {
        const styles = ctx.sdk.getSkills().styles ?? [];
        for (const name of queue) {
            const s = styles.find(x => x.name === name);
            if (s) await ctx.sdk.sendUseSkill(s.skillIndex);
        }
    };
    const watchSwing = async (from: number | null, msgFrom: number) => {
        const swing = await ctx.sdk.waitForCondition(st => {
            const e = st.combatEvents.findLast(x => x.kind === 'melee' && x.attackerObjectId === me.objectId);
            return !!e && e.id !== from && e.targetObjectId === c.objectId;
        }, SWING_WATCH_MS).catch((e: unknown) => { if (/timed out/.test(String((e as Error)?.message))) return null; throw e; });
        const fresh = (ctx.sdk.getState()?.gameMessages ?? []).filter(m => m.id > msgFrom);
        const performed = fresh.filter(m => /^You perform your /.test(m.text)).at(-1)?.text;
        const landed = performed && queue.some(n => performed.includes(`your ${n} perfectly`)) ? /your (.+?) perfectly/.exec(performed)![1]! : null;
        const absorbed = fresh.some(m => BLADETURN.test(m.text));
        const id = swing?.combatEvents.findLast(x => x.kind === 'melee' && x.attackerObjectId === me.objectId)?.id ?? from;
        return { swing: !!swing, landed, absorbed, id, msgTop: Math.max(msgFrom, ...fresh.map(m => m.id)) };
    };
    const msg0 = Math.max(0, ...state.gameMessages.map(m => m.id));
    await sendQueue();
    done.set(key, now);
    ctx.memory.delete(`ccOpenWalk:${key}`);
    let r = await watchSwing(before, msg0);
    let how = r.landed ? `${r.landed} landed` : r.absorbed ? 'absorbed by a bladeturn' : r.swing ? 'swung, no style' : 'no swing seen';
    // A bladeturn took the blow, and the mezz with it (live 11:15:41, Cathbad on Enid). The swing emptied the server's
    // queue: the same opener again at once, so the next swing stuns the target that just woke, if it is still in reach.
    if (r.absorbed && r.swing) {
        await sendQueue();
        r = await watchSwing(r.id, r.msgTop);
        how += r.landed ? `, then ${r.landed} landed` : r.swing ? ', then swung, no style' : ', no second swing';
    }
    ctx.note(`opener on ${c.name}: ${how} (${queue.join(' / ')})`);
    return 'acted';
}

/** Our swing taken by the target's bladeturn (live, Cathbad's Stunning Blade on a Cleric, 2026-11-14 11:15:41). */
const BLADETURN = /^Your strike was absorbed by a magical barrier/;
