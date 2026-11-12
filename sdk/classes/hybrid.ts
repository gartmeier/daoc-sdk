// What the six melee and song kits of 2026-11-12 share (Mercenary, Reaver, Savage, Champion, Valewalker, Minstrel).
// Each kit file says what is its class's own; learnings/classes/<class>.md has the why.
//
// - `kitStyle`: fighterStyle (follow-ups, reactions, a positional while the target is on someone else), an opener of
//   the class's own first at a player (a stun once per immunity, a snare once it has run out), and at a player the
//   plain swing worth most per endurance with taunt styles counted. A taunt's growth is style damage like any other's
//   (StyleProcessor.cs:360-363 applies GrowthRate whatever the proc), and a player has no threat table, so against one a
//   taunt style is just a damage style. Champion's Celtic Fury (117 growth for 10), Valewalker's Taunting Scythe (118),
//   Savage's Wild Call (173), Mercenary's Inflame (114) and Reaver's Diamondback (115) are each line's best anytime swing.
//   Monsters keep fighterStyle's rule: no taunt while the mob is on someone else.
// - `combatBuff`: a self buff that lasts a fight, not a trip (Valewalker's haste, Reaver's Surge, Savage's Kelgor buffs),
//   cast in the engage with the focus in reach. Spellbook.buffs() leaves these out (spells.ts), so buff() doesn't spend
//   them between fights.
// - `snareFocus`: an instant snare on a focus player out of melee reach (Champion's Lumber, Valewalker's Conceal Path).
// - `debuffFocus`: an instant debuff on the focus, once per its duration (Champion's Enervation on a melee).
// - `interruptWith`: the shared interrupt() with more instant spells counted as interrupts (Reaver's lifedrain).
// - `keepSelfBuff`: a long self buff buff() has no slot for (a weapon proc), kept up between fights.

import { foeInView, interrupt, QUIET_PHASES, type StylePick, type TacticsSettings } from '../group/behaviors';
import type { Behavior, MemberContext } from '../group/member';
import { canWield, fighterStyle, foeLastResult, lastStyleLanded, procUnknown, shedsThreat, STYLE_RULES, styleValue } from '../group/styles';
import type { SpellPick } from '../group/spells';
import { roleOf } from '../group/tactics/focus-role';
import type { Style } from '../types';
import { noteStun, STUN_IMMUNE_MS, type StunLog } from './hero';

const known = (s: Style) => !!s.details && !s.details.stealth && !procUnknown(s);
/** An anytime style: no opening to meet. */
export const isPlain = (s: Style) => known(s) && s.details!.opening === 'offensive' && !s.details!.result && !s.details!.openingStyle;

/** The plain swing worth most per endurance at a player, taunts counted, detaunts not (their growth is 0). Null when none is worth STYLE_RULES.minValue. */
export function bestPlain(styles: readonly Style[]): Style | null {
    return styles.filter(s => isPlain(s) && !shedsThreat(s) && styleValue(s) >= STYLE_RULES.minValue).sort((a, b) => styleValue(b) - styleValue(a))[0] ?? null;
}

/**
 * At a player: the queue's plain swing becomes the best one (taunts counted), or the best is added behind a lone conditional
 * style, or swung alone. Below the endurance fighterStyle saves, nothing is added. Two at most: the server keeps a first style and a backup.
 */
export function withPlayerPlain(queue: readonly string[], styles: readonly Style[], endurancePercent: number): string[] {
    if (endurancePercent < STYLE_RULES.saveEndurance) return [...queue];
    const best = bestPlain(styles);
    if (!best || queue.includes(best.name)) return [...queue];
    const last = styles.find(s => s.name === queue.at(-1));
    if (last && isPlain(last)) return styleValue(last) >= styleValue(best) ? [...queue] : [...queue.slice(0, -1), best.name];
    return queue.length >= 2 ? [...queue] : [...queue, best.name];
}

/** An opener a kit puts first at a player: the style, how long its effect lasts, and how long after that it can't land again. */
export interface Opener {
    name: string;
    lastsMs: number;
    /** A stun's immunity (STUN_IMMUNE_MS); 0 for a snare, which can go on again once it ends. */
    immuneMs: number;
    /** Other styles of ours whose effect starts the same immunity, with their lengths (a reaction's or follow-up's stun). */
    others?: Readonly<Record<string, number>>;
}

