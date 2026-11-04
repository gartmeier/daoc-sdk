# Group coordination

Several bots playing as one group: they share what they see, a coordinator decides the group's plan, each member carries it out with its own class logic, and an observer scores every run so the next strategy is better. The code is in `sdk/group/` (import from `../../sdk/group`); group folders live in `groups/<name>/`.

Verified live with a five-player Hibernian group (Hero, Druid, Bard, Mentalist, Enchanter, levels 5–7, Shannon Estuary), over about a dozen runs of 1–4 minutes.

## Quick start

```sh
bun groups/create-group.ts hibernia cuchulainn brigid oisin niamh ciaran   # groups/hibernia/: group.json, strategy.ts, hunt.ts, lab_log.md
bun client/swarm.ts cuchulainn brigid oisin niamh ciaran                   # every member needs a running client (one process for all)
bun sdk/group/cli.ts hibernia                                              # look: members, load, enemies and who sees them (observe only)
bun groups/hibernia/hunt.ts 180                                            # hunt 3 min, then read groups/hibernia/runs/<stamp>.md
# meanwhile: http://localhost:7780/viewer/group/hibernia, or bun sdk/group/cli.ts hibernia --live
```

- **Each bot brings its own play** in `bots/<bot>/character.ts` (default export, `sdk/group/character.ts`): `role` is its job in a group, `react` goes above the fight, `fight` replaces the role's, `chores` go below it. It follows the bot into any group and into RvR. `assist({ melee: true, style })` and `tank({ style })` take a character's own style choice. A strategy's `memberBehaviors` overrides a character outright, and the run log says whose routine each member runs. Each run also appends a line to `bots/<bot>/runs/history.jsonl`, with damage dealt and styles, so a routine can be judged across groups.
- **Roles** come from group.json, then the character, then each bot.env `CLASS` (Hero → tank, Druid → healer, Bard → support, Mentalist/Enchanter → nuker; `roleForClass`). Override per member in group.json (`{ "bot": "oisin", "role": "healer" }`) or with `--role=oisin:healer` at creation.
- **Flags** of hunt.ts become settings for that run only: `bun groups/hibernia/hunt.ts 120 --holdMs=3000 --ready.mana=40`.
- **MCP:** `execute_code({ bot_name: 'cuchulainn', script: 'groups/hibernia/hunt.ts', args: { seconds: 180 }, timeout: 7 })`. The MCP bot is used as one member; the others get their own control connections. Verified live.
- **One controller per bot still holds:** a group run takes control of every member. A single-bot script or MCP call on a member pre-empts the group run, and the run stops with `BotPreemptedError`. `sdk/group/cli.ts` only observes. To end a run early, wind it down instead (see [Watching a run](#watching-a-run-gateway-viewer)).
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
- **A monster casting from range reports no target:** the server sends one only for a mob in attack state within its attack range (`PacketLib168.cs`), and a timed cast leaves attack state. Live, a dergan enchanter at 446 and a moss sheerie at 427 landed spells with `targetObjectId` null and `inCombat` false. So its hostile spell effects name the target for 6 s when the server names none (`spellTargetId`, then `targetBySpell` on the contact), spell effects only, since a swing would keep a mob's old target after a reset. Live, five level 22-23 against tomte mystics in Thidranki: the board named the mystic's real target by spell, 8 kills in 6 fights, no deaths, tank hold 91 %. That run had no old-code run to compare with, and the mystics' spell is a DoT, so a nuker is untested.
  - Most monsters that cast don't stand and cast. A tomte mystic lands its DoT, then runs at its target, since a mob with no spell it can cast now attacks (`StandardMobBrain.cs`). A mob in combat with no target is running (65535), so that one isn't by spell, even with a spell in the last 6 s.
  - On its victim's own client the entry does name it, for that bot's fight: a hostile spell names the mob, and it stays named through the server's 0 for 6 s after the last one, which `getAttackers` and the rest need (a caster at range). So `NearbyNpc.targetBySpell` says so, and `observeState` reports it as the spell's, with every rule for one by spell: it doesn't flip with whose report came last, and a mezz ends it (reading the source and real-model tests, `model-to-board.test.ts`; not run live). The server's own id, a swing or a run (65535) clears that. Counting any server target that matches the spell as by spell made running mobs read as standing: one run on it, with ending the pull on a spell, had 6 deaths against 0 and the healers in melee 29 and 17 % of fight time against 6 and 2. One run each, in a dense aggressive pack, so neither is proven the cause. Backed out, and this isn't that: it goes by what the mob's own entry last said.
  - `flee()` and `position()` don't react to a target by spell beyond melee reach (walking to the tank does nothing against a nuke). The tank does peel it (a taunt works on a monster), but not away from an enemy player, beyond the leash or under a keep's guards. The puller hits it rather than walking back without it. Ending the pull as soon as a spell lands loses the carry home for any mob that would have followed, for good, so a caster that truly stands still waits out `pullTimeoutMs`.
  - A monster whose latest swing or hostile spell went at a player outside the group, or at a pet no member owns (a stranger's, an enemy's, or one that stepped in front of its owner, `AttackComponent.cs:1492-1498`), isn't a threat for that, wherever it stands; a damage spell also arrives as a swing (`SendCombatAnimation`). The group fighting it, or it hitting a member, still makes it one.
  - While crowd-controlled its spell names no target, so a mezzed caster leaves the threats as a melee add does: 4 s after the last swing or spell, at most 6 s after the mezz. A mezz stops the cast under way and any new one (`OnHardCCStart`, `CanCastSpell`), a bolt shows at launch, and DoT ticks send no spell effect, so a spell seen over 2 s after the mezz means it broke. A tick or a bolt's impact does send a combat animation, which counts as a swing, so a mezzed mob with a DoT running can read as broken while it holds (reading the source; "mezz on tomte mystic broke" showed three times live, unchecked). A rooted caster can still cast, and that ends its entry too: it isn't controlled, and the group must be free to kill it.
- **Claims:** a member's activity (`heal` on X, `cc` on Y) is visible to the others, so two healers don't heal the same target and two mezzers don't mezz the same add.
- **Crowd control on the board** (`sdk/group/cc.ts`, the server's rules in [spells.md](spells.md#crowd-control-what-repeats-do)): every member reads the same state of each target.
  - `Contact.cc`: held by a member, so the group leaves it alone. It ends at the spell's length, half that for a root (where its hold ends); when the server says it ended; or when a mezzed or stunned target swings or lands a spell. A root also ends on a landed hit or when it walks off (over 120 from where it stood), and says nothing when it does: every root in `spell.sql` (Value 99) has an empty `Message3` and `Message4`, and `can move normally again` is a snare's. A rooted monster goes on swinging at what's in its reach and stays held, and a member in that reach steps away (`flee`). A rooted player that swings, or a rooted one of either kind that lands a spell, only stops counting as held: the root stays on it.
  - `Contact.ccImmune`, by kind: when that kind can land again, from a landing, an end or an answer. It stays through a contact leaving view (not a death): a player's 60 s outlasts RvR's `forgetAfterMs` of 30 s.
  - `Contact.serverName`: an enemy player's real name, from the landing line, so an end line heard by any member within 512 counts for the group. A root has none, most snares neither, and a caster at range hears none: then the spell's length stands, and a wrong guess costs one cast, which the server's answer corrects.
  - **Only what the server said goes on the board:** `markCc` after `effectLanded`, or for a monster's silent repeat; `markCcImmune` after `effectImmune` or `alreadyOn`. A resist marks nothing.
  - **Who is sent:** `assignCc` goes by `capabilities.ccKinds`: nobody at a target immune to everything they cast, so a root still goes where a mezz can't. No stun: no behaviour casts one (a stun cast by a member's own routine should pass kind `'stun'` to `markCc`, and the rest follows).
  - **A mezz takes no NPC under 75 % health:** "Your target is enraged and resists the spell!", no roll and the power spent (`CCSpellHandler.cs:174-178`). A root has no such floor, and a player none. `assignCc` gives such an NPC only to a member with a root (`capabilities.root`), `crowdControl` casts that root at it with a mezz ready too and no mezz at all, and if the health fell during the cast the line reads as `effectImmune`: 60 s left alone, marked for the other mezzers. Before this, a mezzer cast six at an add at 68-63 %, at 5 power each of 57.
- Deaths of monsters come from the client's death events; a kill event fires only for a mob the group fought. Object ids are reused, so a died id is ignored for 20 s, not forever.

### 2. Coordinator (`Coordinator` + `strategy.decide`)

Runs `decide()` every 500 ms on the picture and writes **orders**: `phase`, `anchor` (rally point), `facing`, `focus` (assist target), `puller`, `cc` assignments, `retreatTo`, `waiting` (who the group waits for, and why) and a `reason`. Only material changes (phase, focus, puller, cc, a move over 300) bump `seq`, get logged with `»`, and interrupt members.

The PvE leveling policy (`decidePve`):

| Phase | When |
|---|---|
| `engage` | anything is a threat. Keeps the focus while it lives (no target thrash); else what the tank hits, else whatever is on a non-tank. Adds go to crowd control: mezzers first (support, then nukers), then roots (the healer); no NPC under 75 %, which a mezz can't take |
| `retreat` | off by default (`retreat.enabled`). When on: the tank is dead, 3+ adds (not the focus) are neither controlled nor assigned to a mezzer, 2+ members are dead, or the tank is under 25 % while the focus has over half. Runs 2500 away from the attackers until nothing follows (max 25 s) |
| `travel` | most of the group is far from the base. Legs of 1500 along a route around every aggro zone (`safePath`); the next leg once everyone is within 1200 of this one (or after 30 s) |
| `gather` | a few members are away from the base |
| `recover` | someone is dead (waiting for a rez, or for release and return) or below `ready.hp` / `ready.mana` |
| `pull` | everyone is ready: the tank body-pulls the best target (highest con in the window, nearest to the base) |
| `idle` | nothing to pull; the reason lists why each monster was rejected (`3 con -3, 22 near aggressive mobs, 4 too far`). Moves the base after 25 s, picks another camp after 2 min |

- **Camp and base** come from static spawn data: `findCamp` picks the densest cluster of spawns in the group's level band.
  - Without `basePlan`, `chooseBase` puts the base on open ground next to the camp, `baseClearance` from every spawn.
  - With `basePlan` (on for hibernia), `planBase` (`baseplan.ts`) puts it among the targets the tank can pull safely, on a 100-unit grid. Every formation slot (placed from the facing the plan orders) keeps 150 beyond each aggressive mob's reach, and the tank's fight spot 300. Reach = aggro range + 500: spawns have RoamingRange 200, but the server picks roam points with Detour `findRandomPointAroundCircle`, which returns any point of a polygon touching that circle (sampled around Lough Derg: p99 407–561 from the spawn). A target is unsafe when its own spot is within reach + 400 of an aggressive mob, or when the walk to it passes within reach + 100. The base minimises the mean distance to the 6 nearest safe targets. A camp without a safe base is skipped for the next camp (up to 3), else chooseBase.
  - Pulls then skip mobs from unsafe spawns (`unsafe spawn (...)`), and any mob whose pull walks past a live aggressive one (`aggressive on the way: ...`).
  - At the red wolfhound camp in Lough Derg, the clearance base (1300) stood 1,300–3,000 from the safe wolves. The pull phase took 37–56 % of each hunt, and a wild lucradan walked in during three hunts. A first planner (roam reach 250) put the base 306–1,401 from five wolves: kills/h 136 → 163, pull phase 27 %, but lucradans and badgers still walked in 2–5 times per hunt. With the honest reach that camp has no safe spot, and the planner moves to the fishing bear foragers (passive, no faction) east of it: 17 targets 300–855 away, slots 1,031+ beyond the aggressive cubs' reach.
- **Aggro is per spawn, not per name** (`aggroAt`): the same name is passive in one camp and aggressive in another. Using the name's maximum, as the first version did, rejected every target at a passive camp.

### 3. Members and behaviours (`MemberAgent`, `behaviors.ts`)

A member runs its role's **behaviour list** top to bottom every turn; the first one that acts wins. Reactions sit above orders, chores below:

| Role | Behaviours (in order) |
|---|---|
| tank | release, retreat, rez, pull, tank, guard, shedLoad, holdFormation, buff, rest |
| healer | release, retreat, emergencyHeal, flee, rez, heal, crowdControl (assigned), position, shedLoad, holdFormation, buff, rest |
| support | release, retreat, emergencyHeal, flee, rez, crowdControl, heal, position, shedLoad, holdFormation, buff, rest |
| nuker | release, retreat, flee, rez, crowdControl (assigned), emergencyHeal, position, assist, shedLoad, holdFormation, buff, rest |
| melee | release, retreat, rez, assistMelee, shedLoad, holdFormation, buff, rest |

- **Resurrection** (settings `rez: { holdMs, radius, sit, reserve, inFight }`, default 120 s, 4000, sits for its power, no reserve, not in a fight; RvR differs, see learnings/rvr.md; `--rez.holdMs=0` releases at once as before):
  - `release` says yes to any offer. With a living member within `radius` in the region whose list casts a rez, and who could pay for this corpse, it waits up to `holdMs`, and longer while a rez is being cast on it; otherwise it releases.
  - `rez` runs in every list and acts only for a member who knows a rez, so a Bard or Warden does it too. In recover, gather and idle with nothing fighting the group, and with `inFight` also during engage when `rezPressure` finds nothing: not in travel, which in RvR can be falling back from a force the board has no threat for yet. Short of power it sits for what the rez costs, not for `rest.mana`. It walks to the edge of the range, not to the corpse, since the rezzed member appears at the caster, and not to within 1500 of an enemy player.
  - Rezzers come back first, then the tank. The claim is the activity on the corpse (`rez_prep` sitting or walking, `rez` casting), so a second healer takes the next one. Only `rez` holds a release past `holdMs`.
  - A run that is ending waits for a corpse with a rezzer near, up to the hard stop. A member rezzed in the field skips the visit to a town healer for the illness alone.
  - A strategy with its own role lists adds `rez()` itself. Without it the member casts none, and corpses don't wait for it (`capabilities.rez` needs the behaviour in the list).
- A behaviour sees its own character in full (`ctx.bot`, `ctx.sdk`) and everyone else only through the picture (`ctx.members()`, `ctx.tank()`, `ctx.threats()`, `ctx.focus()`). That keeps the information honest.
- **Routes avoid aggressive mobs** (`safePath`, used for travel legs, by members more than 2500 from their slot, and by `groups/hibernia/town.ts`):
  - A mob aggroes only on players it doesn't con grey to (`StandardMobBrain.CanAggroTarget`: "Only attack if green+ to target"), and only within its aggro range, mostly 500 (`CheckPlayerAggro`).
  - `aggroZones(region, level)` is every aggressive spawn not grey to the group's lowest level, out to its aggro range plus 300 (`AGGRO_PAD`, mobs wander). At level 11 in region 200 that is about 11,000 circles.
  - The route is a grid A* (400-unit cells) where a cell inside a zone costs 30× more, so it crosses a zone only when there's no way around. Planning takes 5–40 ms.
  - Before this, routes only avoided mobs 3+ levels up or packs of 4+ at or above the group's level. At level 11 the route to the next camp ran through aggressive lunantishee (L8–9, blue), and every fight on the way brought adds.
- **Heals go by what the target misses** (`pickHeal`): the cheapest that covers it, else the one restoring most, and one on a timer only when nothing else covers. Spell level says nothing here: a Healer and a Shaman at 20 always cast Minor Recovery (48, level 18) while holding heals of 109-184. Alternating runs: 12 casts against 49 in 9 and 11 fights, with the tank's lowest health the same.
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
  - Server rules, for any pulsing spell but focus damage shields, not only a Bard's ([spells.md](spells.md)): one plays at a time. A new one ends the running one (`CancelIncompatiblePulseEffects`), and casting the running one again stops it ("You stop playing your song.").
  - So songs are not buffs: `song` never re-casts the song that's playing, counts one as playing until a pulse is overdue (so it casts nothing until one such wait has gone by in a run), and waits 10 s after a cast for the effect to show. Swinging, an instant one goes out raw so the swing keeps the mob, and one with a cast time waits for the fight to end.
  - Choice: speed while travelling; endurance while pulling and fighting (the tank's styles), or else added damage (a Skald's Battlesongs have no endurance song, so Chant of the Charge plays at Battlesongs 17); between fights, power when a caster is below 70 % (`songs.powerBelow`), health when someone is below 80 %, else endurance.
  - Hibernian Bard at level 9: Clear Path (speed), Rhythm of Hibernia (endurance), Chant of Healing (health). Power (Rhyme of Earth and up) comes later in Music. All take 3 s to cast and can be cast on the move.
  - Verified live: speed on every travel leg, endurance while gathering and fighting. A song is kept at least `songs.holdMs` (30 s) except into a fight, because short idle/travel hops made it flap.
- **Roaming can walk the group into aggressive mobs:** once the camp is out of targets, `decidePve` moves the base to a random spot within 900 of the camp every `roamMs`, without checking aggressive spawns. At a passive camp next to an aggressive one this caused a wipe (6 adds). Set `roamMs` high and let `newCampMs` pick another camp instead.
- **Aggressive neighbours wander into a base:** `chooseBase` faces the side the group comes from, which put the wolfhound base 4,700 from a wild lucradan camp. The lucradans walked in, and the group died there four times in one run. With `baseClearance` above 700, a base now also keeps twice that from aggressive spawns at level-1 and up (2,600 for 1,300).
- **Tank** (`tank`, `guard`):
  - Taunt styles proc a StyleTaunt spell worth 1.7× the hit's damage in extra threat (`StyleTaunt.cs`); detaunt styles proc −1.9× (net −0.9×, floored at 0) and the tank never uses them. The name doesn't tell which is which (Warrior: Plague/Draw Out/Provoke taunt, Hoarfrost/Temper/Placate detaunt; the Hunter's "Taunting Call" detaunts), so `tankStyles` (`styles.ts`) reads it from what the server says about the proc, among the styles his weapons allow; a proc it hasn't described counts as neither. The tank uses the taunt style while the focus hits someone else and for `tauntOpenMs` (6 s) from his first hit, else the anytime style worth most damage per endurance that moves no threat, or a plain swing when none reaches `minValue`.
  - An add hitting a caster or healer that nobody controls (`peelTarget`: no mezz ordered on it, or one ordered more than `peelAfterMs`, 4 s, ago) pulls the tank off the focus: he taunts the add until it has targeted him for 1.5 s or gets mezzed, then goes back to the focus.
  - `guard` keeps Guard on the healer and Protect on a nuker (`guard: { guard, protect }`, a name or role), out of fights. Guard blocks attacks on that member with the tank's shield while he stands within 256 (`GuardAbilityHandler.GUARD_DISTANCE`). Protect moves 10 % per level of the threat the member causes to the tank, within 1000. Both show in the tank's effects ("Brigid guarded by Cuchulainn", "Ciaran protected by Cuchulainn"), and using either again on the same member cancels it, so the behaviour acts only when that effect is missing. The answer "You are now guarding Brigid, but you must stand closer." is a success; `useAbility` reports it as refused. Verified live.
  - A Hero's shield styles don't hold adds yet: Numb (Shield 3) stuns for 2 s, Slam (9 s) needs Shield 42 ([classes/hero.md](classes/hero.md)).
- **Interrupts:** a material orders change aborts a running walk, fight or rest at once (`interruptible`, the default); casts finish (`interruptible: false`).
- **Pacing:** a turn that "acts" in under 250 ms is padded. Without it, a `rest()` that failed instantly ("attacked by ...") spun the loop, starved the event loop, and the group wiped.
- `ctx.skip(reason)` records why a behaviour did not act. The observer reports the top idle reasons per member, which is how "waiting for the tank to hold it" showed up.
- `ctx.result(kind, r)` records outcomes (casts, pulls, kills). Failed ones are logged, and the observer counts them by reason.

#### Pets (`sdk/group/pets.ts`)

This is how a run plays them. What each class has and what the server does with a pet: [pets.md](pets.md).

Live in three small groups (Albion and Hibernia with a tank, Midgard with and without one, levels 10 and 20): in a base-camp hunt with a real tank, one order per fight, after the hold, on the focus only, no spin, retreat and run's end right, damage split to the unit. Whether it pays is in [pets.md](pets.md#groups). What came after that pass has tests and no live run yet: a mob on a pet counting as held, `pet.fnfLifeMs`, the 15 s run-in, the map margin, `summonOnTheWayBack`, `pet.strayFightsOff`, `pet: false`, `petHeal`'s pick by what the pet misses, its Realm or Group heal at the pet's id and its 25 % reserve, the weak-pet gate in `Spellbook.summon`, the hostile-within-2500 summon gate, the attack order's answer and backoffs (2 s, 3 s, one more order at 5 s), `crowdControl`'s call-off, a cc'd mob holding the pet passive, the root exception in `ccHolds`, the keep's-guards stance, `assist`'s 2.5 s steps, `petBuff` in another's pull, `readsOnPet`'s 500 ms and the 50 ms slot. One Midgard re-test since showed the side tick (an order waited out our own mezz cast and went 0.4 s after it), a tank's own pet passive through its pull with the order 1.8 s after the first swing, intercepts read right (7 lines, tank hold 100 %, Drew 0 %, no `pet-aggro`), the `pet power` wait (21 s), and the far member ("far off, not waited for").

A run wraps every member's list in `withPets`, role lists and `memberBehaviors` alike, by what its spells and window say as the run starts. A member with no use for pets keeps its list untouched.

| Behaviour | Goes | Does |
|---|---|---|
| `petControl` | after `sprint` (else before `retreat`), by name: it runs on the side tick | Orders the window pet. It is the one authority over the pet: every `killNpc` in the group passes `usePet: false`. |
| `fnfPet` | before the first fight (else before `shedLoad`) | A Theurgist's pet on the focus, by the same rules, down to `pet.fnfFloor` % power, or his character's floor if higher (the `theurgist()` kit's `saveBelow`). Only with the cast plus `pet.fnfLifeMs` (10 s) left, at the rate the focus has gone down since its first health loss of the fight, and that is judged after 2 s of damage and not before: a pet pays at the end of its cast, its first hit comes about 3 s later, and it goes with its target. So fights of 11 s stay on `assist`'s nukes and a long one gets pets. At L10 a pet is 15-18 % of the pool against 6 power for a nuke of 41: 10 pets dealt 72 damage where 15 nukes dealt 505. Counts as a nuke. |
| `petHeal` | before the first fight (else before `shedLoad`) | Below `pet.healBelow` % in a fight, below 80 % between fights with 50 % power. A Pet-target heal, else a single-target Realm or Group heal at the pet's id (a Druid's), the cheapest that covers what the pet misses by its level. A heal on friends is never one on a timer, and in a fight goes only with 25 % of the pool left after it: it is the group's power. After one that landed it waits for the reading to change or 1 s, 3 s on "is fully healed": the reading comes 400-600 ms late. |
| `summonPet` | before `position` (else the first fight, else `shedLoad`) | By what is hostile, not the phase: nothing fighting us and no enemy player within 2500 of this member, so also in a roam's walk to a passive mob and at the bind in a fight far off. Not in a retreat or our own pull. Below `pet.summonMana` % (or what the spell costs, if more) `rest` stops as soon as there is enough, so the summon comes next and the ready gate counts what it cost. Meanwhile `rest`'s activity reads "pet: saving power" and `Orders.waiting` `pet power`. |
| `summonOnTheWayBack` | before `rejoinFight`, on a list with one (the RvR lists) | `summonPet` and its gate, only while `rejoinFight`'s walk is due: that takes every turn and ends too near the fight for a summon. Near the fight it has no say, and `summonPet` stands in its own place, below `rez` and the heals. |
| `petBuff` | before `buff` | Quiet phases and someone else's pull with no threat, by icon in the pet window; one that landed also waits 90 % of its duration, as the window lists 8 icons at most. |

**The side tick.** A behaviour marked `side: true` runs in `MemberAgent` every 250 ms (`sideTickMs`), between and during turns, one at a time and never awaited by a turn; an error is a note and a pause. It also gets a tick at the end of each turn that acted, with no turn announced, and the next turn gives that at most 50 ms: a Druid's heals follow each other in one macrotask, and with every tick reading the heal its pet got no attack order until the chain stopped. Its context leaves the activity and the idle reason alone, and a failure it records doesn't pace the turn. No player: no tick. `MemberAgent.run` settles after it ended, so the run's end sends its last orders after it. `petControl` runs so, as a turn can last: a tank's `killNpc` to the mob's death, a nuker's walk and cast up to 12 s. `ctx.turn()` says what the behaviour running now has announced.

`petControl`'s rules:

- **The pet takes `orders.focus` and nothing else.** Not before the tank has held it for `pet.holdMs` (default `holdMs`; an enemy player at once), not beyond 2000 of us (the server refuses), and not out of our client's view. No add, and no stand-in for a focus beyond the leash, as tank and melee have.
- **A mob on a pet counts as held,** for casters and pets alike (`holdState`): on the tank's own pet as if on the tank, on another member's once it has read on that pet for `holdMs`. A nuke can pull it off that one, but it no longer waits 6 s with the mob safe. The report's tank hold % stays strict: only the tank itself.
- **A tank's or puller's own pet** stays passive through its own pull and until `pet.holdMs` after the mob named the tank or the tank's first swing since the engage, whichever first. A defensive pet would answer the first hit on its owner in ~33 ms, unordered, and take the mob. The attack order lifts it. With the mob already on this pet there is no passive, as that doesn't shed it, and the order goes at once. Once the order has gone the pet stays on it, also if the mob turns to the tank inside the hold. A mob on the pet in a pull ends the pull where it stands, as ever; with the passive that is rare.
- **A blow a pet takes for its owner is no mob on the pet.** Within 128 of the owner it steps in, 75 % of the time, passive too (`AttackComponent.cs:1429-1436`, `InterceptECSEffect.cs:29`), and every client's 0xBC names the pet with the mob still on the owner. Only the owner gets the line ("The spirit soldier steps in front of you and takes the blow!"). Its report names the mob (`Observation.intercepts`), and the board reads sightings naming that pet as on the owner for 5 s. A groupmate's client can get there a snapshot first, so `petControl` and `decidePve`'s pull go by a reading on a pet only once it has stood 500 ms (`readsOnPet`): one coordinator tick on it would end a pull for good.
- **Never a crowd-controlled target:** not one with `cc` on it, an assignment in `orders.cc`, or a cc cast under way, another member's or our own. A pet already on one, or on a target beyond the leash, is called off. `crowdControl` calls off its own pet before its cast. With a cc'd mob on the pet it is passive as well until its order goes out or stands, or it hits back: a focus to go for lifts nothing while `selectFree` holds the order back (our own cc cast, a heal turn) or it is beyond 2000. A pet already on the focus stays there, as passive would break that fight off at every heal. The one exception is a focus under a root with nothing else free in the fight (`ccHolds`): the root has done its job, and `assist` and the pet go in. A mezz never.
- **A focus beyond the leash or under a keep's guards:** the pet stays passive until there is an order for it. A defensive pet goes for whoever hits its owner, from any range, and a follow only holds until the next hit (`OnOwnerAttacked`). An attack order lifts passive. A threat under a keep's guards holds the stance in any phase: the fight on it lapses with its 6 s aim, and it can hit again. `decideRvr` doesn't keep such a fight going for the threat itself, as our own landed nukes keep it a threat.
- **Retreat:** passive and follow, two packets. Defensive again afterwards, also when the run ends in the retreat. It is never left aggressive.
- **Outside a fight in a strategy whose orders walk off with a threat in sight (`pet.strayFightsOff`, the wolf pack):** off any fight, and passive until the next, as what a pet fights stays a threat for as long as it does and nobody could sit. With the setting unset, as for `decidePve` and `decideRvr`, a threat is the coordinator's on its next tick:
- **Outside a fight:** off the focus during a pull (the tank brings it, and a pet's swing draws the camp), and off a stray fight once there are no threats, since a pet's fight slows the owner's regen.
- **Left alone:** a shade's pet, a turret, and a pet on `stay` until a focus is ordered (that's the character's routine); called off then, it goes back to `stay`. A fight `petControl` itself sent it into is `petControl`'s to end: a retreat reaches it, passive and follow.
- **An attack order's select (0xB0) moves the server's target,** which a swing follows and a cast reads at its begin. So it waits while the turn runs on another target (`castSpell` selects, then sends: a mezz would land on the focus) and during our own cast or swing at anything else. With its target selected already it goes: a tank's `killNpc` has the focus, a nuke's walk and cast is on it. Stance and walk orders don't wait; a 0x8A interrupts nothing.
- **The answer to an attack order** is read on the ticks after it: "You command", or a refusal from the table `bot.petAttack` reads, through `ctx.result` with its reason. A refusal backs off 2 s for `immune`, else 3 s, and `pet-idle` names it. No line in 2 s is `no_response`, unless the target went. An accepted order to a pet that hasn't closed or swung for 5 s goes once more: the server drops an order whose target stops being allowed (a login's immunity).
- **Throttles:** the same stance or walk order at most once in 1.5 s, the same attack order once in 3 s. A different order goes at once, or a flapping phase would drop a retreat's passive.

Not automatic: Necromancer, Animist, charms, minions, bombers. A window pet from an earlier script, a charm say, still gets `petControl` (`PetKit.window`). The run's end sends follow to any pet but a turret and a shade's, after a `defensive` if `petControl`'s last stance order to that pet was passive (a new pet comes up defensive, and the memory goes with the old one). A hard stop by pre-emption can't: another controller has cut that connection, and nothing can be sent from it. So a member taken in a retreat keeps its pet passive, and the run's log says `<member>'s pet left passive`. The next run lifts it with its first stance or attack order, or `bot.setPetAggression('defensive')`; a solo `killNpc` doesn't order a passive pet.

A nuke out of range walks in steps of at most 2.5 s (`assist`), back to the list in between, so a heal above it doesn't wait for the whole walk. A cast itself is never cut for that.

**A mob that killed a pet** stays a threat for its whole run-in: while its sighting reads in combat and moving with no target, up to 15 s after the loss. Live it took 9-10 s, against the `hostileMs` that covers the moment it stands first. The summon gate and `recover` read threats, so they follow.

**The map.** `Region.GetZone` is null outside every zone, and the server dereferences that: a pet walking there is removed with no 0xA2, so it reads `released`, and a summon there kicks the caster to the character screen. Retreats (`decidePve`, `decideRvr`), travel legs, a roam's wander, formation slots and `position`'s steps stay on the map, 300 in from its edge (`keepOnMap` in `terrain.ts`): shortened or turned until a zone holds the whole way. Routes go round it (`safePath`). `summonPet` and `fnfPet` skip within 100 of the edge, as the pet comes 64 ahead of its caster.

**A far member** (over `gatherRadius` × 4 from both the group's middle and the tank: a release far off) doesn't steer the group: it is out of `away`, so it holds no gather and a leg never starts from it. Its health and power still count at the ready gate, as a member's in another region do. It walks back as ever and shows in the orders' reason. Never the tank: nothing is pulled without him.

`pet.waitForSummon` holds pulls for a member with no main pet (`waiting`, why `pet`). It is off, as a member that can't summon would hold the group for good. Flags work: `--pet.holdMs=3000 --pet.enabled=false`.

A member alone goes without: `pet: false` in its `bots/<bot>/character.ts` is the same for that member, with the others keeping theirs. Under a strategy's `memberBehaviors` no character is loaded, so it has no say there.

A pet capped below half its owner's level is none to keep up (`Spellbook.summon`): a Druid or a Stealth Hunter with no points in the line stays at L7 from level 15. `summonPet` leaves it, and `capabilities.pet` is null.

`pet.enabled` false is a run with no pets, the baseline to compare against: no pet behaviours on any list, `capabilities.pet` null (so nobody waits on the member's power or pet, and the report has no row or `pet-down` for it), and the run's end sends its pet nothing. A pet still up from an earlier script stays up and shows in the table.

`pet.holdMs` above `assistAfterMs` holds: for a pet the fallback moves with it, so `--pet.holdMs=10000` waits 10 s. `holdMs` itself stays capped by `assistAfterMs` on a mob the tank holds (`holdState`).

The report has a `## Pets` table, and `MemberStats.pet` and `petDealt`, for a member with a pet up or a summon it can keep up. A group with none gets no such table, field, key or finding, and no side tick runs. Its report does show what the same work changed for everyone: `hand` in a tank's or melee's Routine and a `hand:` line in the log, `Deaths by killer:` on a PvE run with a killer, `guard:<realm>` where it read `pet:<realm>`, `walk:<reason>` in Failures, and the RvR line on a PvE run with a death to a guard.

| Field | Means |
|---|---|
| Up | % of samples with the owner alive that its window pet was there; `-` for a Theurgist's, which have no window |
| On focus | % of engaged samples with it up, the focus alive and not crowd-controlled, and its hold over: a monster's counts from `pet.holdMs` after its engage, as that wait is no idleness |
| Drew the focus | % of the tank-hold samples with the focus on it, `-` with no such sample. Those count as not held in `tankHold`. A blow it took for its owner ("The spirit soldier steps in front of you and takes the blow!", and what that starts until the mob reads elsewhere) isn't drawn: the board reads the mob on the owner then, and what still reads on the pet is `intercepted`, shown beside it |
| Damage dealt | From its owner's messages, split by `countCombatMessage`. With no pet, a line that reads like one is the member's own (a proc's DoT) |
| Died, Summons, Broke cc | Counts. A release or a region change is no death. A Theurgist's summons are its new object ids, since those casts count as nukes. What comes before a member's first sample counts too: an instant summon, a death |

| Finding | Fires on | Look at |
|---|---|---|
| `pet-mezz` | one broken mezz or root (`note` with `data.petBrokeCc`) | `petControl`'s ordering rule, `pet.holdMs` |
| `pet-aggro` | pets drew the focus over 25 % of the hold samples, with 10 s of fight time behind that, PvE only | By its cause, per pet: a broken mezz names the line, and `pet-mezz`; the tank's own pet the stance, as a hold reaches it only as passive; one that got no order (no `petControl` on its list, no `petAttack` accepted) its owner's attackers; only one that was ordered, by `petControl` or `fnfPet`, `pet.holdMs` |
| `pet-idle` | on focus under 50 % of at least 10 samples, on a list with `petControl`: not in a passive watch, which knows no list | range, hold; a refused order by its reason |
| `pet-down` | a member that can summon had no pet over 25 % of a run over a minute | The deaths finding, when most of that time followed its owner's death; else `pet.summonMana` |

A group with no member in the `tank` role never pulls: `decidePve` stays in `recover` with "no living tank to pull", and there is no fallback puller, as that is a strategy's to decide. No Midgard pet class is a tank by its class. `create-group` warns, and `pveLeveling` adds a `no-tank` finding with `--role=<bot>:tank` (or `"role": "tank"` in `group.json`) as the advice.

A pet's swing breaks a mezz even when it misses (`GameLiving.cs:1700-1704`) and sends no line of its own, so the board reads it from the owner's combat events and takes the `cc` off at once. An enemy pet's death counts in its fight's `kills` (it can end one) but not in `totals.kills`: it is worth nothing (`GameNPC.cs:2731-2732`). One that went with its owner, gone within 1 s of the death of a player of its realm with 10 % or more left (`GamePlayer.cs:5988-5989`), is only a note.

#### Failed actions

A turn that ends in a failed `ctx.result` takes at least `failedTurnMs` (1000 ms, `MemberAgentOptions`). Plenty of refusals come back before any walk or send: `castSpell`'s `invalid_target`, `not_attackable`, `no_target` and `already_dead`, `killNpc`'s `refused` with nothing in slots 10-13. The list would otherwise try again and log it four times a second. A behaviour of your own gets this by reporting through `ctx.result`.

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
- **Positioning in fights** (`position()`, `positioning.ts`; session 2 recording and hunts 231357/233259):
  - `combatRange` is limits, not a band to centre in: healer/support [500, 1600], nuker [700, 1400] by default, narrowed by the spell (min 250 + 100 per second of cast time, so a mob can't reach us mid-cast; max = spell range - 100). Inside the limits nobody moves and assist casts at once.
  - Out: a danger (a threat, or the member it runs at, or a mezzed add about to wake) is closer than min: step to min + 200 from it. In: the focus is settled on the tank and beyond max (3D): step to max - 150. Along our own bearing (never across the fight), turned ±25/50/75° when the spot is in aggressive reach; no safe spot means stay. A member chased by an add stays by the tank (flee) instead.
  - Between fights a member within `slotSlack` (350) of its slot, safe and well inside the gather radius stays put.
  - Before: the band middle on the tank's side sent casters across most close fights (1,200-1,400 units), Ciaran walked 92 s of 4 min and first nukes came 5-9 s into fights. After: walking in fights Niamh 33 -> 15 %, Oisin 34 -> 7 %, Ciaran 48 -> 15 %; first nuke Niamh 5.3 -> 2.7 s, Ciaran 6.4 -> 4.2 s; 0 deaths, tank hold 97 %.
  - The server sends no target for a mob that is running (PacketLib168: 65535), so the board keeps its last one; the hold (`holdState`) counts a carried pull from the engage order. Object ids are reused the moment a mob dies (Region.cs), so per-mob memory keys on `objectId:firstSeen` (`ckey`), and a respawn at full health under a dead mob's id is a new contact.
  - DoTs stack on the server by effect group, else by tick frequency (DoTSpellHandler.HasConflictingEffectWith): `dotFamily`, so a Mentalist casts Illusory Anguish once per mob and never the weaker Illusory ranks.
- **A melee member joins at once:** `meleeFight()`, on both default melee lists, is `assist({ melee: true, holdMs: 0, style: fighterStyle() })`. It doesn't wait for the tank's hold, which is the wait for casters, and it picks styles ([combat.md](combat.md)). A Warden's idle time in fights went from 19-25 % to 1 %, in runs not alternated. A Skald on it, with its damage song, dealt about twice the damage per fight second (3.2-4.1 against 1.7-2.4, alternating runs, 20 fights), with tank hold 96-100 %; its group's kills/h didn't rise, because the time went to waiting for a nuker's power. A tank whose character queues a taunt style takes the mob back when it turns (tank() queues the taunt as the backup while the mob is on someone else and for `tauntOpenMs` from the first hit). Live, a Warden joining at once and a Blademaster queueing Taunting Blade: he stayed the target 99 % of the time, and the fights were no longer idle.
- **Endurance isn't part of `ready`, and styles stop silently below 15 %.** Nothing reports it either. A tank that runs out loses its taunt without a message. One base run landed 2 Taunting Blades in 12 fights, and the cause is read from the code, since the report has no endurance figure; the same camp without a base landed 10 in 9. A group without an endurance song has reached 0 deaths in about 40 hunts, so this isn't urgent everywhere. Only Chants, Bard Nurture, Friar Enhancement and a Warden's Regrowth have one; a Skald doesn't.
- **Who shares XP levels on higher con:** two players level on yellow and orange (`minCon: 0, maxCon: 1, campLevelBand: [0, 1]`). The same two at level 7 made about 329k XP/h on orange beetles against 19-69k on blue and green, with no deaths.
- **Melee duos can roam (`roam: true`):** no base. A passive mob is an engage for everyone at once, they rest where they finish, and only an aggressive mob gets pulled to where the others stand. Against a base at the same camps it made about 5-26 % more XP/h (table in `groups/connla/lab_log.md` style: 5.75M against 5.49M on roane maidens, 3.89M against 3.09M on primroses, few runs), because hitting a mob among its friends brings more of them: 4-9 adds a run against 1-2, fights 27-33 s against 20-21 s, and the tank's lowest health 14-45 % against 34-36 %. A base spends 21-26 % of its time pulling. So roaming earns more and is riskier; a camp of 11 spawns ran dry in 20 minutes of either.
- **`aggroTolerance` also switches off the check for aggressive mobs on the way to a target.** With roaming, the walk to a passive mob now checks them regardless.
- **`findCamp` searches 60,000 units from the leader,** so it can come up empty in a region with camps. Moving the leader closer (a channeler) moves the search with it.
- Settings worth knowing (all in `PVE_SETTINGS`): `minCon`/`maxCon`, `camp` (hunt here), `campLevelBand`/`campAggressiveWeight`, `huntRadius`, `baseClearance`, `ready`, `holdMs`, `assistAfterMs`, `heal.*`, `rest`, `combatRange`, `formation`, `pullDistance`, `engageRadius`, `avoidAggressive`/`aggroPad`/`maxAggroNeighbors`/`pullAggressive`, `roamMs`/`newCampMs`, `retreat.*`, `shedLoadAt`/`keepItems`, `tauntOpenMs`/`peelAfterMs`/`guard`, `slotSlack`, `basePlan`/`aggroTolerance`, `pet.*`.

## The improvement loop (LLM observer)

1. Run: `bun groups/<g>/hunt.ts 180`.
2. Read `runs/<stamp>.md`: totals and the comparison first, then findings, then the member table. Open `.log` or the timeline for causes (who did what just before a death).
3. Change **one** thing in `strategy.ts`, with a comment naming the run and the finding.
4. Run again and check that the comparison line moved the right way; note it in `groups/<g>/lab_log.md`.

**XP/h between two runs is noisy:** the same two routines gave 19k and 69k in one series, because it follows which monsters came and who levelled. Fight length held steady (15-16 s) at one camp, so compare that, at one camp, and alternate the two versions rather than run them in sequence.

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

## Watching a run (gateway viewer)

`http://localhost:7780/viewer/group/<group>` (also listed on `/viewer`):
- **Without a run** the gateway builds the picture from the members' own states: every member on one map with health, power, load, client and controller status, the in-game group check, and the monsters they see merged by object id (`seenBy`, who targets whom). It also notes deaths on its own, with the corpse position, the killer and the last minute of the walk, so a death between hunts or on a solo walk to town is still on the map afterwards. These notes are kept in memory and lost when the gateway restarts.
- **With a run**, `runGroup` publishes its board to the gateway about once a second (`sdk/group/publish.ts`, `POST /groups/<g>/publish`). This adds the orders (phase, reason, objective, focus, puller, cc assignments, flagged when the caster's client doesn't see the target, waiting), each member's activity, the board's threat and cc marks, the base plan (camp, base, safe targets with distance, unsafe spawns with the reason, route), the observer's score so far, and the run log's events.
- **Pets** show with or without a run, from the members' own states. A member's pet is a small white dot, `name (owner)`, on a thin dashed line to its owner and a line to what it fights, and stays on the map with NPCs off. Its card has a `Pet:` row, or `no pet` when the run keeps one up for it. A mob on a pet reads `→ Hrafna's pet` and counts as a threat. An enemy's pet has a stroke in its realm's colour and a `pet` chip under Contacts, and no owner: the server doesn't send who (`PacketLib1124.cs:186-187`). The bot page has a Pet block, the region page a dot beside the bot, and the CLI a `pet:` part on the member's line.
- **Wind down** (the button, or `bun sdk/group/cli.ts <g> --wind-down`) is the timed end, sooner: the current fight is finished, the report saved, and a campaign goes on with its next step. Use it instead of taking control of a member. It needs the leader's bot.env password.
- The group page opens no game connection and offers no member actions. Member names link to the single-bot pages, whose control checkbox warns when the bot is in a live run.
- **Recent runs** lists `runs/history.jsonl` and opens each `runs/<stamp>.md` or `.log`, with filters for orders, deaths and failures, and the lines before each death.
- Publishing never touches a member connection and gives up for the run on any refusal. An older gateway answers with its help page, which costs one log line per hunt. Turn it off with `DAOC_GROUP_PUBLISH=0` or `runGroup({ publish: false })`.

## Pitfalls seen live

- **Overloaded members can't move:** loot piles up. An Enchanter at 59/40 encumbrance had max speed 0 ("walk: stuck ... max speed 0"); the group's `gather` waited for him forever. `shedLoad` now drops the heaviest backpack item not matching `keepItems` at 95 % load; selling needs a town visit, which the PvE policy doesn't plan yet.
- **`rest()` refuses while any NPC in view targets us or hit us in the last 6 s,** even one leashing home 3000+ away that the picture ignores. The `rest` behaviour checks `bot.getAttackers()` first and skips.
- **The first invite to each member went unanswered** right after the previous member joined; `formGroup` waits 1.5 s before each invite.
- **Formation depth counts in travel:** legs must chain from the last leg point, not from the group's centre, which trails the anchor by the formation's depth.
- **Ending mid-pull:** a mob already hit follows the tank after the run and killed it between runs. A run now finishes a pull under way.
- **Bring a friend:** a mob that gets *hit* calls same-faction mobs within 450 + 150 per extra attacker (1050 for a group of five), with a 200 % chance for five attackers, so two adds are guaranteed (`StandardMobBrain.BringFriends`, `baf_initial_chance` 0 + `baf_additional_chance` 50 per extra attacker). It happens once per fight, at the mob's own spot when it first targets someone, and only for a mob that was hit and has a faction (`_canBaf`). So a body-pulled mob fought at the base calls nobody there. The pull spot is what matters, and passive spawns need no room from the base. Red wolfhounds (faction 0, none) never call friends. `baseClearance` (default 700) was based on the wrong assumption; `basePlan` replaces it.
- **Retreating from mobs that keep up kills everyone:** at level 7 against an aggressive L8–9 camp in Lough Derg, a retreat at 3 attackers left all five dead "en route" while nobody fought back (runs 20261030-122154/-122647, 14 deaths). It happened again at level 9 (3 runs out of 3). Likely cause: nobody sprinted, and monsters run as fast as a player who doesn't. The `sprint` behaviour (before `retreat` in every role list) now sprints (x1.3, `MaxSpeedCalculator`) for the whole retreat and stops afterwards to save endurance. Live: the first retreat with sprint saved everyone, the next ones started at 6–11 % endurance and died en route.
  - The add count was also wrong: it counted the focus and adds whose mezz was still being cast. Every "4 attackers" retreat came 1–3 s after the mezz orders. In the group's last campaign hour a retreat came about every minute, all on routes through aggressive mobs.
  - So retreat is now off by default: in PvE, crowd control, the tank's taunts and guard hold adds better than running.
- **Constitution loss:** every PvE death from level 6 (`pve_con_loss_level`) lowers Constitution until a town healer (GameHealer) restores it for money (188 copper per point at level 9). After about a dozen deaths the Hibernian group had lost 10–21 Con each (casters at 25 instead of 40). `player.constitutionLost` shows it; the `healer` behaviour (second in every default role list) visits the healer near the bind point after a death, which also cures resurrection illness. Lost Con is added at release, not at death. The visit isn't interruptible: an orders change once aborted the walk, so the healer was out of view ("Target not found") and the member kept the loss.
- **Static spawn data vs npctemplates:** many `mob` rows are stale; the server replaces level and aggro from the mob's npctemplate when it has `ReplaceMobValues` (`GameNPC.LoadTemplate`). In Gotar (Midgard), passive L2 wild hogs were also stored as aggressive L12 rows, so the camp finder rejected a whole camp. `data/build.ts` now applies the template (highest level of its list), so `findNpcSpawns` levels and aggro match the live mobs. Mudmen in Hibernia, for one, are passive everywhere.
- **Aggressive camps two levels up are too much at level 7:** `campLevelBand: [1, 2]` with `maxAggroNeighbors: 1` meant 5–7 adds per fight. Passive camps at even con were clean. Lough Derg's camps from level 9 up are almost all aggressive. `campAggressiveWeight: 0` (the camp finder counts only passive spawns) and `pullAggressive: false` (pull only passive mobs) found passive red wolfhound camps for levels 8–10: 0.5–1.2M group XP/h without deaths.

## Unverified / next

- **RvR:** done for battlegrounds, see [rvr.md](rvr.md): enemy players as contacts with an inferred target, healer and caster marks, `killPlayer`, the `rvr-roam` strategy and RvR totals in the reports. Line of sight is still not real (the client always answers "clear").
- **Pets:** Necromancer, Animist, charms, minions and bombers stay out of the automatic behaviours; [pets.md](pets.md) has them solo, and what hasn't been seen live. A melee or tank member's list reaches `summonPet` only when nothing above it acts, as ever. Each class guide in [classes/](classes/mentalist.md) says what the class has.
- **Town visits** as a phase: not in the PvE policy. `groups/hibernia/town.ts` does it between runs (teleport to the trainer's town, train, wear upgrades, sell, teleport to the hub and `/bind`), and `groups/hibernia/campaign.ts` alternates it with hunts until a target level. For the training, `trainingDue` and `trainAtTrainer` are in `sdk/group` ([builds.md](builds.md)).
- **Across processes:** the blackboard is in-process. A run now publishes it to the gateway (one way, plus wind-down), but separately running per-bot scripts or MCP sessions still can't join one group.
- **Leaving or disbanding** a group (`/disband` in `formGroup` for members already in another group) is unverified.
