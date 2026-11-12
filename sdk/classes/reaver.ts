// The standard Reaver: a starting point a bot imports into bots/<bot>/character.ts and tunes. Albion's flex-and-shield
// melee with Soulrending magic: roleForClass makes it melee. What is the class's own:
// - `reaverStyle` (kitStyle, sdk/classes/hybrid.ts): at a player, Disable first once per stun immunity (shield, from the
//   side, 4 s), with the fighter's choice behind it. The fighter's reactions bring Viper after a block (Flexible, 5 s stun,
//   then Copperhead's attack slow) and Kingsnake after a parry (then Tigersnake); a stun of any of these starts the same
//   immunity. The plain swing at a player is Diamondback (115 growth for 10: a taunt, and a taunt's growth is damage).
// - `interruptWith(['Lifedrain'])` (instant, above flee): the shared interrupt() with Vitality Siphon (52 damage that heals
//   him, instant, range 1000, 30 s) counted as an interrupt beside direct damage.
// - `surge`: Surge of Maiming (+8.1 damage add, 30 s, 150 s to reuse) in the engage with the focus in reach. Spellbook.buffs()
//   leaves a self buff whose timer is longer than it lasts out, so buff() doesn't spend it on a trip.
// - `aura`: Demolishing Aura, a pulse (19 damage to every enemy within 350 of him every 6 s, 8 power a pulse, until cast
//   again). Started when two enemy players stand within 300 and nothing near is crowd-controlled (anything hostile but a
//   mezz wakes a mezzed neighbour, GameLiving.cs:1716-1727), stopped when the fight ends, cc comes near or nobody is in reach.
// - `keepProc`: Credit to Arawn (damage proc, 20 minutes) between fights: buff() has no slot for procs.
// learnings/classes/reaver.md says why, and what is open.

import { type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { assist } from '../group/behaviors';
import type { Contact } from '../group/types';
import { HERO_STUNS } from './hero';
import { combatBuff, interruptWith, keepSelfBuff, kitStyle, stunOpener, waitOf } from './hybrid';

/** Disable's stun (4 s); Viper (5 s), Stun (3 s) and Numb (2 s) start the same immunity. */
export const REAVER_OPENER = stunOpener('Disable', HERO_STUNS.Disable!, { Viper: 5000, Stun: HERO_STUNS.Stun!, Numb: HERO_STUNS.Numb! });

export const reaverStyle = kitStyle({ openers: [REAVER_OPENER] });

export const surge = () => combatBuff({ name: 'surge', want: s => s.type === 'DamageAdd' });
export const keepProc = () => keepSelfBuff({ name: 'keepProc', types: ['OffensiveProc'] });

/** Enemy players this near count for the aura (it reaches 350; a step of slack). */
export const AURA_REACH = 300;
/** Crowd control this near holds the aura back: its 350 and a mezzed enemy walking in. */
export const AURA_CC_CLEAR = 700;
/** A running aura stops once no enemy player is this near. */
export const AURA_KEEP = 450;

const near = (me: { x: number; y: number; regionId: number }, c: Contact, d: number) => c.regionId === me.regionId && !c.stale && Math.hypot(c.x - me.x, c.y - me.y) <= d;
const players = (contacts: readonly Contact[]) => contacts.filter(c => c.kind === 'player' && !c.isPet && c.hp > 0);

/** Whether to start the aura: at least two enemy players in reach, and no crowd-controlled enemy near. */
export function auraNow(me: { x: number; y: number; regionId: number }, contacts: readonly Contact[]): boolean {
    if (contacts.some(c => c.cc && near(me, c, AURA_CC_CLEAR))) return false;
    return players(contacts).filter(c => near(me, c, AURA_REACH)).length >= 2;
}

/** Whether a running aura should stop: out of an engage, crowd control near, or no enemy player left in its reach. */
export function auraStop(me: { x: number; y: number; regionId: number }, contacts: readonly Contact[], engaged: boolean): boolean {
    if (!engaged) return true;
    if (contacts.some(c => c.cc && near(me, c, AURA_CC_CLEAR))) return true;
    return !players(contacts).some(c => near(me, c, AURA_KEEP));
}

/**
 * Demolishing Aura is a pulse (live 2026-11-12: a second cast came back pulse_cancelled): one cast hits every enemy within
 * 350 every 6 s for 8 power a pulse until it is cast again or the power runs out. So it starts when auraNow says so and is
 * cast again to stop it when auraStop does. Whether it runs is the kit's own memory (on after a start, off after a cancel):
 * live it didn't show among his effects. A stop that started it instead (the power had run out and ended it) is a start,
 * and the next turn stops it.
 */
export const aura = (): Behavior<TacticsSettings> => ({
    name: 'aura',
    interruptible: false,
    async run(ctx) {
        const now = Date.now();
        if (now < (ctx.memory.get('auraAt') ?? 0)) return false;
        const me = ctx.me();
        const sp = ctx.spells.all()
            .filter(s => s.type === 'DirectDamage' && s.target === 'Enemy' && s.range === 0 && s.radius > 0 && s.castTime === 0 && s.pulse)
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp) return false;
        const effects = new Set((ctx.sdk.getState()?.effects ?? []).map(e => e.name));
        // Dead, it ended with him.
        if (me.isDead) ctx.memory.set('auraRunning', false);
        const running: boolean = ctx.memory.get('auraRunning') === true || effects.has(sp.spell.name);
        const contacts = ctx.picture().contacts;
        const engaged = ctx.orders().phase === 'engage';
        if (running) {
            if (!auraStop(me, contacts, engaged)) return false;
            ctx.doing('aura', null, `stop ${sp.spell.name}`);
            const r = await ctx.bot.castSpell(sp.spell);
            const stopped = r.reason === 'pulse_cancelled';
            ctx.memory.set('auraRunning', !stopped && r.success);
            ctx.result('auraStop', stopped ? { success: true } : r);
            ctx.memory.set('auraAt', Date.now() + 1500);
            return true;
        }
        if (!engaged || sp.spell.cooldownRemaining > 0 || (me.mana ?? 0) < ctx.spells.powerOf(sp) * 3 || !auraNow(me, contacts)) return false;
        ctx.doing('aura', null, sp.spell.name);
        const r = await ctx.bot.castSpell(sp.spell);
        // pulse_cancelled here: it was running after all, and is off now.
        ctx.memory.set('auraRunning', r.success);
        ctx.result('aura', r);
        ctx.memory.set('auraAt', Date.now() + (r.success || r.reason === 'pulse_cancelled' ? 1500 : waitOf(r.message) ?? 8000));
        return true;
    },
});

export function reaver(): Character {
    return {
        role: 'melee',
        instant: [interruptWith(['Lifedrain'])],
        react: [surge(), aura()],
        fight: [assist({ melee: true, holdMs: 0, style: reaverStyle })],
        chores: [keepProc()],
    };
}
