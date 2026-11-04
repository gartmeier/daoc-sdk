// How fast a mob comes at us, for the model and for grind. Two questions that err opposite ways: how long a hold on a mob running in
// has to last goes by the slowest it can come, and how much room a cast needs goes by the fastest.

/** The slowest run seen live at full health. */
const MOB_RUN_SPEED = 150;
/** What a cast's room goes by, for a mob not seen running faster. Live 188-198, and half the DB's monsters run above 190 (mob.sql, realm 0, of 92093 spawns: 191 21132, 200 15049, 210 982, 220 1095, 250 797, 335 263, 400 179). */
const MOB_RUN_SPEED_FAST = 220;
/** What a mob's run-in gets on top of its time: an estimate from one reading. */
const MOB_RUN_MARGIN_MS = 2000;
/** Where a mob's swing starts: its melee reach is 200, not a player's 128 (GameLiving.cs:304, AttackComponent.cs:224-230, WeaponAction.cs:399-408). It runs at full speed until inside that (NpcMovementComponent.cs:701-702), and swings on arrival: an out-of-range tick retries every 100 ms (AttackAction.cs:426-432). */
const MOB_MELEE_REACH = 200;
/** What a snapshot's age adds to that: the distance we go by is up to 250 ms old. */
const CAST_ROOM_LAG = 50;

/** A mob's run at this health, at its slowest: below 33 % it slows, to 20 % at none (MaxSpeedCalculator.cs:147-150). */
export function mobRunSpeed(healthPercent: number): number {
    return MOB_RUN_SPEED * Math.min(1, 0.2 + healthPercent / 100 * 2.42);
}

/** How long a mob this far off at this health can take to get to us, in ms, a margin included. A wrong guess costs a mob read as on us for that long, so this errs long. */
export function mobRunInMs(distance: number, healthPercent: number): number {
    return distance / mobRunSpeed(healthPercent) * 1000 + MOB_RUN_MARGIN_MS;
}

/**
 * How far off a mob on its way to us has to be for a cast of this many seconds to go: what it covers by the cast's half way, and its reach. A swing, a miss too, sets a timer of about 3 s, and a cast ends with one still running at its half way (SpellHandler.cs:356-372). A mob that has arrived keeps one running, so what counts is its first swing coming by then. One after the half way doesn't stop it.
 * About 900 for a 5.9 s Simulacrum. An instant cast needs none. `seenSpeed`: what the mob reads now, for one faster than that (a slower reading can come from a walk, and one standing reads 0).
 */
export function castRoom(castTimeSeconds: number, seenSpeed = 0): number {
    return castTimeSeconds > 0 ? Math.max(MOB_RUN_SPEED_FAST, seenSpeed) * castTimeSeconds / 2 + MOB_MELEE_REACH + CAST_ROOM_LAG : 0;
}
