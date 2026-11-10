// The standard Berserker: a starting point a bot imports into bots/<bot>/character.ts and tunes. roleForClass makes it
// melee, and the melee list already swings at the focus with fighterStyle. What is the class's own:
// - Its Left Axe chain: Ravager (anytime) -> Atrophy (60 % snare) -> Scathing Blade (attack speed -21 %). fighterStyle
//   ranks plain styles by growth per endurance alone and takes Ruiner (Hammer, 8.0) over Ravager (7.0), so the chain,
//   whose follow-ups are worth 13 and 19, never starts. berserkerStyle swings the opener of the best chain instead.
// - No taunts at a player (Snowblind and Provoke taunt; a player has no threat table): the Skald kit's stylesFor.
// - Berserk (ability 4 at 24): 20 s of critical hits on every swing, 7 minutes to reuse, and no parry, evade or block while
//   it lasts (BerserkAbilityHandler.cs). berserk() spends it on a focus that is going down, with few on him.
// learnings/classes/berserker.md has the styles, the server code and what is open.

import { assist, foeInView, type StylePick, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { canWield, fighterStyle, procUnknown, raisesThreat, shedsThreat } from '../group/styles';
import { roleOf } from '../group/tactics/focus-role';
import type { Contact } from '../group/types';
import type { Style } from '../types';
import { stylesFor } from './skald';

const known = (s: Style) => !!s.details && !s.details.stealth && !procUnknown(s);
/** An anytime style with no opening to meet: what pickStyle calls a plain style. */
const anytime = (s: Style) => known(s) && s.details!.opening === 'offensive' && !s.details!.result && !s.details!.openingStyle;

/**
 * The plain style that opens the best chain we can swing: an anytime style (no taunt, no detaunt) that one of our styles
 * follows, ranked by its follow-up's damage growth. Null when none has a follow-up.
 */
export function chainOpener(styles: readonly Style[]): Style | null {
    const ours = styles.filter(known);
    const follow = (s: Style) => ours.filter(f => f.details!.openingStyle === s.name).sort((a, b) => b.details!.openingDamage - a.details!.openingDamage)[0];
    return ours
        .filter(s => anytime(s) && !raisesThreat(s) && !shedsThreat(s) && !!follow(s))
        .sort((a, b) => follow(b)!.details!.openingDamage - follow(a)!.details!.openingDamage)[0] ?? null;
}

/**
 * fighterStyle's queue with the chain's opener as the plain style: the same reactions, follow-ups and positionals first
 * (pickStyle puts a follow-up of the style that just landed ahead of everything), only the anytime swing behind them changes.
 */
export function withChain(queue: readonly string[], styles: readonly Style[]): string[] {
    if (!queue.length) return [...queue];
    const opener = chainOpener(styles);
    const last = styles.find(s => s.name === queue.at(-1));
    if (!opener || !last || !anytime(last) || queue.includes(opener.name)) return [...queue];
    return [...queue.slice(0, -1), opener.name];
}

const fighter = fighterStyle();
const names = (q: ReturnType<StylePick>): string[] => (q === null || q === undefined ? [] : typeof q === 'string' ? [q] : [...q as string[]]);

/** fighterStyle without taunts at players, and the Left Axe chain's opener as its plain style. */
export const berserkerStyle: StylePick = seen => {
    const styles = stylesFor(seen.styles, seen.target.kind === 'player').filter(s => canWield(s, seen.state.equipment));
    return withChain(names(fighter({ ...seen, styles })), styles);
};

// ── Berserk ──

/** Its reuse (BerserkAbilityHandler: 7 minutes). findAbility lists it while it waits, so the kit keeps its own clock. */
export const BERSERK_REUSE_MS = 420_000;
/** After a try the server refused: not again for this long. */
const BERSERK_RETRY_MS = 10_000;
/** The focus must be this near (melee, with a step), ... */
const BERSERK_REACH = 250;
/** ... going down: under this % health, or this % for a healer or caster, ... */
const BERSERK_FOCUS_HP = 60;
const BERSERK_SOFT_HP = 75;
/** ... with him above this % himself, and at most this many enemies swinging at him lately: 20 s without parry or evade. */
const BERSERK_MY_HP = 50;
const BERSERK_MAX_ON_ME = 1;

/** Whether now is the time for Berserk, from what he sees. */
export function berserkNow(o: { focus: Contact | null; distance: number | null; myHp: number; onMe: number; readyAt: number; now: number }): boolean {
    const f = o.focus;
    if (!f || f.kind !== 'player' || f.cc || o.distance === null || o.distance > BERSERK_REACH) return false;
    if (o.now < o.readyAt || o.myHp <= BERSERK_MY_HP || o.onMe > BERSERK_MAX_ON_ME) return false;
    const role = roleOf(f);
    return f.hp < BERSERK_FOCUS_HP || ((role === 'healer' || role === 'caster' || role === 'cc') && f.hp < BERSERK_SOFT_HP);
}

/** Enemies whose melee swings hit at `me` within the last 8 s. */
const swingersOn = (events: readonly { kind: string; attackerObjectId?: number | null; targetObjectId?: number | null; receivedAt: number }[], me: number, now: number) =>
    new Set(events.filter(e => e.kind === 'melee' && e.targetObjectId === me && e.attackerObjectId && now - e.receivedAt <= 8000).map(e => e.attackerObjectId)).size;

/** Berserk on a focus that berserkNow says is going down. An instant: one turn, and the swing goes on the next. */
export const berserk = (): Behavior<TacticsSettings> => ({
    name: 'berserk',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || typeof o.focus !== 'number') return false;
        const now = Date.now();
        const readyAt: number = ctx.memory.get('berserkReadyAt') ?? 0;
        if (now < readyAt || !ctx.sdk.findAbility(/^Berserk/i)) return false;
        const me = ctx.me();
        const seen = foeInView(ctx, o.focus);
        const ok = berserkNow({
            focus: ctx.focus() ?? null, distance: seen?.distance ?? null, myHp: me.healthPercent,
            onMe: swingersOn(ctx.sdk.getState()?.combatEvents ?? [], me.objectId, now), readyAt, now,
        });
        if (!ok) return false;
        ctx.memory.set('berserkReadyAt', now + BERSERK_RETRY_MS);
        ctx.doing('berserk', o.focus, 'Berserk');
        const r = await ctx.bot.useAbility(/^Berserk/i);
        ctx.result('berserk', r, o.focus);
        if (r.success) ctx.memory.set('berserkReadyAt', now + BERSERK_REUSE_MS);
        return true;
    },
});

export function berserker(): Character {
    return { role: 'melee', instant: [berserk()], fight: [assist({ melee: true, holdMs: 0, style: berserkerStyle })] };
}
