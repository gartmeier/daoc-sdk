// The standard Warden: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list already
// heals, buffs and rezzes from whatever the bot knows. What is the class's own:
// - Her pulsing damage add, Nature's Retaliation (Nurture 19, instant, no power, group within 1500): the healer's list has no
//   song(), so it was never cast. `damageAdd` keeps it on, fight or not, and never stops it: song() would play her endurance
//   chant in a fight (songs.ts wantedSongs), and it recast a running pulse whose effect dropped out between pulses, ending it.
// - Her group bladeturn, Nature's Shield (Nurture 18, 4 s, 12 % power, every member within 1250, absorbs one melee hit):
//   buff() keeps it up out of a fight; `bladeturnInFight` puts it back once ours is gone, only while the fight is calm.
// - Group Revigoration (33-41 to everyone, 3 s) through the Druid kit's groupHeal, when four or more each miss most of it.
// - `lastStand`: on her own (no member of hers alive within 2000) with an enemy player on her, she fights as a Warden does:
//   Glowing Blade (Blades side style, 60 % snare 14 s) first, a step to his side when he faces her, a heal on herself once
//   he is out of reach, and while he is snared she gets away, or, as healthy as he is, fights it out. With a member of hers
//   near it does nothing: in a group she heals as before.
// Her single heals are half a Druid's rate (Major Regeneration 136 per 3.2 s), so a line-up with her as its only healer
// starts its heals earlier (groups/hibernia/rvr.ts ownMakeUp). learnings/classes/warden.md says why.

import { headingBetween } from '../index';
import { assist, foeInView, hammeredBy, stopSwinging, type StylePick, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact, MemberReport, Point } from '../group/types';
import { isWet } from '../group/water';
import { groupHeal } from './druid';
import { noteStun, type StunLog } from './hero';
import { kitStyle, type Opener } from './hybrid';

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

// ── Last stand ──

/** Glowing Blade: Blades 10, from his side, a 60 % snare for 14 s. No immunity: again once it has run out. */
export const GLOWING_BLADE: Opener = { name: 'Glowing Blade', lastsMs: 14_000, immuneMs: 0 };
/** Her swing at a player: Glowing Blade first while it isn't on him, the best plain swing behind (Taunting Blade: a taunt's growth is damage). */
export const wardenStyle = (now: () => number = Date.now): StylePick => kitStyle({ openers: [GLOWING_BLADE], now });

/** No other living member of hers in our region within this: she is on her own. */
export const LAST_STAND_ALONE = 2000;
/** An enemy player targeting her within this counts as on her (snared and left behind, he still is). */
export const LAST_STAND_SEEN = 1500;
/** Not snared and this near: she closes and swings (a melee on her is there in 3 s anyway). */
export const LAST_STAND_CHARGE = 750;
/** She heals herself below this % health, only from out of his reach. */
export const LAST_STAND_HEAL_HP = 70;
/** A 3.2 s heal from this far: snared (40 % of 191 u/s) he covers about 250 of it. */
export const HEAL_GAP_SNARED = 450;
/** ... and unsnared at a full run, about 610. */
export const HEAL_GAP = 800;
/** Snared, he at or below this % health: she fights it out whatever her own. */
export const FINISH_HP = 30;
/** A leg away from him while he's snared. */
export const AWAY_LEG = 500;
/** At most one step to his side per this long: his client turns to face her again within about 0.5 s (actions.ts attack). */
export const SIDE_STEP_EVERY_MS = 4000;
/** The side spot this far from him: inside melee reach. */
const SIDE_STEP_RADIUS = 90;

export type LastStandMove = 'swing' | 'heal' | 'away' | null;

/**
 * What she does on her own with an attacker `distance` away (null: the list goes on). Not snared: close and swing within
 * LAST_STAND_CHARGE (Glowing Blade first), else a heal on herself from HEAL_GAP when hurt. Snared by her: a heal from
 * HEAL_GAP_SNARED when hurt; then fight it out while she is as healthy as he is or he is low, else get away.
 */