const names = (q: ReturnType<StylePick>): string[] => (q === null || q === undefined ? [] : typeof q === 'string' ? [q] : [...q as string[]]);

/**
 * fighterStyle with the class's openers first at a player and withPlayerPlain behind. An opener goes first while it can
 * land (by our own log of what landed, as the Hero kit's stuns), with a backup the server swings when the opener's position
 * isn't met: the base queue's first choice when that one is certain (a follow-up of what just landed, a reaction to what the
 * foe just did), else its plain swing. No backup, no opener: a conditional style alone would fail and cost.
 */
export function kitStyle(o: { openers?: readonly Opener[]; now?: () => number; base?: StylePick } = {}): StylePick {
    const now = o.now ?? Date.now;
    const base = o.base ?? fighterStyle();
    const openers = o.openers ?? [];
    // One log per opener: a stun and a snare don't share an immunity.
    const logs = new Map(openers.map(x => [x.name, new Map() as StunLog]));
    return seen => {
        const { target, player, state } = seen;
        const styles = seen.styles.filter(s => canWield(s, state.equipment));
        for (const x of openers) noteStun(logs.get(x.name)!, state, player.objectId, { ...x.others, [x.name]: x.lastsMs });
        const atPlayer = target.kind === 'player';
        let q = names(base({ ...seen, styles }));
        if (atPlayer) q = withPlayerPlain(q, styles, player.endurancePercent);
        if (!atPlayer || !q.length) return q;
        const first = styles.find(s => s.name === q[0]);
        const foeDid = foeLastResult(state, target.objectId, player.objectId);
        const certain = !!first?.details && (first.details.openingStyle === lastStyleLanded(state, player.objectId) && !!first.details.openingStyle
            || first.details.opening === 'defensive' && !!first.details.result && first.details.result === foeDid);
        const backup = certain || q.length === 1 ? q[0]! : q.at(-1)!;
        for (const x of openers) {
            const s = styles.find(st => st.name === x.name);
            if (!s || player.endurancePercent < s.details!.fatigue) continue;
            if (now() < (logs.get(x.name)!.get(target.objectId) ?? -Infinity) + x.immuneMs) continue;
            return backup === x.name ? [x.name] : [x.name, backup];
        }
        return q;
    };
}

/** A stun opener: lasts `ms`, then the server's 60 s immunity. */
export const stunOpener = (name: string, ms: number, others: Readonly<Record<string, number>> = {}): Opener => ({ name, lastsMs: ms, immuneMs: STUN_IMMUNE_MS, others });

// ── Behaviours ──

const MELEE_REACH = 350;

/** The focus in view, alive, with its distance; null outside an engage. */
function engagedFocus(ctx: MemberContext<TacticsSettings>) {
    const o = ctx.orders();
    if (o.phase !== 'engage' || typeof o.focus !== 'number') return null;
    const seen = foeInView(ctx, o.focus);
    if (!seen || ('isDead' in seen && seen.isDead)) return null;
    return { id: o.focus, distance: seen.distance, contact: ctx.focus() };
}

/** We can pay for it now: health-cost spells (a Savage's) need no power. */
function affordable(ctx: MemberContext<TacticsSettings>, s: SpellPick): boolean {
    if (s.spell.cooldownRemaining > 0) return false;
    if (/^Savage/.test(s.type)) return true;
    return (ctx.me().mana ?? 0) >= ctx.spells.powerOf(s);
}

/** The top rank of each spell `want` takes, highest level first. */
function topRanks(picks: readonly SpellPick[]): SpellPick[] {
    const top = new Map<string, SpellPick>();
    for (const s of picks) if (!top.has(s.type) || top.get(s.type)!.spell.level < s.spell.level) top.set(s.type, s);
    return [...top.values()];
}

/** The wait a refusal names ("You must wait 1 minute 7 seconds"), in ms, or null. */
export function waitOf(message: string | undefined): number | null {
    const m = /must wait (?:(\d+) minutes? ?)?(?:(\d+) seconds?)?/i.exec(message ?? '');
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + 1) * 1000;
}

