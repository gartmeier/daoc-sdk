// Fight with a pet: grind summons one if there is none and fights with it, and we print what became of it.
//
//   bun bots/examples/pet.ts <bot> [seconds=60] [name-pattern]
//   bun bots/<bot>/pet.ts [seconds=60] [name-pattern]           (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/pet.ts', args: { seconds: 60, pattern: 'beetle' } })
//
// For a window pet: Cabalist, Spiritmaster, Enchanter, Druid, Hunter, Bonedancer, Necromancer, or a mob charmed
// first (charmPet). A turret needs a ground target, and orders don't reach a Theurgist's pets or a minion, so
// those say so and end, as does a class with no pet at all. Rules: learnings/pets.md.

import { runScript, type ScriptContext } from '../../sdk/runner';
import { scriptArgs } from '../examples/script-args';

interface Args { seconds?: number; pattern?: string }

/** The pet as a line: the window always, its entry only while it is in view. */
const petLine = (sdk: ScriptContext['sdk']): string => {
    const pet = sdk.getPetState();
    if (!pet) return 'no pet';
    const entry = sdk.getPet();
    const where = entry ? `${entry.healthPercent} % health, ${Math.round(entry.distance)} away` : 'out of view';
    return `${pet.name ?? entry?.name ?? `#${pet.objectId}`} (${pet.aggression}, ${pet.walk}): ${where}, fighting ${pet.targetObjectId ?? 'nothing'}`;
};

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const seconds = Number(args.seconds ?? 60);
    const pattern = args.pattern;
    if (bot.isDead()) await bot.releaseAndRespawn();

    // A pet still up from an earlier script, or a charm, stays. Otherwise grind summons the best main one before its first
    // fight and again after a loss. It also answers a mob already on us, which a script ending here would leave swinging at an idle owner.
    if (!sdk.getPetState() && !bot.findSummonSpell('main')) {
        const others = (['turret', 'fnf', 'minion', 'charm'] as const).map(kind => bot.findSummonSpell(kind)?.name).filter(Boolean);
        const why = others.length ? `no main pet spell, only ${others.join(', ')}: see learnings/pets.md` : 'no pet spell';
        console.log(why);
        return { why };
    }
    console.log(`pet: ${petLine(sdk)}`);

    const result = await bot.grind({
        durationMs: seconds * 1000,
        pattern: pattern ? new RegExp(pattern, 'i') : undefined,
        radius: 3000,
        restBelowMana: sdk.getPlayer()!.maxMana > 0 ? 30 : undefined,
        respawn: true,
        pet: true,   // the pet fights and we stand off; { fight: 'both' } swings too
        onKill: (kill, stats) => console.log(`  #${stats.kills} ${kill.message}, pet: ${petLine(sdk)}`),   // the message names the mob also for a kill the pet made while we looked elsewhere
    });
    // The message ends in the run's note on the pet: "; our pet died with X at 17 %, and it is coming for us".
    console.log(result.message);
    console.log(`pet: ${petLine(sdk)}`);
    return {
        kills: result.kills, failures: result.failures, deaths: result.deaths, xp: result.xpGained, stopReason: result.stopReason,
        message: result.message, reason: result.reason,
        pet: sdk.getPetState(), lastPetLoss: result.lastPetLoss, calledOff: result.calledOff, stillFighting: result.stillFighting,
    };
};

export default main;

if (import.meta.main) {
    const [seconds = '60', pattern] = scriptArgs();
    await runScript(main, { args: { seconds: Number(seconds), pattern }, timeout: Number(seconds) * 1000 + 120_000 });
}
