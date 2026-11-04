# Pets

What each class has, how a pet is summoned, ordered and read, how it fights, how it ends. Signatures are in [sdk/API.md](../sdk/API.md) "Pets". A coordinated run's rules are in [group-coordination.md](group-coordination.md#pets-sdkgrouppetsts). `bots/examples/pet.ts` is a grind with a pet, not run live yet.

Live on 2026-11-03 over four passes, at levels 10 and 20, solo, in three small groups and in Thidranki: every class below but Minstrel, Mentalist and Disciple. What only the C# or the code says reads "not seen live"; the list is at the end.

## Who has what

The kind is what `bot.findSummonSpell(kind)` takes. `bun data/class-sheet.ts <class>` has every rank.

| Class | Kind | Low ranks, at line level | What it is |
|---|---|---|---|
| Cabalist | `main` | Amber Simulacrum 1, Ruby 7, Sapphire 12, Emerald 20 (Spirit baseline) | Amber walks in and melees. Ruby casts every 3.1 s from where it stands, and melees what reaches it |
| Spiritmaster | `main` | Summon Spirit Fighter 1, Soldier 7, Swordsman 12, Warrior 20 (Summoning baseline) | Melee. Takes blows for its owner at heel, even passive |
| Enchanter | `main` | Underhill Friend 1, Companion 7, Ally 12, Compatriot 20 (Enchantment baseline) | Friend melees. Companion stands by us, casts damage and snare every 3.75 s, melees what reaches it |
| Druid | `main` | Call Minor Nature Spirit 1, Lesser 7, Nature Spirit 12, Major 20 (Nature, spec) | Melee, capped by the spell: L7, 12, 20, 32. Names are random per summon (lynx cub, wolf cub, ...) |
| Hunter | `main`, `charm` | Hunter's Companion 1, Pet 7, Ally 13, Protector 20; Minor Call of Gleipnir 1 (animals), Influence Insect 3 (insects) (Beastcraft, spec) | Instant, 120 s recast that survives a relog. Melee, capped at L7, 13, 20, 32 |
| Bonedancer | `main`, `minion` | Summon Bone Boss 1, Chieftan 15 (Bone Army baseline); minions at 15: Bone Dart (Bone Army), Bonemage (Darkness), Bone Patroller (Suppression) | A commander in the window, melee with styles. Chieftan's takes one minion, Boss's none. Bone Dart stands by us and shoots from about 1700 |
| Necromancer, Disciple | `main` | Call Minor Zombie Servant 1 (L2), Lesser 4, Zombie 7, Reanimated 12, Necroservant 20 (Death Servant baseline) | The owner goes into [shade](#shade) |
| Animist | `turret`, `fnf`, `bomber` | Main: Grove's Assaillant 2, Grove's Hunter 6 (Creeping, spec), Forest's Servant 5 (Arboreal), Battle Messenger 5 (Verdant). Fire and forget: Spore Spewer 1 (Creeping, spec), Forest's Advocate 5 (Creeping baseline). Bombers: Wisp Heat 1, Spirit of Anger 1 | [Turrets](#turrets) stand on a ground target. Battle Messenger taunts at 1350, then melees what comes |
| Theurgist | `fnf` | Call Minor Earth Elemental, Summon Minor Ice Spirit, Call Lesser Air Sprite 1, next ranks 7 (Earth, Cold, Wind, spec) | No window. One pet per cast, on the selected target, gone with it. Earth melees, Ice casts from range, Air stuns and melees |
| Sorcerer | `charm` | Persuade Will 1 (mobs to L10), Coerce Will 7 (L15), Compel Will 12 (L26) (Mind, spec) | A mob taken over, in the window. Persuade and Coerce take any body type here |
| Minstrel, Mentalist | `charm` | Captivating Melodies (Instruments 5), Illusory Enemy (Illusions 4) | Pulsing charms. Not seen live |

- **Level:** a share of the owner's, capped by the spell (`GameSummonedPet.cs:34-52`): 88 % for Simulacrum, spirit, Underhill, servant, turret and Theurgist's, 80 % for Hunter's and commander, 75 % for Druid's and minion. Live: L8 under a L10, L17 under a L20.
- **Spec:** a baseline rank comes with character level whatever the spec ([spells.md](spells.md)). A spec line needs the points: a Hunter with no Beastcraft stays at L7.
- **Minions** need the commander up ("You must have a controlled leader monster to summon into a group!") and room under it ("Your general already has as many followers as he can command!").
- **Base classes:** by the data, not seen live: with `start_as_base_class` only a Disciple has one from level 1, the others come at promotion, level 5, and Arboreal Path is listed for Forester and Valewalker too.

## Summoning

```typescript
const spell = bot.findSummonSpell('main');         // null if none
const s = spell && await bot.summonPet(spell);     // s.pet, s.petState, s.reason
```

- **A charm** takes a mob: `bot.charmPet(mob)`. `grind` can't choose one, so charm first, then `grind({ pet: true })`: a charmed wolf made 2 kills, one order per fight. Lose that pet and the run ends there, `not_supported`.
- **Cost:** a negative power is a percent of the pool. A focus caster, all these classes but Druid, Hunter and Minstrel, pays 1.2 times that with no focus item, 0.8 with a good one (`SpellHandler.cs:1204-1221`). Live with none: a L10 Cabalist 17 of 57, a L20 Bonedancer 26 of 109, a Necromancer 13 of 109; a Hunter 26 of 105 and a Druid 25 % flat. With a focus staff: 12 for 17, 8-11 for 13, about 6 for 10. An Animist's fixed power goes up too: Grove's Hunter 12 pays 14. `getSpellInfo` shows the base. Every cast also takes about 5 endurance.
- **Cast:** about 6 s for a Simulacrum, spirit, Underhill, commander or Druid's, 19.6 s for a servant, 2.4-5 s for a turret, 3 s for a Theurgist's, 4 s for a charm. A Hunter's is instant.
- **Power is checked at the begin and paid at the end.** Short of power: "You don't have enough power to cast that!" in about 100 ms. Nothing is paid for an interrupted cast or a refusal at the end of the cast. A resisted charm pays.
- **The refusals at the end:** "You can't do that here!" in a capital, after the whole cast. "You already have a charmed creature, release it first!" comes at the end for a Simulacrum, turret or charm, at the begin for a commander. So under `castSpell` a release inside a main turret's cast lets it through: released at 2359 ms, up at 3239 ms. `summonPet` says `pet_exists` before casting.
- **The new pet** comes 64 in front of us, defensive and on follow (`ControlledMobBrain.cs:56-57`). The window opens with no icons, and the spell's icon follows 33 ms later.
- **Its id is often the last one's.** `lastPetLoss.objectId` can equal the live pet's: compare `lastPetLoss.at`.
- **`replace`** releases only once the cast can go: not on a recast, short of power at the worst cost, or with melee on us. A charm can still lose the pet to what the client can't see: a wrong body type, a resist.
- **Room to cast:** a swing starts a timer of about 3 s, and a cast still under it at its half way ends ([spells.md](spells.md#caster-tactics)). On a 6 s cast that is any swing before the half way. On a servant's 19.6 s one only a swing from about 6.7 s on: 5.1 s in didn't stop it, 9.4 s did. A mob below us sets the timer 5 % less per level: at L20 a L7 35 %, a L2 10 %. After the half way no swing does: a servant's cast finished with the owner hit from 177 to 48 health. `grind` wants a mob on its way farther off than 220 × cast / 2 + 250 (`castRoom`, about 900 for a 5.9 s cast). Live: a 6.1 s summon with a mob running in at 176 went from 1380, and at 460 the first swing ended it 3.2 s in.
- **Our own swing holds a cast back** for the weapon's interval, up to about 5 s: "You must wait 3 seconds to cast a spell!".
- **An owner off the mesh:** the server looks for ground within 32 of the spot, and with none, or no line to it, puts the pet on the owner (`SummonSpellHandler.cs` `GetPetLocation`). It never moves then, though `walk` reads `follow` and `summonPet` succeeded. Seen with a client without navmesh and terrain, and after a DB move. Walk a step first; in a worktree point `DAOC_NAVMESH_DIR` at main's `server/navmesh` and `DETOUR_LIB` at its `lib/Detour.dll`, for the client and the script.

## Commanding

`killNpc` orders the pet as well (`usePet`, default true), `petKill` leaves it to the pet, `grind({ pet: true })` keeps a window pet up and fights with it, and says `not_supported` to a Theurgist ([his pets](#death-and-loss)). The rest are single orders, answered in about 50 ms. A repeat gets its line and no 0x88, so `bot.*` reads the line first.

| Call | Line after "You command the X" | Limit |
|---|---|---|
| `petAttack`, `petKill` | "to kill your target!" | 2000 in 3D from us, wherever the pet is |
| `petFollow` | "to follow you!" | |
| `petStay` | "to stay in this position!" | |
| `petComeHere` | "to come to you." | |
| `petGoTo` | "to go to your target." | 1250 on the plane |
| `setPetAggression('passive')` | "to disengage from combat!" | |
| `setPetAggression('defensive')` | "to defend you!" | |
| `setPetAggression('aggressive')` | "to attack all enemies!" | |

**Stances:**

- **Defensive** answers whoever hits its owner, in about 33 ms, with no order, from over 1000 away, and stays on it while another enemy kills the owner (`ControlledMobBrain.cs:614-638`). `usePet: false` doesn't stop that. It leaves a mezzed mob alone. A Theurgist's pet doesn't help its owner at all.
- **Aggressive** pulls what isn't grey to the owner (`ControlledMobBrain.cs:522`) within about 500 of the pet, and ignored greys as near as 77. Any walk order to one with a target turns it defensive by itself (`CheckAggressionStateOnPlayerOrder`).
- **Passive** stops a cast at once and walks back. **It doesn't shed a mob on it:** the mob chases and goes on hitting, with no answer. It reaches a commander's minion too. An attack order lifts it to defensive.

**Walks:**

- Follow stops about 80 from us, a minion 115-130, and runs at 260 to catch up. Attack, come and go run at 200.
- Come here and go to arrive exactly and stay until a follow, and `walk` keeps reading the order wherever the pet is. A pet on stay still chases a kill order.
- **After a fight** a pet on stay stays where the fight ended, unless the fight came within about 300 ms of the order. A pet on come here or go to was seen both ways: most runs stayed where the fight ended, one pass walked back. `ResumeWalkState` goes back until it has stood exactly on the spot (`ControlledMobBrain.cs:593-612`). Send `petFollow` when you want it.

**The server's target:**

- We have one selection. An order reads it and each of our swings reads it (`AttackAction.cs:84`). A cast takes its target at the begin (`SpellHandler.cs:451-453`), so moving the selection in mid-cast doesn't move the spell, though one queued behind it reads the selection at its own begin (`GamePlayer.cs:6147`): not seen live. So `petAttack(C)` moves our swing to C, and with C out of reach none land ("The river spriteling is not in view!"). `restoreTarget: true` puts it back. A refused order has moved it as well.
- A release takes the selection if that is a pet of ours, else the window pet (`CharacterClassBase.cs:336-341`). `releasePet` handles that. A raw `sendPetCommand('release')` naming a stranger's NPC released the window pet.
- The 2000 is exact, in truncated ints: a reading of 1999 or 2000 can be refused. `petKill` walks and tries once more. Orders reach a pet out of view at any distance, and a heal lands on one.

**Timing:**

- **Order to first hit:** 3.7-3.8 s for a caster pet, its first cast. 3.9 s for a melee pet over 600 units, 3.8-6.8 s from 1000-1500. A Theurgist's Air stuns 67 ms after its summon, Earth runs in for about 2.4 s, Ice's first cast lands about 3 s in. A L10 mob in a group dies in about 10 s, so a pet ordered at +6 s lands nothing.
- **Leave an order standing:** an order at a new target stops the cast in hand (`ControlledMobBrain.cs:222`), and a repeat on the same one leaves it alone (`:216`, not seen live). Eight orders at eight bears, 2.2 s apart, landed nothing for those 16 s; the first hit came 3 s after the last order. `petKill` doesn't re-order while its order stands.
- **What it can't reach:** it stands at speed 0 in attack state, with no line and no 0x88, and the state says it fights. Seen on a flying mob, a mob well under the water and a hill. A surface swimmer is fine. `petKill` reads `out_of_reach` after about 8 s and sends the follow that frees it. Seen once, unexplained: a servant stood 60 s on a mob it could reach.

**Spells on it:** `castSpell` of a `Pet`-target spell with no target lands on the pet, whatever is selected. A friendly heal goes at its id (a Druid's). A heal on a full pet still costs: "is fully healed", 4-6 power gone. A pack buff on a commander lands on its minion too.

## Reading state

- `sdk.getPetState()` is the window: `aggression`, `walk`, `icons` (at most 8), `targetObjectId`. It holds out of view. `undefined` on `state.pet` means an older client.
- `sdk.getPet()` is its entry, for position, `healthPercent`, `speed`. Null beyond 6000 on the plane (seen 6008-6029), and after a long same-region jump for up to 5 s. The window stays in both.
- `sdk.getSummons()` holds the pets with no window. Window orders answer `no_pet` for those: `releasePet({ target })` reaches them.
- `state.lastPetLoss` stays until the next loss. `bot.getPetAttackers()` covers the window pet and the summons.
- **Aim:** the server's 0xA1 target field reads 0 with no attack state, as a caster pet between casts, 65535 while attacking but moving or out of its attack range, and a real id only for one standing in that range (`PacketLib168.cs:820-828`). So the entry's `targetObjectId` flickers: 49 nulls in 164 samples against 0 in the window's. A caster pet at range reads null with `inCombat` false for its whole fight. **Read `PetState.targetObjectId`:** the order's line sets it within 100 ms, and it holds through 0 and 65535.
- **A mob** reads no target while it runs, and names the pet only once it stands in reach. `getPetAttackers` misses it till then.
- **0 % is alive** for anything with over 100 max health (`GameLiving.cs:2621`): 4 of 52 kills, for 2.3-5.5 s, once 7.3 s on 3-damage hits, and one read 0 then 2. Only the death event counts. A pet at 0-1 % crawls at speed 43.
- **`player.inCombat`** starts at the pet's first blow, not the order: false through a caster's first 3.2 s or a 5 s run. It goes 8 s after the last, and the server's own flag at 10 s.
- **Health lags a heal:** the line comes at once, the entry's reading 400-600 ms later, at times a few seconds.

**Lines from a pet.** They come to the owner at any range. A spell's hit also arrives as a `melee` combat event with result `other`.

| What | Line | Type |
|---|---|---|
| Melee hit | "Your X attacks Y and hits for N (-3) damage!" | `youHit` |
| Crit | "Your X critically hits Y for an additional N damage! (10%)" | |
| Miss | "The X attacks Y and misses! (14%)", "and is evaded!", "The X fumbled!" | `youHit` |
| Spell | "The X casts a spell!", then "Your X hits Y for N damage!" | `spell`, `youHit` |
| Proc, damage shield | "Your X hit Y for N damage!" | `spell` |
| Its resisted spell | "Y resists the effect! (12.0%)", naming neither spell nor pet | `resisted` |
| Style | "You perform your Havoc perfectly! (+16, GR: 0.722)", as for our own | |
| On it | "The Y hits your X for N damage.", "The Y attacks your X and misses!", "Your X was attacked by Y and their spell was interrupted!" | `damaged`, `action`, `resisted` |

## Fighting

```typescript
const r = await bot.grind({ durationMs: 60_000, pet: true });       // fight: 'pet' is the default, 'both' swings too
r.message;       // ends in what became of the pet: `; our pet died with X at 17 %, and it is coming for us`
r.lastPetLoss;   // with `mob`, as it stood at the loss. calledOff, stillFighting: what the end left
```

- **A pet's kill is ours:** full XP, and autoloot has no range (coins and items seen at 1500, coins at 4145). Grey pays nothing. A mob within 60 s of a charm ending pays nothing either: "This monster has been charmed recently and is worth no experience." By the code the XP stops at 6000: not seen live.
- **`fight: 'pet'`** stands off, and swings as well while a mob on us is within 250 and we have a melee weapon. **`'both'`** is `killNpc`. Melee is no answer for a list caster: a Necromancer lost to a L6 bandit, a Bonedancer's branch hits for 1-2.
- **Strength at L10:** Friend kills a L7 in 30 s for 40 % of its health, Companion in 26 s for 10 %, spirit soldier in 27-33 s for 45 %. A Druid's L7 takes a L7 in 39-58 s for 53-76 % and mostly loses to a L8. **At L20:** Hunter's Pet L13 wins a L12 in 40 s at -44 %, a L14 in 46 s at -61 %, loses to a L16. A commander takes about 59 s on a L17, 25 s on a L15 with Bone Dart. A servant 40-48 s on a L16 wolf. Grove's Hunter 23.5 s on a L14 bear.
- **Adds are what kill a pet.** Its run-in collects aggro: three crabs joined on the way, dead in 18 s with the target at 56 %. Three L8 killed an Amber in 26.5 s against 50.4 s with fewer. A charmed mob beside its old camp is attacked at once.
- **A mob stays on a pet.** It stayed through 20 s of the owner's swings beside it, 16 arrows, and an owner at 30 health who swung first. But a first spell of the pet's that is resisted, or an owner walking close, can bring it to the owner. A heal from a third party draws a L6-9 off the fighter within seconds. **Damage decides, not the kind of attack** (`StandardMobBrain.cs:553-575`): a 57-damage nuke from 738 took a mob off a spirit soldier in about 0.5 s, and it stayed on the owner about 13 s more. A Right of Life as the opener, 24 %, kept a bear on its owner for 15 s against a turret's 5 % hits. A debuff with no damage pulls at full health (Fatigue Body, Sap Strength); after Sap Strength the turret's first hit took it back.
- **It fights on after the script ends,** and its XP arrives later. The mob can then kill an idle owner.

**When the pet is gone the mob comes for the owner.** That was most of the test bots' deaths.

- **Which:** the mob the pet hit (`StandardMobBrain.cs:566-571`), even on its first run-in at the pet, never named: a bear at 94 % ran in from 1484 and swung 6.5 s after the release. One the pet was on its way to and never reached stays where it is, at 100 % on nobody: `; we lost our pet on its way to X`. An add that took no hit from it walks home while we stand off: five crabs read on us, four cleared within 0.8 s. Standing among L7 spiderlings (aggro 200), all six on the pet still read on us at our death 3 s after its, and we had lost 77 % before it went. Inside a mob's aggro range it can have us on its list with no hit from the pet (`StandardMobBrain.cs:73-90`).
- **When:** after a death it stands about 1.6 s first, after a release it runs at once. From 1500 it took 9-10 s to reach a caster, 8 s from 1800, 2.5-3.2 s from nearby. Below 33 % it slows, to 20 % of its speed at 0 % (`MaxSpeedCalculator.cs:147-150`): 57 units/s at 4 %.
- **How it reads:** the wire says no target on its way. Solo the model names it on us (`getAttackers`, `mobRunInMs`). In a group, or with another pet of ours beside it, it reads on nobody until its next swing, and the board keeps it a threat up to 15 s.
- **What it does:** a L8 hits a L10 Cabalist for 50-56 of 100, a L14-18 hits a L20 in cloth for 74-91. A new pet has little threat against what the owner has: the mob left after 4 s once, 18 s once, and not within 6 s once. With a caster mob on us and no pet, no cast finishes: 8 of 8 failed. So keep room to summon, or don't wait for it.

**Tether:**

- A main pet over 10000 from its owner is released (`ControlledMobState.cs:51`), seen at 10006-10037.
- A pet out of every player's view goes after about 52-60 s, whoever stands near keeps it. A follower doesn't meet either, as it jumps with us.
- Both read `released`, name null if the entry had gone. Seen once, unexplained: a commander on stay 6500 away, told to come here, was lost within 88 s.

**Regen:** out of combat with no aggro a pet gets 10 % of its health per 6 s (`HealthRegenerationAmountCalculator.cs`, `GameLiving.cs:2448`). In combat the next tick is 30 s off and small, which is why the wait after a fight varies: none in some runs, 22 s, 30 s, and once 1 % at 7 s then nothing until 37 s. Sitting makes no difference. A servant is left out of that: 0.19 % a second at L17, 0.75 % at L2. `rest({ petHealthPercent })` waits for it; a rest for 90 can end at 98. While a pet fights `rest` says `in_combat`: the owner's own regen ticks every 10 s then, not every 3 s.

## Death and loss

33 ms is a server tick. The two lines are "You lose control of the X!" and "You release control of your controlled target." The pet's own "The X dies!" comes only within 512.

| What | Order | `cause` |
|---|---|---|
| The pet dies | 0xA2 type 0, next tick the 0x88 close and the lines | `died` |
| Release, quit | Close, lines, 0xA2, in one tick. A charm: no 0xA2, a 0xDA with the mob in realm none | `released` |
| The owner dies | 0xAE, next tick the close and lines, the pet's 0xA2 up to 200 ms later. `pet` is null at the blow | `owner_died` |
| Region change | 0xB7, close, lines, 0xA2 | `region_change` |
| Tether, leash, a death out of view | Close alone | `released` |
| Same-region jump | 0xA2 type 1. No loss, the pet jumps too. On 484-6275 units the 0xDA comes at once, on longer the client asks after the next 0xA1 | none |

- **At the moment of a death** the server still refuses a summon for up to about 110 ms before the close. `summonPet` tries once more.
- **The owner's death** takes the window pet (`GamePlayer.cs:5988-5989`). A Theurgist's and a fire-and-forget turret outlive it, fight on, and their lines reach the corpse. A corpse can't release in its first 10 s: [death-and-rest.md](death-and-rest.md).
- **A minion** goes with its commander, in the same tick or 200 ms later. One out of view stays in `state.summons` until the window closes or its id goes elsewhere. A minion summoned with its commander out of view is ours, and runs to it.
- **A charm's end:** every mob on the pet runs at us. The ex-pet doesn't for a non-pulsing charm, though an aggressive one attacks a few seconds later anyway. Resist rate is printed: 14 % on a L8, 3.5 % on a L1 for a L10's Persuade Will.
- **What a charm refuses:** a Sorcerer's or Hunter's takes no mob in combat: one that swung or was hit in the last 10 s, or is mezzed or stunned, and for 10 s after that ends (`CharmSpellHandler.cs:339-340`, `GameLiving.cs:227`, `CrowdControlECSEffect.cs:43-46`). That refusal comes after the whole cast, and costs no power. A cast ending about 10.9 s after a mez ended was taken; the server's refusal during a hold not seen live.

**Theurgist's pets.** No window, and past 512 no line when one goes: only a death event with no attacker. Measured to expiry: Air 19.9 s, Ice 24.9 s, Earth 29.9 s (60 s from Earth 32, by the data). Each dies 33-600 ms after its target, with no switch. With the mob alive at the last expiry it is on the owner within about 2 s. A L10 holds 6 at 57 power, 10 with a focus staff, so the server's cap of 16 is out of reach. `grind({ pet: true })` says `not_supported` at once and window orders `no_pet`, so loop it yourself: `bot.summonPet(spell, { target: mob })` per pet, `sdk.getSummons()` for what is up, the mob's death event for the end, and finish it before the last pet's life is up. `findSummonSpell('fnf')` gives one: at equal level the first listed, so Earth at ranks 1 and 7 (read at 1). Name Ice or Air to get them. A run's `fnfPet` has the same tie: Ice and Air were never cast in a run.

### Turrets

- **A ground target first:** `summonPet(spell, { groundTarget })`. Refused with none at once and for free: "You have to set a ground target for this Spell.", "You can't summon a turret without a ground target !". A spot too far from the mesh is dropped, "Your ground target is not visible!", and that wipes a good earlier spot too. `groundTargetSnap` (`sdk/ground.ts`) predicted every one. An NPC's coordinates are always good. The spot survives death and region change, and a relog clears it.
- **In water:** z = surface - 16 stood at every depth tried, but for one gap.
- **It never moves.** `walk` reads `follow` for life and walk orders answer `immobile`. No leash showed: still ours at 4486, and shooting its last target with the owner over 5000 off. By the code a main turret has the 10000 and out-of-view limits of any main pet (not seen live); a fire-and-forget one has no 10000. Only the order needs us within 2000.
- **Reach is the spell's:** 1000 for Grove's, 1350 for Battle Messenger's taunt. A cast begun in reach still lands on a mob that has left. A mob run out of reach has it standing: `petKill` says `out_of_range`.
- **Fire and forget:** 120 s (84 s seen, probably cast under resurrection illness). At most 10 in 1000 and 12 per player: "You can't summon any more turrets in this area!", "You cannot control any more turrets!". They pick only what isn't grey to the owner (`ControlledMobBrain.cs:518-523`): under a L20 they took L14s and left a L13 alone at 67 away, though that is green to a L17 turret.
- **Release Clump:** `castSpell('Release Clump', turretId)` kills our turrets within 500 of that one, it included, at range 4000, for 3 power: "Spore Spewer dies!" each. With no target it goes from the window turret, which dies too (tests only). `releasePet({ target })` takes just one.
- **Bombers** read `isPet` and `isPeaceful`, and their hit reads as the owner's own. A mob the hit doesn't kill comes for the owner: a L14 bear walked at us and died at about 800. Summon is silent, and the bomber dies on delivery.
- **The owner isn't safe at 900:** mobs near it hit it, and everything on a turret turns on it when the turret goes. Standing within about 400 of a turret among L14 bears killed one 3 times.

### Shade

- **The summon puts the owner in shade.** `player.isShade`. No melee ("You cannot enter combat while in shade form!"), no second summon ("You are already a shade!"), and attackers can't reach it (`AbstractServerRules.cs:449-455`). A DoT from before still ticks, and can kill: "You have died.", 33 ms later the close and "You are no longer a shade!", `owner_died`.
- **Tether:** 1500 for 10 s with warnings, 2000 at once (`NecromancerPetBrain.cs:300-326`). `petKill` walks with it. A hard cut has no "bond" line. The server's clock outlives the servant, so the warnings can come with no pet up.
- **Leaving shade sets our health** to min(current, max × the pet's %), with the pet's % counted as at least 10. On the pet's death 10 %: 251 to 26. On a release at 71 %: 245 to 174. At 100 % unchanged. **A zone change or quit uses a stale percent** (`ClassDisciple.cs:155-161`): `releasePet` first. A low servant's percent falls fast: one hit of 37 on the L2 is 57 %.
- **Spells have two halves:** Vitality Theft is the owner's instant and the servant's 2.9 s, Regenerate Flesh the owner's 2.9 s and the servant's instant. The queue is the current cast plus one, last wins, every discarded one paid: 8 paid, 2 cast. Cast again only after "The necroservant cast a X spell!". "will begin casting this spell after its current action" also comes at a lost pet's last swing, with nothing cast.
- **Its buffs matter:** with Facilitate, Regenerate Flesh and two Servants a L17 wolf took 54.7 s and 31 % of the servant. Unbuffed, a L19 took all of it in 22 s. Adds on wolves came in all six sessions.
- **Healing it:** Regenerate Muscle (Death Servant 17) heals the servant 27 every 3 s for four ticks, 12 power with no focus item, about 20 % on a L17: minutes of rest saved. A rest alone is 0.19 % a second after about 13 s.
- **A cast running when the owner dies goes on:** a servant appeared at the bind after a release. Seen once.

## Groups

A run wraps each member's list in `withPets`: `petControl` on a 250 ms side tick (only `orders.focus`, after `pet.holdMs`, never a mezzed target, nor a rooted one unless nothing else is free, passive and follow in a retreat), `fnfPet` for a Theurgist, `petHeal`, `summonPet`, `summonOnTheWayBack`, `petBuff`. Settings: `pet.enabled`, `pet.holdMs`, `pet.summonMana`, `pet.healBelow`, `pet.fnfFloor`, `pet.fnfLifeMs`, `pet.waitForSummon`, `pet.strayFightsOff`; a member opts out with `pet: false` in its `character.ts`. Necromancer, Animist, charms, minions and bombers aren't automatic. With a real tank at a base camp it played right: one order per fight, after the hold, on the focus only, damage split to the unit. **It doesn't make a group faster by itself.** Five at L10 on L8-9 drakes: pets on 140 and 112 kills/h, `--pet.enabled=false` 160 and 156. Fights were equal (11 s) and the difference was downtime for power, 55 % against 34 % on the Theurgist, whose 10 pets dealt 72 where 15 nukes dealt 505. `pet.fnfLifeMs` came after that and hasn't been measured. Lake serpents at L10-11: 4 kills against 3-4, a commander and a soldier ordered at +6 s dealt 0. With a L20 tank, L6-8 mobs and two L10 pet owners, alternating runs favoured pets: 2.17 against 1.47 kills a minute, 7.0 against 9.6 s of engage a kill, 1.47 against 2.3 nukes a kill. A small sample, on mobs grey to the tank, so no XP to compare. The rules, the report's `## Pets` table and its findings: [group-coordination.md](group-coordination.md#pets-sdkgrouppetsts).

## RvR

Live in small runs at L20 in Thidranki, two against two, not a full round. The strategy's side is in [rvr.md](rvr.md).

- **A shade can't be attacked,** by anyone or by a pet order: "You can't attack a shadowed necromancer!". Its servant can. `NearbyPlayer.isShade`.
- **PvP immunity covers pet orders both ways:** "X is temporarily immune to PvP attacks!", "You can't attack players until your PvP invulnerability timer wears off!". `petAttack` reads both as `immune`, with `retryAfterMs`.
- **The death packet names a pet's owner,** never the pet, also for a turret with its owner 5900 away. `killedBy` says `pet:<realm>` from the newest blow.
- **A pet's kill is its owner's own:** "You just killed X!", with the XP and money shared in his group.
- **Pets hit cloth hard:** a commander 85-114 on cloth, 23-31 on a pet. A L13 pet killed a L20 Necromancer in 4 hits, and L20s in cloth die in 7-15 s to two pets.
- **An enemy pet** is a contact with `isPet` and no owner, and worth no XP. A caster pet's target shows only on its victim's client, for moments. A bomber stays off the board, and its hit reads as the owner's.

## Traps

- **Off the map:** `Region.GetZone` is null outside every zone. Region 200 has none west of x=286720 around y=648000, and `walkTo` will go there. A summon there kicks the caster to the character screen, and a pet walking there is removed with no 0xA2 (`released`).
- **Teleporters and stones** go by the server's 10 s, which counts the pet's fight: refused 8.0 and 8.1 s after a kill with `player.inCombat` already false, fine at 11 s. Lines: "You can't use this item in combat!", "You have been in combat recently and cannot use this item!". Before the pet's first blow one still works. Zone points have no such check.
- **Ids are reused at once:** a dead mob's id on our new pet within a second, a released pet's on a horse in 300 ms (`Region.cs:955`). Key on `objectId` only within a fight.
- **A mezz takes no NPC under 75 %** ([spells.md](spells.md#crowd-control-what-repeats-do)), and a pet's first swing breaks one with no line. So does its DoT: a bear mezzed under its pet's Corrosive Smoke woke 2.7 s later.
- **Passive doesn't shed a mob.** An adder killed a passive pet, a charmed bear at 50 %, in 28.5 s with no answer, and defensive afterwards re-engages at its next hit.
- **A nuke in flight when the pet kills** ended as "You must select a target for this spell!" 1.2 s after the death, no power spent. `castSpell` now ends on the death: `already_dead`. The server's cast runs on to its end, so the next `castSpell` with a cast time waits that out; sent during it anyway, it reads `must_wait` with what's left (`You are already casting a spell! You prepare this spell as a follow up!`). A follow-up behind a cast that goes on to its end starts by itself; behind this one the end check fails, and the server drops it without a word or an 0x0B (`SpellHandler.cs:1091-1097`, `CastingComponent.cs:224-228`), so nothing holds the next cast once a begin is overdue. A pet's own cast relays the same line to us.
- **Spirit lines read wrong:** "The spirit soldier cannot seem to move!" at the summon and "recovers from the stun." at the release stop nothing. It takes blows from within 128, 75 % by the code (`AttackComponent.cs:1429-1436`), every one at heel live, none at 517. The mob's target then flips between us and the pet on each swing.

## Not seen live

- **A pulsing charm:** no Minstrel or Mentalist ran. All of it comes from `CharmSpellHandler.cs`.
- **A pet's styled hit beside its owner's:** a commander's "You perform your Havoc perfectly!" was seen, with an owner who has no styles. An owner and a pet both styling, or any other pet styling, no. The SDK tells them apart by the style's name (`sdk/actions.ts`).
- **`bots/examples/pet.ts`** has not run. `grind({ pet: true })` under it has.
- **A Disciple, and a pet at promotion:** every shade run was a Necromancer, and [Base classes](#who-has-what) comes from the data.
- **Fixes after the last live pass, tests only:** `castRoom` in `grind`, `mobRunInMs`, `pet.fnfLifeMs`, the map margin, a shade out of `decideRvr`'s focus, `killedBy`'s `pet:<realm>`, `castSpell` ending on a target's death, the board's 15 s threat, `GrindResult.stillFighting` and the end notes `; still fighting X at N %`, `; our pet at N %` and `it is on us at N %`, `replace`'s refusal for a mob on the pet, the `firstSeenAt` rule in `npcJustDied`, `Release Clump` with no target, and the group's list in [group-coordination.md](group-coordination.md#pets-sdkgrouppetsts). One Midgard re-test since has shown `petControl`'s side tick and a tank's pet held passive.
- A shade's end in a real RvR fight (the servant reached 45 %).
- `theurgist_pet_cap` (16), and the XP limit at 6000.
- A pet mezzed by a mob with its order standing, a defensive pet on a grey attacker (`ControlledMobBrain.cs:522`), and an enemy pet held by a tank.
- An order held back in a group run beyond 2000 or out of view: none came up.
- The viewers' pets in a browser, in these passes.