/** Whether a self combat buff goes on now: in an engage, the focus within `reach`, health above `minHp`, not on us already. */
export function combatBuffNow(o: { engaged: boolean; distance: number | null; reach: number; hp: number; minHp: number; on: boolean; readyAt: number; now: number }): boolean {
    return o.engaged && o.distance !== null && o.distance <= o.reach && o.hp > o.minHp && !o.on && o.now >= o.readyAt;
}

/**
 * Self buffs that last a fight: the top rank of each spell `want` takes, cast in an engage with the focus within `reach`
 * and our health above `minHp` (a Savage pays in health), when its effect isn't on us. Instants only; one per turn.
 */
export const combatBuff = (o: { name: string; want: (s: SpellPick) => boolean; reach?: number; minHp?: number }): Behavior<TacticsSettings> => ({
    name: o.name,
    interruptible: false,
    async run(ctx) {
        const f = engagedFocus(ctx);
        const now = Date.now();
        const retry: Map<string, number> = ctx.memory.get(`${o.name}Retry`) ?? new Map();
        ctx.memory.set(`${o.name}Retry`, retry);
        const on = new Set((ctx.sdk.getState()?.effects ?? []).map(e => e.name));
        const me = ctx.me();
        for (const s of topRanks(ctx.spells.all().filter(s => s.target === 'Self' && s.castTime === 0 && o.want(s)))) {
            if (!combatBuffNow({ engaged: !!f, distance: f?.distance ?? null, reach: o.reach ?? MELEE_REACH, hp: me.healthPercent, minHp: o.minHp ?? 0, on: on.has(s.spell.name), readyAt: retry.get(s.spell.name) ?? 0, now })) continue;
            if (!affordable(ctx, s)) continue;
            ctx.doing('buff', null, s.spell.name);
            const r = await ctx.bot.castSpell(s.spell);
            ctx.result(o.name, r);
            // Its effect shows on the next snapshot: a short wait before looking again, a longer one after a refusal.
            retry.set(s.spell.name, Date.now() + (r.success ? 2000 : waitOf(r.message) ?? 10_000));
            return true;
        }
        return false;
    },
});

/** Distance past which a focus counts as running from our melee. */
export const SNARE_FROM = 450;

/** Whether to snare the focus: a free player out of melee reach and within the spell's range, not snared by us lately. */
export function snareNow(o: { focus: { kind: string; cc?: unknown; stale?: boolean } | null | undefined; distance: number | null; range: number; until: number; now: number }): boolean {
    const f = o.focus;
    if (!f || f.kind !== 'player' || f.cc || f.stale || o.distance === null) return false;
    return o.distance > SNARE_FROM && o.distance <= o.range && o.now >= o.until;
}

/** An instant snare (SpeedDecrease, single target) on the focus when snareNow says so; again once it has run out. */
export const snareFocus = (): Behavior<TacticsSettings> => ({
    name: 'snareFocus',
    interruptible: false,
    async run(ctx) {
        const f = engagedFocus(ctx);
        if (!f) return false;
        const snared: Map<number, number> = ctx.memory.get('snaredUntil') ?? new Map();
        ctx.memory.set('snaredUntil', snared);
        const now = Date.now();
        const sp = ctx.spells.all()
            .filter(s => s.type === 'SpeedDecrease' && s.target === 'Enemy' && s.radius === 0 && s.castTime === 0 && affordable(ctx, s))
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp || !snareNow({ focus: f.contact, distance: f.distance, range: sp.range, until: snared.get(f.id) ?? 0, now })) return false;
        ctx.doing('snare', f.id, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, f.id, { approach: false });
        const missed = !c.success || c.resisted || c.effectImmune || c.effectLanded === false;
        // Landed: until it runs out, less a margin. Missed: another try in 4 s.
        snared.set(f.id, Date.now() + (missed ? 4000 : Math.max(5000, sp.duration * 1000 - 3000)));
        ctx.result('snare', missed && c.success ? { ...c, success: false, reason: c.resisted ? 'resisted' : c.effectImmune ? 'immune' : 'no_effect' } : c, f.id);
        return true;
    },
});

/**
 * An instant debuff of `type` on the focus player whose role `roles` names (classGuess, or what it was seen doing), within
 * range and not crowd-controlled; once per its duration per target, by our own casts (the client sees no effect on others).
 */
