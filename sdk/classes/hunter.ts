// The standard Hunter (Midgard): the archers' kit (hide, shoot from range, melee when caught), sdk/classes/archer.ts, and
// its pet the way a hidden Hunter plays it: none out while hidden, the instant summon when it opens or is found.
// A bot imports it into bots/<bot>/character.ts; learnings/classes/hunter.md has the build, the play and what is verified.
//
// The pet (R1 for the user, 2026-11-12 21:00): a pet out beside a hidden Hunter gives it away (live, 20:55: Skadi "Hidden"
// with her hunter's protector 118 off, fighting a bwca). Hunter's Companion/Pet/Ally/Protector cast in 0 s, cost 25 % of
// power, and recast in 120 s, which survives a relog (learnings/pets.md). So:
//  - stowPet: hidden with a pet up, release it.
//  - summonPet (in place of pets.ts summonPet, which withPets then leaves out): only out of stealth and in a fight (our
//    orders engage, we are in combat, or a threat is near): once the first shot has shown us, or someone found us. Never
//    in a quiet turn: a quiet summon would be released at the next hide and cost the 120 s the fight needs.
//  - summonOnTheWayBack (pets.ts, after a release) is left out the same way, for the same reason.
// petControl (pets.ts) still sends the pet where the focus is.
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import { petsAllowed } from '../group/pets';
import { archer } from './archer';

/** A threat this near counts as a fight for the summon. */
export const CALL_NEAR = 1500;
/** After a summon or a release that didn't take, the next try waits this long. */
const RETRY_MS = 5000;

/** What to do with the pet: release it (hidden with one up), call it (shown, in a fight, none up and the summon ready), or nothing. */
export function petMove(o: { hidden: boolean; petUp: boolean; fighting: boolean; summonReady: boolean }): 'stow' | 'call' | null {
    if (o.hidden) return o.petUp ? 'stow' : null;
    return !o.petUp && o.fighting && o.summonReady ? 'call' : null;
}

function fighting(ctx: MemberContext): boolean {
    const me = ctx.me();
    if (ctx.orders().phase === 'engage' || me.inCombat) return true;
    return ctx.threats().some(c => c.regionId === me.regionId && Math.hypot(c.x - me.x, c.y - me.y) <= CALL_NEAR);
}

/** Hidden with a pet up: release it. */
export const stowPet = (): Behavior => ({
    name: 'stowPet',
    interruptible: false,
    async run(ctx) {
        if (!ctx.sdk.isStealthed() || !ctx.sdk.getState()?.pet || ctx.bot.isDead()) return false;
        if (Date.now() < (ctx.memory.get('stowRetry') ?? 0)) return false;
        ctx.doing('release', null, 'hidden: the pet would give us away');
        const r = await ctx.bot.releasePet();
        ctx.result('release', r);
        if (!r.success) ctx.memory.set('stowRetry', Date.now() + RETRY_MS);
        return true;
    },
});

/** Shown and in a fight, no pet: the instant summon. Named summonPet, so withPets leaves pets.ts's own (quiet turns) out. */
export const callPet = (): Behavior => ({
    name: 'summonPet',
    interruptible: false,
    async run(ctx) {
        // undefined: a client from before pets; null: none up.
        if (ctx.sdk.getState()?.pet !== null || ctx.bot.isDead() || ctx.sdk.isStealthed() || !petsAllowed(ctx.settings)) return false;
        if (Date.now() < (ctx.memory.get('callRetry') ?? 0)) return false;
        const sp = ctx.spells.summon();
        const ready = !!sp && sp.castTime === 0 && sp.spell.cooldownRemaining <= 0 && ctx.me().mana >= ctx.spells.powerOf(sp);
        if (petMove({ hidden: false, petUp: false, fighting: fighting(ctx), summonReady: ready }) !== 'call') return false;
        ctx.doing('summon', null, `${sp!.spell.name}: in the fight`);
        const c = await ctx.bot.summonPet(sp!.spell);
        ctx.result('summon', c);
        if (!c.success) ctx.memory.set('callRetry', Date.now() + RETRY_MS);
        return true;
    },
});

/** In place of pets.ts summonOnTheWayBack: no summon walking back from a release, as the next hide would release it. */
const noSummonOnTheWayBack = (): Behavior => ({ name: 'summonOnTheWayBack', interruptible: true, run: async () => false });

export function hunter(): Character {
    const a = archer();
    return { ...a, instant: [...(a.instant ?? []), stowPet(), callPet(), noSummonOnTheWayBack()] };
}
