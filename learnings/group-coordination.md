# Group coordination

Several bots playing as one group: they share what they see, a coordinator decides the group's plan, each member carries it out with its own class logic, and an observer scores every run so the next strategy is better. The code is in `sdk/group/` (import from `../../sdk/group`); group folders live in `groups/<name>/`.

Verified live with a five-player Hibernian group (Hero, Druid, Bard, Mentalist, Enchanter, levels 5–7, Shannon Estuary), over about a dozen runs of 1–4 minutes.

## Quick start

```sh
bun groups/create-group.ts hibernia cuchulainn brigid oisin niamh ciaran   # groups/hibernia/: group.json, strategy.ts, hunt.ts, lab_log.md
bun client/swarm.ts cuchulainn brigid oisin niamh ciaran                   # every member needs a running client (one process for all)
bun sdk/group/cli.ts hibernia                                              # look: members, load, enemies and who sees them (observe only)
bun groups/hibernia/hunt.ts 180                                            # hunt 3 min, then read groups/hibernia/runs/<stamp>.md
```

- **Roles** come from each bot.env `CLASS` (Hero → tank, Druid → healer, Bard → support, Mentalist/Enchanter → nuker; `roleForClass`). Override per member in group.json (`{ "bot": "oisin", "role": "healer" }`) or with `--role=oisin:healer` at creation.
- **Flags** of hunt.ts become settings for that run only: `bun groups/hibernia/hunt.ts 120 --holdMs=3000 --ready.mana=40`.
- **MCP:** `execute_code({ bot_name: 'cuchulainn', script: 'groups/hibernia/hunt.ts', args: { seconds: 180 }, timeout: 7 })`. The MCP bot is used as one member; the others get their own control connections. Verified live.
- **One controller per bot still holds:** a group run takes control of every member. A single-bot script or MCP call on a member pre-empts the group run, and the run stops with `BotPreemptedError`. `sdk/group/cli.ts` only observes.
- **A run ends** `seconds` after the group formed: no new pulls, the current fight and a pull under way are finished (up to 60 s), then everyone stops. Each run writes `runs/<stamp>.md` (report), `.json`, `.log` (full log) and a line in `runs/history.jsonl`.

## The four parts

```
member clients ──snapshots──▶ MemberAgent ──observeState──▶ Blackboard (shared picture)
                                   ▲                              │  │
                         behaviours│(own sdk + picture)    picture│  │events
                                   │                              ▼  ▼
                              orders ◀──decide()── Coordinator    GroupObserver ──▶ runs/<stamp>.md
```

### 1. Shared awareness (`Blackboard`)

- Every member publishes a **report** (position, health, power, load, target, effects, capabilities, current activity) and its **sightings** (monsters it could fight and enemy-realm players within 3000) on every snapshot, about 4 times a second.
- The blackboard merges sightings into **contacts**: freshest position wins, `seenBy` lists who sees it now, `target` resolves its target to a member name.
- **Knowledge is partial and ages:** a contact nobody sees turns `stale` after 5 s and is forgotten after 60 s. It is dropped at once when a member standing near its last position no longer sees it. Live, mudmen east of Mag Mell were seen only by the two Lurikeen standing on that side.
- **`threat` is sticky:** a contact is a threat for 4 s after it last targeted a member, swung, or was attacked by one. Needed because an NPC's target field flickers between snapshots; without it the coordinator flapped between engage and recover mid-fight, members sat down, and the group lost three members to one water beetle.
- **Claims:** a member's activity (`heal` on X, `cc` on Y) is visible to the others, so two healers don't heal the same target and two mezzers don't mezz the same add. `markCc` records a mezz until it expires or the mob swings again.
- Deaths of monsters come from the client's death events; a kill event fires only for a mob the group fought. Object ids are reused, so a died id is ignored for 20 s, not forever.

### 2. Coordinator (`Coordinator` + `strategy.decide`)