export const debuffFocus = (o: { name: string; type: string; roles: readonly string[]; minHp?: number }): Behavior<TacticsSettings> => ({
    name: o.name,
    interruptible: false,
    async run(ctx) {
        const f = engagedFocus(ctx);
        const c = f?.contact;
        if (!f || !c || c.kind !== 'player' || c.cc || c.hp <= (o.minHp ?? 30)) return false;
        const role = roleOf(c);
        if (!role || !o.roles.includes(role)) return false;
        const on: Map<number, number> = ctx.memory.get(`${o.name}Until`) ?? new Map();
        ctx.memory.set(`${o.name}Until`, on);
        const now = Date.now();
        if (now < (on.get(f.id) ?? 0)) return false;
        const sp = ctx.spells.all()
            .filter(s => s.type === o.type && s.target === 'Enemy' && s.radius === 0 && s.castTime === 0 && s.range >= f.distance && affordable(ctx, s))
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp) return false;
        ctx.doing('debuff', f.id, sp.spell.name);
        const r = await ctx.bot.castSpell(sp.spell, f.id, { approach: false });
        const missed = !r.success || r.resisted || r.effectImmune;
        on.set(f.id, Date.now() + (missed ? 6000 : Math.max(10_000, sp.duration * 1000 - 5000)));
        ctx.result('debuff', r, f.id);
        return true;
    },
});

/** Instant single-target spells of these types, ready now, for interruptWith. */
export function moreInterrupts(picks: readonly SpellPick[], types: readonly string[], ready: (s: SpellPick) => boolean): SpellPick[] {
    return picks.filter(s => types.includes(s.type) && s.target === 'Enemy' && s.castTime === 0 && s.range > 0 && s.radius === 0 && ready(s));
}

/**
 * The shared interrupt(), with instants of `types` counted as interrupts beside Spellbook.interrupts()'s own (a lifedrain
 * hurts like a direct damage spell, and damage interrupts a cast: GameLiving.StartInterruptTimer). Same ranks, same walk rules.
 */
export function interruptWith(types: readonly string[]): Behavior<TacticsSettings> {
    const inner = interrupt();
    return {
        ...inner,
        run(ctx) {
            const book = ctx.spells;
            const ready = (s: SpellPick) => affordable(ctx, s);
            const spells = new Proxy(book, {
                get(t, p) {
                    if (p === 'interrupts') return () => [...t.interrupts(), ...moreInterrupts(t.all(), types, ready)].sort((a, b) => b.range - a.range || b.spell.level - a.spell.level);
                    const v = Reflect.get(t, p, t);
                    return typeof v === 'function' ? v.bind(t) : v;
                },
            });
            const proxied = new Proxy(ctx, {
                get(t, p) {
                    if (p === 'spells') return spells;
                    const v = Reflect.get(t, p, t);
                    return typeof v === 'function' ? v.bind(t) : v;
                },
            });
            return inner.run(proxied);
        },
    };
}

/**
 * A long self buff of a type buff() keeps no slot for (a weapon proc: OffensiveProc, DefensiveProc), cast between fights
 * when its effect isn't on us; the top rank of each type `types` names.
 */
export const keepSelfBuff = (o: { name: string; types: readonly string[] }): Behavior<TacticsSettings> => ({
    name: o.name,
    interruptible: false,
    async run(ctx) {
        const phase = ctx.orders().phase;
        // A 3 s cast: only while the group stands, as buff() does.
        if (!QUIET_PHASES.has(phase) || ctx.threats().length) return false;
        const now = Date.now();
        if (now < (ctx.memory.get(`${o.name}At`) ?? 0)) return false;
        const on = new Set((ctx.sdk.getState()?.effects ?? []).map(e => e.name));
        const s = topRanks(ctx.spells.all().filter(s => o.types.includes(s.type) && s.target === 'Self')).find(s => !on.has(s.spell.name) && affordable(ctx, s));
        if (!s) return false;
        ctx.doing('buff', null, s.spell.name);
        const r = await ctx.bot.castSpell(s.spell);
        ctx.result('buff', r);
        ctx.memory.set(`${o.name}At`, Date.now() + (r.success ? 5000 : 30_000));
        return true;
    },
});
