// The standard Thane: a starting point a bot imports into bots/<bot>/character.ts and tunes. roleForClass makes it a
// tank, which keeps Guard on our healer between fights. What is the class's own:
// - The Hero's shield stuns (heroStyle): at Shields 18 a Thane has the same Numb, Stun, Disable and Incapacitate, and a
//   stun stops a cast for certain. Behind them the reacting tank's pick, never a taunt at a player.
// - Toothgrinder's Horn (Stormcalling 20: 49 damage, instant, range 1500, 20 s timer): the shared interrupt() at a casting
//   enemy, as Bragi's Warshriek. Instant, so it costs one turn of the swing.
// - A short-turn fight against players: the plain tank's is one killPlayer of up to 90 s, and nothing above it (the Horn)
//   gets a turn until it ends. Against a player his fight is the melee assist (back about every 400 ms); a monster still
//   gets the tank's, with its taunts.
// learnings/classes/thane.md has the spells, the styles and what is open.

import { assist, interrupt, tank, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { heroStyle } from './hero';

/** The tank's fight for monsters, the melee assist (short turns) for players. Named tank: it is the role's fight. */
export function thaneFight(): Behavior<TacticsSettings> {
    // One stun log for both: a stun landed through either counts against the 60 s immunity.
    const style = heroStyle();
    const monsters = tank({ style });
    const players = assist({ melee: true, holdMs: 0, style });
    return {
        ...monsters,
        name: 'tank',
        async run(ctx) {
            const focus = ctx.focus();
            return (focus?.kind === 'player' ? players : monsters).run(ctx);
        },
    };
}

export function thane(): Character {
    return { role: 'tank', instant: [interrupt()], fight: [thaneFight()] };
}