Runs `decide()` every 500 ms on the picture and writes **orders**: `phase`, `anchor` (rally point), `facing`, `focus` (assist target), `puller`, `cc` assignments, `retreatTo`, `waiting` (who the group waits for, and why) and a `reason`. Only material changes (phase, focus, puller, cc, a move over 300) bump `seq`, get logged with `»`, and interrupt members.

The PvE leveling policy (`decidePve`):

| Phase | When |
|---|---|
| `engage` | anything is a threat. Keeps the focus while it lives (no target thrash); else what the tank hits, else whatever is on a non-tank. Adds go to crowd control: mezzers first (support, then nukers), then roots (the healer) |
| `retreat` | off by default (`retreat.enabled`). When on: the tank is dead, 3+ adds (not the focus) are neither controlled nor assigned to a mezzer, 2+ members are dead, or the tank is under 25 % while the focus has over half. Runs 2500 away from the attackers until nothing follows (max 25 s) |
| `travel` | most of the group is far from the base. Legs of 1500 along a route around every aggro zone (`safePath`); the next leg once everyone is within 1200 of this one (or after 30 s) |
| `gather` | a few members are away from the base |
| `recover` | someone is dead (waiting for release and return) or below `ready.hp` / `ready.mana` |
| `pull` | everyone is ready: the tank body-pulls the best target (highest con in the window, nearest to the base) |
| `idle` | nothing to pull; the reason lists why each monster was rejected (`3 con -3, 22 near aggressive mobs, 4 too far`). Moves the base after 25 s, picks another camp after 2 min |

- **Camp and base** come from static spawn data (`findCamp`, `chooseBase`): the densest cluster of spawns in the group's level band, and open ground next to it away from danger.
- **Aggro is per spawn, not per name** (`aggroAt`): the same name is passive in one camp and aggressive in another. Using the name's maximum, as the first version did, rejected every target at a passive camp.

### 3. Members and behaviours (`MemberAgent`, `behaviors.ts`)

A member runs its role's **behaviour list** top to bottom every turn; the first one that acts wins. Reactions sit above orders, chores below:

| Role | Behaviours (in order) |
|---|---|
| tank | release, retreat, pull, tank, guard, shedLoad, holdFormation, buff, rest |
| healer | release, retreat, emergencyHeal, flee, heal, crowdControl (assigned), position, shedLoad, holdFormation, buff, rest |
| support | release, retreat, emergencyHeal, flee, crowdControl, heal, position, shedLoad, holdFormation, buff, rest |
| nuker | release, retreat, flee, crowdControl (assigned), emergencyHeal, position, assist, shedLoad, holdFormation, buff, rest |
| melee | release, retreat, assistMelee, shedLoad, holdFormation, buff, rest |

- A behaviour sees its own character in full (`ctx.bot`, `ctx.sdk`) and everyone else only through the picture (`ctx.members()`, `ctx.tank()`, `ctx.threats()`, `ctx.focus()`). That keeps the information honest.
- **Routes avoid aggressive mobs** (`safePath`, used for travel legs, by members more than 2500 from their slot, and by `groups/hibernia/town.ts`):
  - A mob aggroes only on players it doesn't con grey to (`StandardMobBrain.CanAggroTarget`: "Only attack if green+ to target"), and only within its aggro range, mostly 500 (`CheckPlayerAggro`).
  - `aggroZones(region, level)` is every aggressive spawn not grey to the group's lowest level, out to its aggro range plus 300 (`AGGRO_PAD`, mobs wander). At level 11 in region 200 that is about 11,000 circles.
  - The route is a grid A* (400-unit cells) where a cell inside a zone costs 30× more, so it crosses a zone only when there's no way around. Planning takes 5–40 ms.
  - Before this, routes only avoided mobs 3+ levels up or packs of 4+ at or above the group's level. At level 11 the route to the next camp ran through aggressive lunantishee (L8–9, blue), and every fight on the way brought adds.
