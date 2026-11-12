// The standard Nightshade (Hibernia): the assassins' kit (hide, lurk, open from stealth, poisons), sdk/classes/stealther.ts,
// with her own Nightshade Magic (sdk/classes/nightshade-magic.ts): the instant Knife of Night to interrupt a cast or finish
// a runner, the 3 s Strike for a low runner past its reach.
// A bot imports it into bots/<bot>/character.ts; learnings/classes/nightshade.md has the build, the play and what is verified.
import type { Character } from '../group/character';
import { nightCast, nightInstant } from './nightshade-magic';
import { stealther } from './stealther';

export function nightshade(): Character {
    const kit = stealther();
    return { ...kit, instant: [...(kit.instant ?? []), nightInstant()], fight: [kit.fight![0]!, nightCast(), ...kit.fight!.slice(1)] };
}