export function lastStandMove(o: { alone: boolean; distance: number | null; snared: boolean; myHp: number; hisHp: number; canHeal: boolean }): LastStandMove {
    if (!o.alone || o.distance === null) return null;
    const hurt = o.myHp < LAST_STAND_HEAL_HP && o.canHeal;
    if (o.snared) {
        if (hurt && o.distance >= HEAL_GAP_SNARED) return 'heal';
        if (o.myHp >= o.hisHp || o.hisHp <= FINISH_HP) return 'swing';
        return 'away';
    }
    if (o.distance <= LAST_STAND_CHARGE) return 'swing';
    if (hurt && o.distance >= HEAL_GAP) return 'heal';
    return null;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** No other member of hers alive in our region within LAST_STAND_ALONE. */
export function onHerOwn(me: Point & { name: string; regionId: number }, members: readonly MemberReport[]): boolean {
    return !members.some(m => m.name !== me.name && !m.isDead && m.regionId === me.regionId && dist(me, m) <= LAST_STAND_ALONE);
}

/** The nearest enemy player on her: targeting her, seen, alive, free, within LAST_STAND_SEEN. */
export function attackerOn(me: Point & { name: string; regionId: number }, contacts: readonly Contact[]): Contact | null {
    return contacts.filter(c => c.kind === 'player' && !c.isPet && !c.stale && c.hp > 0 && !c.cc && c.target === me.name && c.regionId === me.regionId && dist(me, c) <= LAST_STAND_SEEN)
        .sort((a, b) => dist(me, a) - dist(me, b))[0] ?? null;
}

/** Where she stands round him, in the server's degrees (0 in front of him, 180 behind): StyleProcessor's side is 45-150 and 210-315. */
export function angleOn(him: Point & { heading: number }, me: Point): number {
    return (((headingBetween(him, me) - him.heading) % 4096 + 4096) % 4096) * 360 / 4096;
}

export const atHisSide = (angle: number) => (angle >= 45 && angle <= 150) || (angle >= 210 && angle <= 315);

/** The spot at his side nearer her, SIDE_STEP_RADIUS out, square to his heading. */
export function sideSpot(him: Point & { heading: number }, me: Point): Point {
    const at = (h: number) => {
        const a = (h * 2 * Math.PI) / 4096;
        return { x: Math.round(him.x - Math.sin(a) * SIDE_STEP_RADIUS), y: Math.round(him.y + Math.cos(a) * SIDE_STEP_RADIUS) };
    };
    const left = at((him.heading + 1024) % 4096), right = at((him.heading + 3072) % 4096);
    return dist(me, left) <= dist(me, right) ? left : right;
}

/** A leg AWAY_LEG away from him, the straightest that stays dry (straight, then 45 and 90 degrees off either way); null when all are wet. */
export function awayLeg(me: Point, him: Point, wet: (p: Point) => boolean): Point | null {
    const base = dist(me, him) > 1 ? Math.atan2(me.y - him.y, me.x - him.x) : 0;
    for (const off of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
        const p = { x: Math.round(me.x + Math.cos(base + off) * AWAY_LEG), y: Math.round(me.y + Math.sin(base + off) * AWAY_LEG) };
        if (!wet(p)) return p;
    }
    return null;
}

/** ctx with `him` as the engage's focus: assist swings at whoever the orders name, and on her own that is the one on her. */
function focusedOn(ctx: MemberContext<TacticsSettings>, him: Contact): MemberContext<TacticsSettings> {
    return new Proxy(ctx, {
        get(t, p) {
            // No anchor: on her own no chase leash holds her back (assist's beyondLeash), only the keeps' guards.
            if (p === 'orders') return () => ({ ...t.orders(), phase: 'engage', focus: him.objectId, anchor: undefined });
            if (p === 'focus') return () => t.contact(him.objectId) ?? him;
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

/**
 * Her last stand: on her own (onHerOwn) with an enemy player on her (attackerOn), as lastStandMove says. The swing is the
 * melee list's assist at him, whatever the focus, with wardenStyle. Glowing Blade's landing is read from "You perform your
 * Glowing Blade perfectly!" (noteStun), and while it is due and he faces her she steps to his side, once per
 * SIDE_STEP_EVERY_MS. In the character's instant slot, above flee: flee's kite step was all she did when her partner died
 * (hibernia-s1, 2026-11-12 19:51 UTC, a Highlander: kited into the river and died). The healer's list skips its heals while
 * a melee is on her (castBlocked), so nothing above this takes her turns then.
 */
export function lastStand(o: { now?: () => number; swing?: Behavior<TacticsSettings> } = {}): Behavior<TacticsSettings> {
    const now = o.now ?? Date.now;
    // `swing` for tests: the melee itself is assist's, tested with it.
    const swing = o.swing ?? assist({ melee: true, holdMs: 0, style: wardenStyle(now) });
    const snares: StunLog = new Map();
    return {
        name: 'lastStand',
        interruptible: false,
        async run(ctx) {
            if (ctx.bot.isDead()) return false;
            const me = { ...ctx.me(), name: ctx.name };
            if (!onHerOwn(me, ctx.members())) return false;
            const him = attackerOn(me, ctx.picture().contacts);
            if (!him) return false;
            const state = ctx.sdk.getState();
            if (state) noteStun(snares, state, me.objectId, { [GLOWING_BLADE.name]: GLOWING_BLADE.lastsMs });
            const t = now();
            const snared = t < (snares.get(him.objectId) ?? -Infinity);
            const heal = ctx.spells.heal(me.maxHealth ? me.maxHealth - me.health : undefined);
            const move = lastStandMove({ alone: true, distance: dist(me, him), snared, myHp: me.healthPercent, hisHp: him.hp, canHeal: !!heal });
            if (!move) return false;
            if (move === 'heal') {
                await stopSwinging(ctx);
                ctx.doing('heal', me.objectId, `${heal!.spell.name} on myself, ${him.name} ${snared ? 'snared' : 'not snared'} ${Math.round(dist(me, him))} away`);
                ctx.result('lastStand', await ctx.bot.castSpell(heal!.spell, me.objectId), me.objectId);
                return true;
            }
            if (move === 'away') {
                const to = awayLeg(me, him, p => isWet(me.regionId, p));
                if (!to) return false;
                await stopSwinging(ctx);
                ctx.doing('flee', him.objectId, `away from ${him.name} while Glowing Blade holds him`);
                const w = await ctx.bot.walkTo(to.x, to.y, { z: me.z, tolerance: 40, timeout: 3000 });
                if (!w.success) ctx.result('lastStand', w, him.objectId);
                return true;
            }
            const done = await swing.run(focusedOn(ctx, him));
            const seen = foeInView(ctx, him.objectId);
            const due = !snared && ctx.sdk.getSkills().styles.some(s => s.name === GLOWING_BLADE.name);
            if (due && seen && seen.distance <= 200 && ctx.me().attacking && t - (ctx.memory.get('sideStepAt') ?? 0) >= SIDE_STEP_EVERY_MS && !atHisSide(angleOn(seen, me))) {
                ctx.memory.set('sideStepAt', t);
                const to = sideSpot(seen, me);
                ctx.doing('move', him.objectId, `to ${him.name}'s side for Glowing Blade`);
                await ctx.bot.walkTo(to.x, to.y, { z: me.z, tolerance: 25, timeout: 1200 });
                return true;
            }
            return done;
        },
    };
}

export interface WardenOptions {
    /** groupHeal: how many members (her too) must each miss most of Group Revigoration. */
    groupHealMin?: number;
    /** lastStand on her own: on unless false. */
    lastStand?: boolean;
}

export function warden({ groupHealMin = 4, lastStand: stand = true }: WardenOptions = {}): Character {
    // The damage add first among her idle turns: instant and free, so it costs no heal.
    return { role: 'healer', urgent: [groupHeal(groupHealMin, 25)], react: [damageAdd(), bladeturnInFight()], ...(stand ? { instant: [lastStand()] } : {}) };
}