- **Capabilities come from spells** (`Spellbook`): `heal()`, `mezz()`, `cc()` (a mezz when one is ready, else a root: SpeedDecrease with value 99, e.g. the Druid's Webbing Vines), `nuke({ dotted })` (each DoT once per mob, then direct damage; area spells only with `aoe`, they break mezz), `buffs()` (top rank per buff slot and target kind, with the slot from `slotOf(type)`).
- **Buffs by plan** (`buffs.ts`, used by the `buff` behaviour in quiet phases). Each role needs slots in priority order (`BUFF_NEEDS`, setting `buffNeeds`):
  - tank: everything but acuity;
  - healers and support: AF, Con, Dex, Str/Con, Dex/Qui;
  - casters: Con, Dex, Str/Con, Dex/Qui, acuity, plus AF and an absorb "bubble" from their own spells only (`BUFF_SELF_ONLY`).

  Who provides a slot:
  - the target itself first, when it can (casters' self AF, the Druid's own base buffs);
  - else the support (Bard/Warden) for base buffs, the healer (Druid) for spec buffs and the rest.

  Each caster works through its tasks in rounds: every member's first buff it can get (tank first), then every member's second, and so on, within its concentration. Retries:
  - after a failed cast, 8 s (out of range, interrupted) or 5 min (out of concentration);
  - after a success, 20 s, until the effect shows in the target's report.

  When a task lacks concentration, the caster first drops its own concentration buffs that are outside its plan (`sdk.sendRemoveConcentrationEffect(index)`, client opcode 0x76). Rules from a Hibernia player; replaced "first caster of a spell name owns it", which left an Enchanter without his own Powerbarrier because the Mentalist "owned" it.
  - Concentration buffs on others stay up until dropped, the caster dies, or the target is beyond `concentration_buff_range` (5000).
  - Concentration list names are cut to ~12 characters plus "..".
- **Songs** (`songs.ts`, the `song` behaviour in the support list after heals and crowd control):
  - Server rules: a Bard plays one song at a time. A new song ends the running one (`CancelIncompatiblePulseEffects`), and casting the running song again stops it ("You stop playing your song.").
  - So songs are not buffs: `song` never re-casts the song that's playing, and waits 10 s after a cast for the effect to show.
  - Choice: speed while travelling; endurance while pulling and fighting (the tank's styles); between fights, power when a caster is below 70 % (`songs.powerBelow`), health when someone is below 80 %, else endurance.
  - Hibernian Bard at level 9: Clear Path (speed), Rhythm of Hibernia (endurance), Chant of Healing (health). Power (Rhyme of Earth and up) comes later in Music. All take 3 s to cast and can be cast on the move.
  - Verified live: speed on every travel leg, endurance while gathering and fighting. A song is kept at least `songs.holdMs` (30 s) except into a fight, because short idle/travel hops made it flap.
- **Roaming can walk the group into aggressive mobs:** once the camp is out of targets, `decidePve` moves the base to a random spot within 900 of the camp every `roamMs`, without checking aggressive spawns. At a passive camp next to an aggressive one this caused a wipe (6 adds). Set `roamMs` high and let `newCampMs` pick another camp instead.
- **Aggressive neighbours wander into a base:** `chooseBase` faces the side the group comes from, which put the wolfhound base 4,700 from a wild lucradan camp. The lucradans walked in, and the group died there four times in one run. With `baseClearance` above 700, a base now also keeps twice that from aggressive spawns at level-1 and up (2,600 for 1,300).
- **Tank** (`tank`, `guard`):
  - Taunt styles (names with "Taunt", e.g. the Hero's Taunting Blade) proc a StyleTaunt spell worth 1.7× the hit's damage in extra threat (`StyleTaunt.cs`). The tank uses the taunt style while the focus hits someone else and for `tauntOpenMs` (6 s) from his first hit, else his best other anytime style.
  - An add hitting a caster or healer that nobody controls (`peelTarget`: no mezz ordered on it, or one ordered more than `peelAfterMs`, 4 s, ago) pulls the tank off the focus: he taunts the add until it has targeted him for 1.5 s or gets mezzed, then goes back to the focus.
  - `guard` keeps Guard on the healer and Protect on a nuker (`guard: { guard, protect }`, a name or role), out of fights. Guard blocks attacks on that member with the tank's shield while he stands within 256 (`GuardAbilityHandler.GUARD_DISTANCE`). Protect moves 10 % per level of the threat the member causes to the tank, within 1000. Both show in the tank's effects ("Brigid guarded by Cuchulainn", "Ciaran protected by Cuchulainn"), and using either again on the same member cancels it, so the behaviour acts only when that effect is missing. The answer "You are now guarding Brigid, but you must stand closer." is a success; `useAbility` reports it as refused. Verified live.
  - A Hero's shield styles don't hold adds yet: Numb (Shield 3) stuns for 2 s, Slam (9 s) needs Shield 42.
- **Interrupts:** a material orders change aborts a running walk, fight or rest at once (`interruptible`, the default); casts finish (`interruptible: false`).
- **Pacing:** a turn that "acts" in under 250 ms is padded. Without it, a `rest()` that failed instantly ("attacked by ...") spun the loop, starved the event loop, and the group wiped.
- `ctx.skip(reason)` records why a behaviour did not act. The observer reports the top idle reasons per member, which is how "waiting for the tank to hold it" showed up.
- `ctx.result(kind, r)` records outcomes (casts, pulls, kills). Failed ones are logged, and the observer counts them by reason.

### 4. Observer (`GroupObserver`)

Samples the picture every second and listens to events; works for coordinated runs and for a passive watch (`bun sdk/group/cli.ts <group> --watch=60`, observe-only, any controllers).

- **Totals:** kills/h, XP/h, deaths, wipes, retreats, downtime % and the time per phase.
- **Per fight:** focus, kills, adds, tank hold (% of samples with a known target in which the focus targeted the tank), deaths, outcome.
- **Per member:** XP/h, actions, failures by reason, idle % while engaged and why, % targeted, % in melee range of an attacker (non-tanks), minimum health, and how long the group waited for it (health/power/dead/away).
- **Findings**, each with evidence and a suggestion naming the setting to change: `aggro`, `deaths`, `interrupts`, `idle` (nukers and melee only; idle healers are fine), `positioning`, `waiting`, `movement` (stuck walks, overload), `duplicates`, `downtime`, `adds`, `retreats`, `pace`, `no-kills`.
- **Comparison:** each report lists the change against the previous run of the same strategy (`xpPerHour 136758→243428, ...`).

## Writing a group strategy

`groups/<name>/strategy.ts` starts as `defineStrategy(pveLeveling, { settings: {...} })`. Settings merge deeply; behaviour lists replace per role, and `memberBehaviors` (by bot name) gives one member its own list, e.g. an Enchanter that waits longer than the Mentalist: `memberBehaviors: { ciaran: [release(), retreat(), flee(), position(), assist({ holdMs: 4000 }), holdFormation(), rest()] }`.

```typescript
import { defineStrategy, pveLeveling, decidePve, assist, release, retreat, flee, position, holdFormation, rest, type Behavior, type PveSettings } from '../../sdk/group';

// A class-specific behaviour: the Enchanter opens with its stun when the focus is on a healer.
const stunPeel: Behavior<PveSettings> = {
    name: 'stunPeel',
    interruptible: false,
    async run(ctx) {
        const mob = ctx.focus();
        const victim = mob?.target ? ctx.member(mob.target) : undefined;
        if (!mob || !victim || victim.role !== 'healer') return false;
        const stun = ctx.spells.all().find(s => s.type === 'Stun');
        if (!stun) return ctx.skip('no stun');
        ctx.doing('cc', mob.objectId, stun.spell.name);
        ctx.result('stun', await ctx.bot.castSpell(stun.spell, mob.objectId), mob.objectId);
        return true;
    },
};

export default defineStrategy(pveLeveling, {
    name: 'hibernia-pve',
    settings: { holdMs: 2500, ready: { mana: 35 }, combatRange: { nuker: [1000, 1450] } },
    behaviors: { nuker: [release(), retreat(), flee(), stunPeel, position(), assist(), holdFormation(), rest()] },
    // Wrap the policy: e.g. never pull while anyone is below 60 % health.
    decide: ctx => ctx.picture.members.some(m => !m.isDead && m.hp < 60) && ctx.orders.phase !== 'engage'
        ? { phase: 'recover', reason: 'someone below 60 %' }
        : decidePve(ctx),
});
```

- Individual scripts are not replaced: a behaviour can call any `bot.*` method or a helper from a bot's own folder, and outside a group run every bot still runs its own scripts.
- Settings worth knowing (all in `PVE_SETTINGS`): `minCon`/`maxCon`, `camp` (hunt here), `campLevelBand`/`campAggressiveWeight`, `huntRadius`, `baseClearance`, `ready`, `holdMs`, `assistAfterMs`, `heal.*`, `rest`, `combatRange`, `formation`, `pullDistance`, `engageRadius`, `avoidAggressive`/`aggroPad`/`maxAggroNeighbors`/`pullAggressive`, `roamMs`/`newCampMs`, `retreat.*`, `shedLoadAt`/`keepItems`, `tauntOpenMs`/`peelAfterMs`/`guard`.

## The improvement loop (LLM observer)

1. Run: `bun groups/<g>/hunt.ts 180`.
2. Read `runs/<stamp>.md`: totals and the comparison first, then findings, then the member table. Open `.log` or the timeline for causes (who did what just before a death).
3. Change **one** thing in `strategy.ts`, with a comment naming the run and the finding.
4. Run again and check that the comparison line moved the right way; note it in `groups/<g>/lab_log.md`.

To get a review that isn't anchored on your own guess, hand the report to a subagent: *"Read groups/hibernia/runs/<stamp>.md, the previous report and groups/hibernia/strategy.ts. Name the biggest coordination problem, its evidence, and the single settings or behaviour change you expect to fix it."*

What this loop did live (3–4 minutes per run, same camp, water beetles L6–8):

| Run | Change | Result |
|---|---|---|
| 1 | first live fights | phase flapping, healers tanking (tank hold 29 %), 3 deaths |
| 2 | sticky threats, damage dealers open after `assistAfterMs` even if the tank never held it | 5 kills, 0 deaths, tank hold 30 %, healers and casters within melee range of the arriving mob |
| 3 | formation depth: healers 550, casters 900 behind the anchor | tank hold 100 %, no one else targeted, downtime 35 % (waiting for the tank's health) |
| 4 | `heal.outOfCombat` 90 (above `ready.hp`) | downtime 13 %, kills/h 75 → 99; tank hold 74 %, Enchanter interrupted |
| 5 | `holdMs` 2500 | tank hold 99 %, no interrupts; waited 25 % for the Mentalist's power |
| 6 | `ready.mana` 35 | XP/h 137k → 243k, downtime 22 %, three members level 6 → 7 |

## Pitfalls seen live

- **Overloaded members can't move:** loot piles up. An Enchanter at 59/40 encumbrance had max speed 0 ("walk: stuck ... max speed 0"); the group's `gather` waited for him forever. `shedLoad` now drops the heaviest backpack item not matching `keepItems` at 95 % load; selling needs a town visit, which the PvE policy doesn't plan yet.
- **`rest()` refuses while any NPC in view targets us,** even one leashing home 3000+ away that the picture ignores. The `rest` behaviour checks `bot.getAttackers()` first and skips.
- **The first invite to each member went unanswered** right after the previous member joined; `formGroup` waits 1.5 s before each invite.
- **Formation depth counts in travel:** legs must chain from the last leg point, not from the group's centre, which trails the anchor by the formation's depth.
- **Ending mid-pull:** a mob already hit follows the tank after the run and killed it between runs. A run now finishes a pull under way.
- **Bring a friend:** a mob that gets *hit* calls same-faction mobs within 450 + 150 per extra attacker (1050 for a group of five), with a 200 % chance for five attackers, so two adds are guaranteed (`StandardMobBrain.BringFriends`, `baf_initial_chance` 0 + `baf_additional_chance` 50 per extra attacker). A body pull doesn't trigger it until the mob is hit. So fight a body-pulled mob where no friend stands within ~1050: `baseClearance` (default 700) keeps the base that far from every spawn.
- **Retreating from mobs that keep up kills everyone:** at level 7 against an aggressive L8–9 camp in Lough Derg, a retreat at 3 attackers left all five dead "en route" while nobody fought back (runs 20261030-122154/-122647, 14 deaths). It happened again at level 9 (3 runs out of 3). Likely cause: nobody sprinted, and monsters run as fast as a player who doesn't. The `sprint` behaviour (before `retreat` in every role list) now sprints (x1.3, `MaxSpeedCalculator`) for the whole retreat and stops afterwards to save endurance. Live: the first retreat with sprint saved everyone, the next ones started at 6–11 % endurance and died en route.
  - The add count was also wrong: it counted the focus and adds whose mezz was still being cast. Every "4 attackers" retreat came 1–3 s after the mezz orders. In the group's last campaign hour a retreat came about every minute, all on routes through aggressive mobs.
  - So retreat is now off by default: in PvE, crowd control, the tank's taunts and guard hold adds better than running.
- **Constitution loss:** every PvE death from level 6 (`pve_con_loss_level`) lowers Constitution until a town healer (GameHealer) restores it for money (188 copper per point at level 9). After about a dozen deaths the Hibernian group had lost 10–21 Con each (casters at 25 instead of 40). `player.constitutionLost` shows it; the `healer` behaviour (second in every default role list) visits the healer near the bind point after a death, which also cures resurrection illness. Lost Con is added at release, not at death. The visit isn't interruptible: an orders change once aborted the walk, so the healer was out of view ("Target not found") and the member kept the loss.
- **Aggressive camps two levels up are too much at level 7:** `campLevelBand: [1, 2]` with `maxAggroNeighbors: 1` meant 5–7 adds per fight. Passive camps at even con were clean. Lough Derg's camps from level 9 up are almost all aggressive. `campAggressiveWeight: 0` (the camp finder counts only passive spawns) and `pullAggressive: false` (pull only passive mobs) found passive red wolfhound camps for levels 8–10: 0.5–1.2M group XP/h without deaths.

## Unverified / next

- **RvR:** enemy-realm players already arrive as contacts (`kind: 'player'`) and the observer works unchanged. Missing: an RvR `decide()` (assist trains on enemy healers, cc rotations, focus switching on low health, retreat on numbers), and line of sight is not real (the client always answers "clear").
- **Pets** (Druid, Enchanter): no SDK pet commands yet.
- **Town visits** as a phase: not in the PvE policy. `groups/hibernia/town.ts` does it between runs (teleport to the trainer's town, train, wear upgrades, sell, teleport to the hub and `/bind`), and `groups/hibernia/campaign.ts` alternates it with hunts until a target level.
- **Across processes:** the blackboard is in-process. Its reports, orders and events are plain JSON, so a gateway channel could let separately running per-bot scripts or MCP sessions join one group.
- **Leaving or disbanding** a group (`/disband` in `formGroup` for members already in another group) is unverified.
