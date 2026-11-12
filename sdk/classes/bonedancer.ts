// The standard Bonedancer: a starting point a bot imports into bots/<bot>/character.ts and tunes. The commander is a
// window pet, so the group's pet behaviours keep it up, heal it, buff it and send it at the focus (sdk/group/pets.ts).
// What is the class's own is the minion under the commander: a Chieftan (Bone Army 15, character level) holds one, from
// 30 two. Nothing in the group summons it, so this kit does, between fights. The nukes are the nuker's: an instant
// lifedrain (Suppression) is picked under fire by assist itself. A build with no instant gives ground under a melee instead
// (theurgist.ts giveGround). learnings/classes/bonedancer.md has the runs.

import { buffRetryMs, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import { nukerFight, quickcastUnderFire } from './cabalist';
import { summonClear, waiting } from './summoner';
import { giveGround } from './theurgist';

/** Which minion to raise: damage (a caster, then an archer, then a melee one) or heal (a patcher, which heals the commander). */
export type MinionKind = 'damage' | 'heal';

export interface BonedancerOptions {
    /** The minion under the commander (minionPick). 'damage' by default: a group has its own healer. */
    minion?: MinionKind | false;
    /** No nukes below this % power. 0 (the default): no floor. */
    saveBelow?: number;
}

/** What each minion does, by the name of its summon (spell.sql, Bone Army / Bone Mystics / Bone Guardians; CommanderPet.cs). */
export function minionRole(name: string): 'caster' | 'archer' | 'melee' | 'healer' | 'other' {
    if (/bone ?(mage|caster|jinxer|weaver|breaker)/i.test(name)) return 'caster';
    if (/bone ?(dart|arrow|archer)/i.test(name)) return 'archer';
    if (/bone ?(smasher|crusher|razer|cleaver)/i.test(name)) return 'melee';
    if (/bone ?(patcher|fixer|sentry|patroller|mender)/i.test(name)) return 'healer';
    return 'other';
}

const ORDER: Record<MinionKind, readonly string[]> = {
    damage: ['caster', 'archer', 'melee', 'healer', 'other'],
    heal: ['healer', 'caster', 'archer', 'melee', 'other'],
};

/** The minion summon to cast: of the kind wanted, the highest level, else the next kind. Null with none. */
export function minionPick(spells: readonly SpellPick[], kind: MinionKind): SpellPick | null {
    const minions = spells.filter(s => s.type === 'SummonMinion');
    for (const role of ORDER[kind]) {
        const top = minions.filter(s => minionRole(s.spell.name) === role).sort((a, b) => b.spell.level - a.spell.level)[0];
        if (top) return top;
    }
    return null;
}

/** How many minions a commander of a Bonedancer of this level holds: one at 15 (Chieftan), two at 30, three at 45 (CommanderPet.cs:84-102). */
export const minionRoom = (level: number): number => (level >= 45 ? 3 : level >= 30 ? 2 : level >= 15 ? 1 : 0);

/** A summon costs 20 % of the pool, 24 % with no focus item (worstPowerCost): with this much there is something left for the fight. */
export const MINION_MANA = 40;
/** After a refusal or a failed cast. */
const MINION_RETRY_MS = 15_000;
/** The server's answer when the commander is full: wait for a new commander. */
const FULL = /already has as many followers/i;

/**
 * The minion, between fights: a commander up, room under it (minionRoom, less the minions up: state.summons, as a Bonedancer
 * has no other pet without a window), nothing hostile near (a 6 s cast), MINION_MANA. A new commander comes with none.
 */
export const summonMinion = (kind: MinionKind = 'damage'): Behavior<TacticsSettings> => ({
    name: 'summonMinion',
    interruptible: false,
    async run(ctx) {
        const state = ctx.sdk.getState();
        const pet = state?.pet;
        if (!pet) return false;
        const me = ctx.me();
        if ((state?.summons?.length ?? 0) >= minionRoom(me.level)) return false;
        // A full commander answers so until it is another one.
        if (ctx.memory.get('minionFullOn') === pet.objectId) return false;
        if (waiting(ctx.memory, 'minionRetry') || !summonClear(ctx)) return false;
        const sp = minionPick(ctx.spells.all(), kind);
        if (!sp || sp.spell.cooldownRemaining > 0) return false;
        if (me.manaPercent < MINION_MANA || me.mana < ctx.spells.powerOf(sp)) return false;
        ctx.doing('summon', null, sp.spell.name);
        const c = await ctx.bot.summonPet(sp.spell);
        ctx.result('summon', c);
        if (!c.success) {
            if (FULL.test(c.message ?? '')) ctx.memory.set('minionFullOn', pet.objectId);
            ctx.memory.set('minionRetry', Date.now() + Math.max(MINION_RETRY_MS, buffRetryMs(c)));
        }
        return true;
    },
});

/** giveGround (theurgist.ts) only with no instant nuke ready: a Suppression build lifedrains its attacker instead, as assist picks under fire. */
export const giveGroundUnlessInstant = (): Behavior<TacticsSettings> => {
    const give = giveGround();
    return { ...give, run: ctx => (ctx.spells.nuke({ instant: true }) ? false : give.run(ctx)) };
};

export function bonedancer({ minion = 'damage', saveBelow = 0 }: BonedancerOptions = {}): Character {
    return {
        role: 'nuker',
        instant: [quickcastUnderFire()],
        react: [giveGroundUnlessInstant()],
        fight: nukerFight(saveBelow, true),
        ...(minion ? { chores: [summonMinion(minion)] } : {}),
    };
}
