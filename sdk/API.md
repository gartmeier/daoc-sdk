# SDK API Reference

> Auto-generated from TypeScript source. Do not edit directly.
> Run `bun run docs:api` to regenerate or `bun run docs:api:check` to verify it.

## Execution model

- `bot.*` methods are high-level helpers. They observe evidence (position, HP, inventory, messages, dialogs) before reporting success. Inspect `success` and any `reason` or `message` on the result.
- `sdk.send*` methods are low-level dispatches. A successful `ActionResult` means the headless client accepted and dispatched the action (packets written); it does **not** prove that the DAoC server applied it.
- Methods whose signature returns `Promise<...>` are asynchronous and must be awaited. State reads (`get*`, `find*`) are synchronous reads of the last snapshot.
- Coordinates are DAoC global region coordinates: `x`/`y` on the ground plane, `z` is height. Headings are 0..4095 (0 = +Y, clockwise). Distances are world units (~191 units/s at full run speed).
- Backpack slots are 40-79, equipment slots 10-37 (`EquipmentSlot`). `objectType` is an `ObjectType`. `getInventory()` lists occupied slots only: pass `item.slot`, never an array index.
- `state.tick` is the client publish counter, not a server tick; `waitForTicks(n)` waits for n more published snapshots.

## BotActions (high-level)

### Movement

| Signature | Description |
|---|---|
| `async walkTo(x: number, y: number, options: WalkOptions = {}): Promise<WalkResult>` | Walk to region coordinates x,y. Re-issues the move after server corrections or stops, fails on death, region change, no progress (`stuckMs`) or the deadline. |
| `async walkToObject(target: ObjectTarget, options: WalkToObjectOptions = {}): Promise<WalkToObjectResult>` | Walk until within `range` (3D) of an NPC, player or object; follows a target that moves. A target that dies on the way ends the walk at once: reason already_dead, with targetDied, by its death event or a player's dead flag. So does an id gone just after its death, asked for or come to. A corpse we set out for is no such target, and one merely out of view reads not_found, where it was last seen. |
| `async followPath(waypoints: Point[], options: Omit<WalkOptions, 'z' \| 'pathProvider'> = {}): Promise<WalkResult>` | Walk through waypoints in order (one continuous move). |
| `async stop(): Promise<ActionResult>` | Stop moving; observed when the mover reports it is idle. |
| `async face(target: Exclude<ObjectTarget, number> \| Point \| number \| { objectId: number }): Promise<FaceResult>` | Turn to a raw heading (a number, 0..4095), toward a point, or toward an object (NPC/player/object, name pattern, or `{ objectId }`). A bare number is always a heading: object ids are small per-region integers (Region.cs:886) that overlap it. |
| `async follow(player: PlayerTarget, options: FollowOptions = {}): Promise<FollowResult>` | Follow a player client-side (OpenDAoC has no /follow or /stick; the retail client does it locally): keep within `distance` until `until`, the duration ends, or the player is lost for 5 s. |

### Combat

| Signature | Description |
|---|---|
| `async target(target: ObjectTarget \| null): Promise<TargetResult>` | Select a target (NPC, player, object, or our own objectId) and observe it in player.targetObjectId. |
| `async attack(target: LivingTarget, options: { timeout?: number } = {}): Promise<AttackResult>` | Approach, target, face and switch melee on against an NPC or a player (enemy players are named by race: pass the objectId); observed via attack mode or a swing. Reason 'immune' (with retryAfterMs) when PvP immunity, ours or the target's, refuses the swing, 'crowd_controlled' (with retryAfterMs) when we are mezzed or stunned, and 'already_dead' when it died as we came, with attack mode switched off again (attack mode carried over from another target says that line of that one, so then only with this one dead or gone in our view). In shade: reason 'refused', with no walk; with no melee weapon in slots 10 or 12 too (a shield, a left-hand weapon alone and a bow are none). With a bow in hand the server's line comes once in range: this takes a melee slot in hand once, as killNpc does (takeMeleeSlot), and tries again; if the line stays, reason 'refused' with it. The walk ends at the target's death, at once, and an id gone just after its death reads already_dead as well; one merely out of view reads not_found. The swing goes off by itself at the target's death, also after this has returned, as long as our selection is on it or went with it: the server's would stand there, at a player's corpse with "X is already dead!" each round, at a mob's with no line at all, as the client clears the selection at its remove (client/session.ts:496), and player.inCombat with it. A call that comes to nothing leaves a swing on another target on, and that one still goes off at that target's death. A refusal for good goes the same way, reason 'refused': a player of our realm says so only with the next round (a duel takes the id, and the client can't tell one), so at one this waits a weapon's interval before it reads success. A line we can walk or turn out of ("not in view") keeps the swing. |
| `async killNpc(target: NpcTarget, options: KillOptions = {}): Promise<KillResult>` | Fight an NPC to the death: walk into melee range (adopting its z), face, target, attack, re-approach when it moves, use styles, and wait for the death (the remove packet, never 0 %: a mob under 1 % reads 0 and fights on, GameLiving.cs:2621). Reports XP, RP, money, items and the duration up to the death. Reason 'crowd_controlled' (with retryAfterMs) when a mezz or stun refuses our swing. A window pet that isn't passive gets the order too (`usePet`), as soon as we are within range of one and again if it ends up on another mob; a passive one stays out of it. A shade can't melee (ClassDisciple.cs:91), so in shade this is petKill, with its reasons and only `timeout` of these options, and with `usePet: false` reason 'refused', with no walk. With no melee weapon in slots 10 or 12 (a shield, a left-hand weapon alone and a bow are none) reason 'refused' at once, with no walk: the server would only say so at the first swing (AttackComponent.cs:548). A pet we would order still gets its order, and fights on after this returns: the message says so. With a bow in hand the server refuses melee: this takes a melee slot in hand once and fights on: the one the first of `styles` needs, else as takeMeleeSlot picks. On "This style requires a X weapon!" it uses the slot holding X, once per fight. Reason 'pet_died' only with `endOnPetLoss`. `npc` is the entry as it ended, or the one we began with if it has gone. |
| `async killPlayer(target: PlayerTarget, options: KillPlayerOptions = {}): Promise<KillPlayerResult>` | Fight an enemy player to the death, like killNpc: walk into melee range (adopting its z), face, target, attack, chase while it moves (players are not extrapolated: we follow the latest position) and use styles. Enemy players are named by race, so pass the objectId (or the NearbyPlayer); a name is only a fallback. Success on its death: the death event or isDead, never 0 % health, which is truncated (GameLiving.cs:2621): a living player with a few hit points reads 0 %. Reasons: 'not_found', 'already_dead', 'not_attackable' (our realm), 'immune' (PvP immunity, ours or its; retryAfterMs), 'crowd_controlled' (we are mezzed or stunned; retryAfterMs), 'target_lost' (left view alive: stealth, range), 'out_of_reach' (beyond maxChaseDistance), 'refused' (also in shade, with no walk: see petKill; with no melee weapon in slots 10 or 12 too), 'died', 'timeout'. With a bow in hand the server refuses melee: this takes a melee slot in hand once and fights on, as killNpc does. Does not wait for XP after the kill: rpGained counts the realm points that arrived by then. |
| `async castSpell(spell: NamePattern \| Spell, target?: ObjectTarget \| null, options: CastOptions = {}): Promise<CastResult>` | Cast a spell (name, RegExp or Spell) on a target, or on the current target when none is given; a friendly spell with no target given lands on ourselves, whatever is selected. Selects the target every time (the server drops it on death without telling the client) and re-selects and retries once on "You must select a target" while that target is still there (CastOptions.retryNoTarget). Observes the cast start ("You begin casting", cast animation) and completion ("You cast a <spell> spell!", or an effect/damage/resist once the cast time is up). Reason 'died' when we die mid-cast; 'dead' when already dead before casting; 'crowd_controlled' (with retryAfterMs) when we are mezzed, stunned or silenced. A cast whose target is immune to its effect succeeds with effectImmune. A spell that targets Pet, with no target given, lands on the pet whatever is selected: no walk, select or face, and reason 'no_pet' without one. A Necromancer's servant spell succeeds once the servant takes it on: the server says nothing of the owner's half. If all we know is that the servant will get to it, the result has `queued`: a later cast replaces it, and each is paid, so cast again only after the last one lands. Its refusals: out_of_range (the servant is too far from the target or can't see it), invalid_target (power transferred to ourselves), no_pet (it went). An Enemy spell with no target given while we have selected ourselves or a pet of ours: 'no_target', uncast (the server moves a servant's new target onto us when we have none, NecromancerPet.cs:27-29). Reason 'pulse_cancelled': that pulsing spell was running, and the cast only stopped it. An Enemy spell that can't land is refused before any walk, send or selection, a target given or selected: no_target at our own id, not_attackable at a peace flag or an untargetable NPC (the server would say nothing), invalid_target at anything of our realm, our pets too, and a duel partner: the client can't tell a duel (NormalServerRules.cs:50-52). An Enemy spell with range 0, a point-blank area spell, needs none of that with no target given: it goes off around us, and the server looks at no selection (SpellHandler.cs:682-686, :918, :1591). What is selected stays selected, and the result names it only if the spell could hit it. A target given is judged as above. Reason already_dead: a player the model knows is dead, before anything is sent, or the server's answer (SpellHandler.cs:783), not for a Corpse spell, nor for a Group spell, which has no such check and lands on the living with a corpse named (HealSpellHandler.cs:76-78): its message names nobody, and `target` is only what was selected. An NPC's 0 % is no such knowledge: it is truncated (GameLiving.cs:2621). A Corpse spell at a player the model holds alive, with health to show for it, at any NPC or at our own id: reason invalid_target before any walk, in the server's words (SpellHandler.cs:759-766), and its answer for what the model hasn't seen has the same reason. A target that dies during the cast ends the wait at its death: reason already_dead, with targetDied, also with "You must select a target for this spell!" beside it, which is all a cast gets as it ends with its target gone. The server says nothing to a cast at the dead (SpellHandler.cs:852-1007, AbstractServerRules.cs:337) and goes on until the cast's end, so a cast sent in that time is held as a follow-up. A walk doesn't break it: the client's mover holds for the cast's time + 250 ms (client/session.ts:501), so an owner running after this stands up to about 2.8 s of a 2.5 s cast. A sit does, and a swing request at once, "Your spell is cancelled!" (AttackComponent.cs:661-665). The next castSpell with a cast time therefore waits for that end, at most what the cast had left, unless an 0x0B ended it; an instant goes beside it (CastingComponent.cs:376-377), and nothing else is held. Not for what lands on ourselves, on the pet or on a group, nor for a Corpse spell, and not for what doesn't hang on the mob selected: an Area spell, a Cone or an Enemy spell with range 0 goes on and lands on what is there (SpellHandler.cs:908-918). A cast sent during one that is still running (a raw send's, say) reads must_wait, at once, with retryAfterMs what's left of that one: never no_response, and the running cast's own lines are no answer to it. With "You prepare this spell as a follow up!" the server holds this spell and starts it by itself, so the result has followUpMs, and the next castSpell waits that out as well; unless that cast fails at its end (its target gone, say): the server then drops what it holds without a word, and the next castSpell goes once no begin has come 500 ms past that end. A pet's attack order refused just before ("You can't attack ...", PvP immunity) answers on the same stream: within 500 ms of sdk.sendPetCommand('attack'), and with this cast's begin line there or in the same tick, that line is the order's. With no begin line by then it is this cast's too. Release Clump (TurretsRelease) needs a turret of ours selected where other Pet spells go to the pet by themselves (TurretSpellHandler.cs:20-41): with no target given this selects the window pet or a summon, unless one of ours is selected; its refusal is invalid_target. What was selected before comes back with the cast's end, if it is still there, else nothing is selected. The walk into range stops inside it by the smaller of 10 % of the range and 150, in 3D, by what the target reads as it goes. A target that moves on from there gets the server's "That target is too far away!" at the cast's end: reason out_of_range, and the caller goes again: for 30 s or until a cast at it lands, the next walk at it stops short by as much again as it left in a cast, by our own readings, at most at half the range. A height it can't climb leaves the first reading inside the range good enough, and the cast goes from there. A target that dies on the way ends the walk at once, with nothing cast: reason already_dead, with targetDied, a friend's too. A corpse that gets up ends it as well, reason invalid_target in the Corpse spell's own words. An id gone just after its death reads already_dead with targetDied, and one merely out of view not_found. Reason refused for a song with no instrument in hand, naming the song and the instrument we wear, with retryAfterMs of 60 s: only a change of hand cures it. Reason interrupted has retryAfterMs 2200, the server's own wait (SpellHandler.cs:372). A mezz's or a stun's line beside the 0x0B reads crowd_controlled, and so does Amnesia's, which ends a cast with no 0x0B and no line of the cast's own (AmnesiaSpellHandler.cs:50). An item's recast line ("... to discharge this item!") answers the useItem and says nothing of the cast. Reason not_visible: "You can't see your target from here!", a hill between us by the client's LoS answer (sdk/vision.ts lineOfSight). castSpell then steps toward the target to the first spot that sees it over the terrain (sightStep), up to SIGHT_STEP_MAX (with `approach: false` only up to SIGHT_STEP_SHORT, and only when such a spot is that near), and casts once more; its message then says so. |
| `castHeldLeftMs(spell?: Spell): number` | How long the next castSpell of `spell` would wait for a cast the server runs on and castSpell no longer watches (see castSpell), in ms: 0 with none, and for an instant, which goes beside it. Without `spell`, for one with a cast time. For a caller whose reasons for a cast can go stale in that wait: it can come back after it and look again. |
| `async useStyle(name: NamePattern): Promise<SkillUseResult>` | Queue a combat style for the next swing; observed by "You prepare to perform a ...". |
| `findKillableNpc(options: FindKillableOptions = {}): NearbyNpc \| null` | Best monster to fight nearby: killable, not engaged with someone else, within the con (or level-difference) window, nearest first. A pet we just lost counts as our own fight for 10 s, hurt as it is. |
| `findKillableNpcs(options: FindKillableOptions = {}): NearbyNpc[]` | All candidates findKillableNpc considers, best first. |
| `getAttackers(): NearbyNpc[]` | NPCs fighting us, nearest first: their reported target is us, or their swing or spell landed on us within the last 6 s. The server reports a target only for a mob standing within its attack range and in attack state, so the hits are what shows a caster at range or a mob running at us. |
| `getPlayerAttackers(windowMs: number = PLAYER_AIM_MS): NearbyPlayer[]` | Enemy-realm players whose melee swing or spell effect landed on us within `windowMs` (default 6 s, longer than a two-handed weapon's or a bow's swing), nearest first. The server never sends a player's target, so these combat events are the evidence. |

### Other

| Signature | Description |
|---|---|
| `async interactWith(target: ObjectTarget, options: InteractOptions = {}): Promise<InteractResult>` | Walk within ~150 of an NPC/object and interact (right-click). Success needs a response: merchant/trainer window, NPC dialog, dialog box, text window or a message from the NPC. |
| `async acceptResurrection(options: { timeout?: number } = {}): Promise<AcceptResurrectionResult>` | Wait for a resurrection offer, say yes and observe the revive. We come back standing at the caster, with the spell's health and power (10 % and none for a baseline rez). That saves the release's XP loss, grave and constitution loss; resurrection illness comes all the same. Reasons: not_in_game, not_dead, timeout (no offer came), expired (the offer was gone when we answered). |
| `async takeMeleeSlot(options: { styles?: readonly string[]; weapon?: string; keepOnTie?: boolean } = {}): Promise<MeleeSlotResult>` | Take a melee weapon in hand, for a fighter who may stand with the wrong one or a bow: the state can't say which is active, and the server swings what it is. The weapon the first of `styles` needs, else the higher spec of the two weapon types worn, else the one we took last, else the right hand. With `weapon` (a style tooltip's word, as "This style requires a X weapon!" has it) the slot holding that. Observed by the server's "You attempt to use" (GamePlayer.cs:6564), which comes for a weapon in hand as well: that one changes nothing, and a swing going stops only at a real switch (:4995-4996). A cast going stops with it too (:5004-5008). With `keepOnTie`, two weapons that neither the style nor the spec tells apart (in Midgard a sword and a great sword, one object type and one line, and so with axes and hammers; in Albion and Hibernia a two-hander has a line of its own, so a mace and a two-hander at equal spec, and the higher spec takes the hand whatever the damage) stay as the owner left them: success, slot null, and nothing sent. Equipping a two-hander brings it out by itself, and nothing here knows its damage. A bow left in hand then goes at the first swing (attack, killNpc, killPlayer). Reasons: not_in_game, dead, refused (no melee weapon worn), not_found (none of that `weapon`), no_response. |
| `async useAbility(name: NamePattern): Promise<SkillUseResult>` | Use an ability (e.g. Sprint); success when the server answers without a refusal or an effect appears. |
| `isInCombat(): boolean` | In combat: attack mode on, recently hit, an NPC is fighting us (getAttackers) or targets our pet or a summon, or an enemy player hit us (getPlayerAttackers). |
| `resurrectSpell(): Spell \| null` | Our strongest resurrection spell, or null. The higher its level, the more it restores: 10 %, then 30, 50 and 100 % on a spec line. |
| `async resurrect(target: PlayerTarget, options: ResurrectOptions = {}): Promise<ResurrectResult>` | Resurrect a dead player of our realm: walk into range, cast, and wait for its answer. Success means it is alive again: a finished cast only asks, and a corpse no script controls never answers (the power is gone then). It comes back at our feet. It must be in view. Costs half our full power at equal level (resurrectCost), paid when the cast ends. Reasons: those of castSpell, plus spell_not_found, not_found, invalid_target, not_dead (alive, or released meanwhile), no_power, already_considering (someone else's rez waits for its answer), no_answer. |
| `getSpellInfo(spell: NamePattern \| Spell): SpellInfo \| null` | Static data for a known spell (type, target, range, cast time, power), from the DB dump; null when unknown. |
| `isDead(): boolean` | Our character is dead. |
| `freeBackpackSlots(): number` | Free backpack slots (of 40). |
| `async repairAll(smith: NpcTarget, options: { maxCost?: number } = {}): Promise<RepairResult>` | Have a smith repair everything at once: worn, backpack and vault, whatever its type, and 20 % over the single prices (Blacksmith.cs:14, :219-228). The only way to repair an instrument. Success with cost 0 means nothing needed it. Reasons as repairItem. |
| `findNpcSpawn(pattern: NamePattern, options: { regionId?: number; guild?: NamePattern } = {}): NpcSpawnMatch \| null` | Nearest static spawn (DB `mob` table) in our region matching a name, or null. |
| `async travelTo(destination: NamePattern \| (Point & { regionId?: number }), options: WalkOptions = {}): Promise<TravelResult>` | Walk (same region, through walkTo: navmesh route when built, else a straight line) to a named spawn from static data or to a point. |
| `async useZonePoint(target: number \| ZonePoint, options: UseZonePointOptions = {}): Promise<ZonePointResult>` | Use a zone point, by its id or as static data (getZonePointsFrom): walk to its source when farther than `tolerance`, send 0x90 and watch for the jump. Reasons: 'not_found' (no such id), 'wrong_region', 'wrong_realm', 'refused' (a server message said so), 'timeout' (no jump and no word: the server ignores a request it won't take, RegionChangeRequestHandler.cs:41-45), 'dead', and the walk's own ('stuck', 'died', ...). The server checks no distance (the handler reads only the id), so the walk is ours: a real client asks when it steps on the zone point, and a walk that stopped within 400 still asks. The realm is the zone point's in the DB, as for a PrivLevel-1 account (:33-37), and an id with a row per realm means our realm's row. The one other rule (:28, Trials of Atlantis regions go by the zone's realm) has no zone point in the dump. In shade a zone change costs health: PlayerState.isShade; releasePet first. |
| `async say(text: string): Promise<ChatResult>` | Say text (chunked) and observe our echo. Spaces calls SAY_SPACING_MS apart: the server drops a say < 500 ms after the last accepted one with "Slow down! Think before you say each word!" (commands/playercommands/say.cs:49-53); that answer retries once, then fails with 'rate_limited'. |
| `async send(to: string, text: string): Promise<ChatResult>` | Private message a player ('/send'); fails on "not online"-style answers. |
| `async grind(options: GrindOptions = {}): Promise<GrindResult>` | Hunt around an anchor: pick a killable target (attackers first), kill, loot, rest when low, walk back when drifted. Stops on death unless `respawn` is set, and with stopReason 'no_targets' after `noTargetTimeoutMs` (default 60 s) without any candidate. With `pet`, or in shade, a window pet fights: see GrindOptions, and GrindPetOptions for reason not_supported. Other errors keep their own reason. A kill that fails at once waits 1 s before the next pass, so no refusal can spin. With no pet plan and no melee weapon the first target ends the run: stopReason 'error', reason 'refused', and no order goes to a pet that is up: the message says to pass `pet: true`. A mob of a fight of ours that dies while a pass looks elsewhere, the pet's kill while we swing at another, counts, with its killLog entry and onKill, at xp 0: the XP goes to the run's total. `failures` counts a lost pet once, lost between two passes too: the owner's death and a shade's wait for its icon to go are none. Started on a corpse: reason 'dead', stopReason 'error', with nothing sent, as summonPet, castSpell and rest answer. With `respawn` it releases and goes on, and says so in the message; that death came before the run, and isn't in `deaths`. |

### NPC Dialog & UI

| Signature | Description |
|---|---|
| `async talkTo(npc: NpcTarget, options: InteractOptions = {}): Promise<DialogResult>` | Interact with an NPC and return its dialog text and [keywords]. |
| `async whisper(npc: NpcTarget, keyword: string, options: { timeout?: number } = {}): Promise<DialogResult>` | Whisper a [keyword] to an NPC (targets it first) and observe its reply: new dialog text, a message from the NPC, a window, or an item. Spaces whispers 1.6 s apart (NPCs ignore faster ones) and resends once after the server's "Slow down!". A teleporter's answer isn't a jump: it can still refuse for combat ("You can't use this item in combat!", UniPortal.cs:41, :82), after the answer and with success already read. Its InCombat counts the pet and lasts 2 s longer than player.inCombat (GamePlayer.cs:6045-6047), so wait 10 s after a fight and watch the position. In shade a jump to another region costs health: PlayerState.isShade. |
| `async navigateDialog(npc: NpcTarget, keywords: (string \| RegExp)[], options: { timeout?: number } = {}): Promise<DialogResult>` | Talk to an NPC, then whisper each keyword in turn. A RegExp picks the first matching [keyword] from the current dialog. |
| `async respondToDialog(accept: boolean, options: { timeout?: number } = {}): Promise<RespondDialogResult>` | Answer the open dialog box (group invite, quest offer, yes/no). Waits up to `timeout` for one to open. |

### Pets

| Signature | Description |
|---|---|
| `findSummonSpell(kind: PetSpellKind = 'main'): Spell \| null` | Best known spell of a kind, by its static type: pet names say nothing, a Druid's are random (NpcTemplateMgr.cs:164-174). The highest level wins; null if none. Kinds: 'main' a pet in the window, 'turret' an Animist's main pet, in the window too, on a ground target, 'fnf' a Theurgist's pet or a fire-and-forget turret, outside the window, 'bomber' one that flies at its target and is gone, outside it too, 'minion' a Bonedancer's, under its commander, 'charm' a mob taken over, in the window. Vents and heals share 'fnf' and 'bomber' (an Animist's Vent of Physical Protection buffs, its Meliorating Spirit heals the pet), so for those two what hurts an enemy comes first, then a snare, then the rest: to get a particular one, name it. |
| `async summonPet(spell?: NamePattern \| Spell, options: SummonPetOptions = {}): Promise<SummonPetResult>` | Cast a summon, or the best main one (an Animist: its best turret) with none given, and observe the pet: the window (state.pet) for one it lists, else the "under your control" line, whose name finds its NPC. A bomber's summon is silent, so it succeeds on the cast and reports no pet, with damage 0 and resisted false: its hit comes up to 4 s later (BomberBrain.cs:25-30). Commands reach window pets only, and releasePet({ target }) one with no window. Reasons: castSpell's, and spell_not_found, bad_args (a spell that is no summon: nothing is cast), pet_exists (a window pet is up, without `replace`; or the server still holds one that just died, after one more try a second on; a shade's line gets that try too), no_ground_target, out_of_range (a ground target beyond the spell, a charm's mob), refused (a spot off the walkable surface, and the server's other refusals), resisted (a charm), in_combat (a charm's mob, for now), timeout (cast, but no pet within `appearTimeout`), unknown_action (the client runs older code). A refusal reports the pet that stands. With `replace` the pet stays unless the cast can go: reasons cooldown, no_power below the most the spell can cost, in_combat for a spell with a cast time with melee on us or on the pet within what it covers by the half way (SummonPetOptions.replace; a swing of ours holds any such cast back for its weapon's interval, up to about 5 s on a staff, with "You must wait N seconds", so wait that out, and so does a cast a hit has broken, for 2.2 s; a hit alone holds none back, and interrupts it at its half way while its timer runs, so that needs the mob gone, SpellHandler.cs:356-372, :603-620), and for a turret no_ground_target, out_of_range (within 16 of the range too, or where a loaded mesh would put the spot beyond it: the server moves a spot to the nearest walkable ground and then measures in 3D), refused, all before anything is released, and for a charm what charmPet says. A charm goes at what was judged, not at what a release leaves selected. That no_power goes by the worst case, 120 % of the price for a focus caster: a focus item can lower the real cost, so it can refuse a cast that would have gone, at the price of some regen with the pet kept. releasePet by hand goes on regardless. With no pet up nothing is judged: there is nothing to lose, and the server answers. With a cast the server still runs (see castSpell) `replace` waits for its end first, the pet there for the wait, and judges what stands then. A spot with no z refused that way goes back to the one before it; with none before, the refused one is wiped, so a later summon with no spot reads no_ground_target. |
| `async charmPet(target: NpcTarget \| null \| undefined, options: CharmPetOptions = {}): Promise<SummonPetResult>` | Charm a mob with the best charm spell, as summonPet does (approaching it, and with `replace`), or `options.spell`. Charms can go by body type, which the client can't see (a Hunter's by insect or animal, CharmSpellHandler.cs:221-283), so on "This spell does not charm that type of monster!", which costs no power, it goes on to the next known one, and so with `replace` on a level limit, where nothing was cast yet. Reasons: summonPet's; no_target (a null target: never the current one), not_attackable (our own id), refused for a mob it can't take, before any walk when it has a realm (CharmSpellHandler.cs:151), in_combat for a mob that can be tried again out of combat, and resisted when it resists. A pulsing charm (Minstrel, Mentalist) keeps rolling after a resist, so state.pet can still open. A cast with one rolling stops it (SpellHandler.cs:501-513), so this casts once more then; releasePet stops it as well. Reason pet_exists also for our own pet as the target: that is already ours. With `replace` the pet stays through what we can see, all before the release: in_combat (the mob on our pet, or in any fight, mez or stun we saw in the last 10 s or that may still run: to the server all of that is combat, GameLiving.cs:227), refused (a named mob, one above our level or the spell's value, for a pulsing charm above 110 % of our modified spec), out_of_range with approach off, and a walk into range that fails or dies; only then is it released. A mez that ended early or was resisted still reads as held, so the refusal can come too soon; try again later. In range for a replace means within the range less 60: the server measures at the end of the cast, in 3D, and readings of 994 and 999 of 1000 lost the pet. Beyond that it walks in first, to the range less 70 units/s for the cast and 20 (about 700 of 1000), so a mob roaming away all the way still lands, and with approach off it is out_of_range, the pet kept. A mob that roams that far from within the range less 60, with no walk, can still lose it, and so can one faster than a roam. What we can't see can still lose the pet: a wrong type, a resist, and a fight or a hold we saw nothing of, out of view or past the last 200 events. For a Hunter that costs a 120 s recast. A mob on its way to us reads as in combat, though the server, which goes by swings, might take the charm (GameLiving.cs:227): its first swing would stop the cast anyway. With no spell named, a mob too strong for them all names the highest limit among them. |
| `async releasePet(options: ReleasePetOptions = {}): Promise<PetCommandResult>` | Release our window pet and observe the window close: any close counts, the server sends the same one for each cause. The pet is selected in the same order unless it is already, or our target cleared with its entry out of view: the server releases its target if that is a controlled NPC of ours, a deleted one too, silently (CharacterClassBase.cs:336-341, GameLiving.cs:3841-3853). A previous target comes back afterwards, unless it has gone, and otherwise our target is cleared. An entry that stays in view, a charm's ex-pet, gets up to 500 ms to read realm none, so a killable check finds it so. With `target`, one pet of ours with no window instead: observed by its NPC leaving. A pulsing charm (Minstrel, Mentalist) has its song stopped first, by casting it again: the mob turns on us either way. A Necromancer's release ends its shade: our health becomes min(current, max(10, the pet's %)) (PlayerState.isShade). Reasons: no_pet (no window and no target), no_response, unknown_action; crowd_controlled when we can't cast to stop that song: nothing is released then. With `target`: not_found, bad_args (it is no pet), refused (no pet we can tell is ours, with a window up: the server would release that one instead). |
| `async petAttack(target: LivingTarget \| null \| undefined, options: PetTargetOptions = {}): Promise<PetAttackResult>` | Order our pet onto a target (selected first) and observe the "You command ... to kill" line, or a refusal: reason out_of_range (over 2000 from us, wherever the pet is: the server refuses that order, and our target has moved all the same; or beyond a turret's spell: an order there would only stop the fight it has, so none goes out), immune (with retryAfterMs), not_attackable (also at once for a peace flag, an untargetable NPC, our own id or a pet of ours: the server says nothing to the first two), no_target (also for a null target), already_dead (the server says nothing to that), no_response, not_found, no_pet, unknown_action. It also lifts a passive pet to defensive (ControlledMobBrain.cs:213-214). Our own target stays moved unless `restoreTarget`. |
| `async petKill(target: LivingTarget \| null \| undefined, options: PetKillOptions = {}): Promise<KillResult>` | Have our pet kill a target while we stand off: order it, and wait for the death, ordering again when it has dropped the target for over 5 s, never while its order stands. We walk only into range of the order, never into melee, and not at all for a turret: to 1500, and for a mob 1000 or more above or below us until it reads within 1900, on a slope too. A first order the server refuses as out of range gets that walk, at least 100 nearer than it read, and one more try: our reading lags a mob on the move (GamePlayer.cs:12185), so a refusal can come at a reading short of 2000. An NPC at 0 % is not dead: the fight goes on to its death (GameLiving.cs:2621). A shade is on its servant's tether, 1500 for 10 s and 2000 at once (NecromancerPetBrain.cs:300-326), so it walks within 1000 of the target first, and steps after a servant over 1200 away or at the server's warning (`approach`). Reports XP, money and items by delta, like killNpc, and the duration up to the death. Reasons: petAttack's, attacked (another mob is on us, `attacker` on the result: the pet keeps fighting, or with no order out yet has none, and the message says which. The caller decides, or passes `ignoreAttackers`), arrived (only with `endWithin` or `endOnUsWithin`), pet_died (the pet is gone, however: state.lastPetLoss tells, and the message says when the tether took it), died, target_lost (it left view alive), timeout, out_of_range (also a turret's target that stays beyond its reach for about 2 s in the fight: the message says it left, and the turret's order stands), out_of_reach (the pet isn't getting there: at a standstill over 200 from the target, with no swing or spell by it or on it and no health lost by the target for over 8 s; the follow order that frees it has gone out, and a long mezz can read as this. Never for a turret). Our own target stays moved, and a swing of our own that was going stays on, but no longer lands on its old mob: melee reads the selection at each swing (AttackAction.cs:84). `npc` as in killNpc. A pet's kill is ours: it earns us XP (GameNPC.cs:2768-2769). |
| `async petFollow(options: PetCommandOptions = {}): Promise<PetCommandResult>` | Have our pet follow us. It only drops its order: a defensive pet hits back while the mob stays on it. setPetAggression('passive') is what calls a pet off (ControlledMobBrain.cs:189-204). Reasons of all these simple orders: no_pet, no_response, unknown_action, and those named per order; immobile for a walk order to a turret (this, petStay, petComeHere, petGoTo), with the server's line in `messages`: it doesn't move (TurretBrain.cs:100-108), but follow and stay still call off its order (GamePlayer.cs:12209, :12225). |
| `async petStay(options: PetCommandOptions = {}): Promise<PetCommandResult>` | Have our pet stay where it is. |
| `async petComeHere(options: PetCommandOptions = {}): Promise<PetCommandResult>` | Have our pet come to us. It stays there until a follow order (ControlledMobBrain.cs:258-276). |
| `async petGoTo(target: ObjectTarget \| null \| undefined, options: PetTargetOptions = {}): Promise<PetCommandResult>` | Send our pet to a target (selected first) within 1250 of us on the ground plane (GamePlayer.cs:12263-12265). Reasons: out_of_range, no_target (also for a null target), not_found, bad_args (our own id: that is petComeHere). It stays there until a follow order. Our own target stays moved unless `restoreTarget`. |
| `async setPetAggression(mode: PetAggression, options: PetCommandOptions = {}): Promise<PetCommandResult>` | Set our pet's stance. Passive also has it break off its fight; a new pet starts defensive, so this does not outlive a release (ControlledMobBrain.cs:56-57). A group run's end lifts the passive it set. A run another controller took a member from can't: that connection is cut, so the pet stays passive, its log says `<member>'s pet left passive`, and the next run lifts it, or this. |
| `getPetAttackers(): NearbyNpc[]` | NPCs currently targeting our window pet or a summon of ours (a pet with no window: sdk.getSummons), nearest first. |

### Items & Equipment

| Signature | Description |
|---|---|
| `async lootNearby(options: LootOptions = {}): Promise<LootResult>` | Pick up loot on the ground within `radius` and report what changed in the backpack and purse (autoloot usually already took it during the kill). |
| `async equipItem(target: InventoryItem \| NamePattern \| number, options: { slot?: number } = {}): Promise<ItemResult>` | Equip a backpack item; the server picks its slot, or takes `options.slot` when given (a worn item there swaps into the backpack). Observed in state.equipment: with a slot, that slot must hold this item, so an equal-named item already worn elsewhere doesn't count. What it replaces lands in the backpack slot this one left, so only this very item still there means it didn't move. A swap with a piece that reads the same changes no reading, so a magical piece counts on the server's "The magic of X flows through you". A plain one has nothing that tells them apart and no message: `timeout`. A weapon put in the ranged slot (13) also takes the hand ("You wield it in both hands"), and melee is refused until a melee slot is used (sendUseItem(10 or 12, 0); killNpc does that itself). |
| `async unequipItem(target: number \| NamePattern): Promise<ItemResult>` | Move an equipped item (by slot or name) back into the backpack. |
| `async dropItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Drop a backpack item on the ground. |
| `async destroyItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Destroy a backpack item. |
| `async useItem(target: InventoryItem \| NamePattern \| number, options: { useType?: number } = {}): Promise<ItemResult>` | Use (right-click) a backpack or equipped item: potions, charged items. A number is a backpack (40-79) or equipment (10-37) slot. Success needs evidence about this item: a message naming it ("You attempt to use <item>.", GamePlayer.cs:6564), its stack count changing, or a new effect, and no refusal in the following ~400 ms. That attempt line alone means only that the attempt is known: the server sends it before it knows whether the item does anything. Reason in_combat: a recall stone that says we were in combat recently (GatewayPersonalBind.cs:105), else refused, also for "You are already casting a spell." (GamePlayer.cs:7169-7173). A stone used while walking starts, as the client's use prefix says speed 0 (client.ts prefix, UseSlotHandler.cs:21, GatewayPersonalBind.cs:32), and its cast stops the walk (session.ts:501): a walkTo under way reads stuck, so stop first. Success only says its 10 s cast began: an interrupt later comes after this returns, so watch for the jump. On the ranged slot (13) the draw's and the shot's lines count too, an evaded or blocked shot's as well, as they name no item: one use draws ("You prepare your shot", then "You are ready to fire!") and the next fires, or, used before it is ready, sets it to fire by itself; with another weapon in hand a use first takes the bow in hand (GamePlayer.cs:6649-6698). |
| `async delveMerchantItem(merchant: NpcTarget, item: NamePattern \| { page: number; slot: number }, options: { timeout?: number } = {}): Promise<MerchantDelveResult>` | Read an item's real bonuses: a backpack or equipped item, by item, name or slot. Reason 'empty_slot' for an empty slot asked by number, 'not_found' for a name nothing matches, 'no_response' when no window named after the item came within `timeout`: only the caption says a 0xC4 window is ours (NPC text and commands send them too, DetailDisplayHandler.cs:114), and the snapshot holds only the latest one, so another window landing right after it loses the answer. |
| `async delveItem(target: InventoryItem \| NamePattern \| number, options: { timeout?: number } = {}): Promise<DelveResult>` | _No description provided._ |
| `findInventoryItem(pattern: NamePattern): InventoryItem \| null` | Backpack item by name (shortest match wins). |
| `async buyItem(merchant: NpcTarget, item: NamePattern \| { page: number; slot: number }, count: number = 1): Promise<BuyResult>` | Buy `count` of an item (name or page/slot) and observe the backpack and purse. |
| `async sellItem(merchant: NpcTarget, item: InventoryItem \| NamePattern \| number): Promise<SellResult>` | Sell one backpack item (whole stack) to a merchant and observe the purse. |
| `async sellItems(merchant: NpcTarget, filter: NamePattern \| ((item: InventoryItem) => boolean)): Promise<SellItemsResult>` | Sell every backpack item matching a predicate or name pattern. |
| `async repairItem(smith: NpcTarget, target: InventoryItem \| NamePattern \| number, options: { maxCost?: number } = {}): Promise<RepairResult>` | Have a smith repair one item, worn or in the backpack: walk within 128 (3D), hand it over, read the price off the yes/no box, say yes, and observe the smith's answer. Costs the Durability it restores, and when too little is left it charges in full and restores only that much. Reasons: `not_found`, `out_of_range`, `no_need` (already whole), `not_repairable`, `too_expensive` (over `options.maxCost`, declined), `insufficient_funds`, `no_response` (not a smith, or no answer). A smith takes no jewellery, instruments or stacks: an instrument only through repairAll. |
| `async withdrawItem(keeper: NpcTarget, target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Take an item out of the vault into the backpack, at a vault keeper. A number is a vault slot (110-149). A stack behaves as in depositItem. Reasons: `not_found`, `inventory_full`, those of openVault, `timeout`. |

### Status & Recovery

| Signature | Description |
|---|---|
| `async rest(options: RestOptions = {}): Promise<RestResult>` | Sit until health (and optionally mana, endurance and our pet's health) reach the thresholds, then stand. Reason 'in_combat' while a pet of ours fights or a mob is on one, also on its way to a mob, a summon as well, also with nothing to rest for, and also when it starts while we sit: the server counts its fight as ours, so regen ticks every 10 s (GamePlayer.cs:2314-2322, :6045-6047), and a sit wouldn't stop that fight. A mob on us counts only if there is something to rest for: 'in_combat' at the start, 'attacked' while sitting. So does a summon that has only just come, which may well be in its fight with nothing to show for it yet: 'in_combat' whenever it holds up a rest, with the message saying so (BotWorldState.freshSummons). |
| `async releaseAndRespawn(options: { timeout?: number } = {}): Promise<RespawnResult>` | Release after death and observe being alive at the bind point. In the server's first 10 s the request arms its automatic release, and a second one would disarm it (GamePlayer.cs:1438-1449), so that one is waited out, and asked again only 2 s past its time. One that finds it armed already, by an earlier call, has disarmed it, so another goes at once and arms it again with the right time. Any other refusal is retried until the server allows it. |
| `async depositItem(keeper: NpcTarget, target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Put a backpack item in the vault, at a vault keeper. Vaulted items don't wear, count toward no weight and can't be sold by `sellItems`, but `repairAll` charges for them if they're worn. A stack goes onto a partial stack first, and what doesn't fit stays in the backpack: check the count if that matters. Reasons: `not_found`, `vault_full`, those of openVault, `timeout`. |

### Condition Waiting

| Signature | Description |
|---|---|
| `async waitForHealth(percent: number, timeout: number = 60_000): Promise<ActionResult>` | Wait (without sitting) until health reaches `percent`. |

### Merchants

| Signature | Description |
|---|---|
| `async openMerchant(merchant: NpcTarget): Promise<MerchantResult>` | Walk to a merchant and open its window; observed via state.merchant. |
| `async closeMerchant(): Promise<ActionResult>` | Close the merchant window (client-side state). |

### Vault

| Signature | Description |
|---|---|
| `async openVault(keeper: NpcTarget): Promise<VaultResult>` | Walk to a vault keeper and open the character's vault. Until then, in each client session, `sdk.getVault()` is empty whatever the vault holds. Reason `not_a_vault_keeper` for an NPC that answers some other way. The vault is the character's own: 40 slots, not shared with other bots. |

### Training

| Signature | Description |
|---|---|
| `async trainSpec(trainer: NpcTarget \| null, specName: NamePattern, levels: number = 1): Promise<TrainResult>` | Train a specialization: open the trainer window (falling back to '/train') and observe the spec level rise. With a trainer of our class, it walks into reach and targets it first. With `null` it stays where it stands: the server trains anywhere while allow_train_anywhere is on, as by default and here (train.cs:143), and with it off the answer is `needs_trainer`. `specName` is any name of the line (sdk.findSpecialization); a name no line answers to gives 'spec_not_found'. |
| `async trainBuild(trainer: NpcTarget \| null, build?: Build): Promise<TrainBuildResult>` | Spend the points on a build, as far as they reach: the rule in data/builds/rule.ts names each line and trainSpec raises it, at a trainer of the class or, with `null`, where the character stands (trainSpec). Without `build` it is the bot's own `bots/<bot>/build.ts` (loadBuild in sdk/build.ts), and a broken file throws. Success means it stopped for a good reason: `done` (nothing to raise at this level) or `waiting` (the next line costs more than there is, and the points stay banked for it). `done` sends nothing. Before `waiting` with nothing raised it talks once to a trainer in reach, because a promotion sends no points and player.specPoints can still be the base class's number. A trainer out of reach or not found gets nothing, and the number stands. A base class trains the lines it has of its advanced class's build. After a GM's `/player class` the server's skill list keeps each line's old level for the session (its cache swaps an entry only when Skill's ID-comparing `!=` says so, GamePlayerUtils.cs:650), while the trainer window is right: so a window that came during this call gives the levels, and trainSpec counts a raise by it. It asks for one before its first raise, and before stopping when the levels and points cost more than the class has earned (specsAddUp); otherwise `done` and `waiting` send nothing. A relog clears the old levels. Reasons: `no_build`, `invalid_build` (buildProblems of a build passed in), `wrong_class`, `not_in_game`, `too_many_steps`, and those of trainSpec. |
| `async respec(trainer: NpcTarget, line?: NamePattern): Promise<RespecResult>` | Take the points back out of every line, or with `line` (any of its names) out of that one, at a trainer of the class: sends /respec, says yes to the server's box and watches the points come back. It is free, at any level and any number of times, because the stone check can never hold (respec.cs:96, 153 test TimeSpan.Hours > 24). A line falls to 1, an autotrain line to its free levels. A respec ends the character's own buffs and kills its pet (respec.cs:247). Reasons: `not_found` (trainer), `spec_not_found`, `no_need` (nothing trained above that floor; nothing is sent), `refused` (the server's words in `message`), `timeout`, `not_in_game`, and those of the walk there. |

### Group

| Signature | Description |
|---|---|
| `async groupSay(text: string): Promise<ChatResult>` | Group chat; fails with 'not_grouped' when the server says we are not in a group. |
| `async invite(player: string): Promise<ActionResult>` | Invite a player to our group ('/invite name'). |
| `async acceptGroupInvite(options: { timeout?: number } = {}): Promise<GroupResult>` | Wait for a group invite dialog, accept it and observe group membership. |

### Trading

| Signature | Description |
|---|---|
| `async trade(partner: PlayerTarget, options: TradeOptions = {}): Promise<TradeResult>` | Trade with a player. With `give` or `money` this walks up and offers them first (the partner must be in view; a string must be its exact name, and a pattern is refused); without, it only waits for that player's window, and closes one that holds anything of ours. Then it accepts every new offer until the server commits, and reads the outcome from the backpack. Both sides call this, in any order, and must stay within 128 units. An add that opens a window waits for this side's slot on the clock, up to 750 ms. Between hunts only: a second controller aborts a group run. Afterwards, or after an abort, no window of ours stays open, and when a failure returns the close has been seen. Reasons: those of offerTrade and acceptTrade. |
| `async offerTrade(partner: PlayerTarget, options: TradeOfferOptions): Promise<TradeOfferResult>` | Put `give` and `money` on our side of a window with a player and leave it open for acceptTrade. The offer describes our whole side: a window that holds anything else of ours is closed first. Evidence is the server's 0xEA, because items stay in the backpack until the commit. On any failure the window is closed. Reasons: not_in_game, dead, bad_args (also a pattern as the partner), not_found, too_many_items, insufficient_funds, timeout, out_of_reach (or the walk's reason), out_of_range, busy, wrong_realm, refused, empty_slot, no_response, cancelled, wrong_partner, trade_accepted. |
| `async acceptTrade(options: AcceptTradeOptions = {}): Promise<TradeResult>` | Finish the window of this bot's offerTrade, or else whatever window opens: accept each new offer until the server commits. After an offerTrade it is that window or nothing: one closed since is cancelled at once, and our side must still be what we offered. Without one, in a new script say, it takes a window as it stands, our side included. Afterwards, or after an abort, no window of ours stays open, and when a failure returns the close has been seen. Reasons: timeout (no window), offer_rejected (`accept` never said yes), offer_changed (it said no after a yes, or our side changed), partner_no_accept, cancelled (a partner's cancel and a range close alike: the server gives no cause), inventory_full, partner_inventory_full, insufficient_funds, partner_insufficient_funds, item_missing, not_found (`from` names nobody in view), not_in_game, unknown_action (the client runs older code). |
| `async cancelTrade(): Promise<ActionResult>` | Close the trade window and observe it gone. Also cures a window the server holds but never told us about, so no window at all is a success. Reasons: timeout, already_completed. |

---

## BotSDK (low-level)

### Connection & Subscriptions

| Signature | Description |
|---|---|
| `async connect(): Promise<void>` | Connect to the gateway (and wait up to readyTimeout for in-game state). Idempotent. |
| `async disconnect(): Promise<void>` | Disconnect from the gateway; no auto-reconnect. Does not stop the game client. |
| `isConnected(): boolean` | WebSocket to the gateway is open. |
| `isAuthenticated(): boolean` | The gateway accepted us (sdk_connected). If state is still missing, no client is attached. |
| `getConnectionState(): ConnectionState` | Connection state machine: disconnected, connecting, connected, reconnecting. |
| `getReconnectAttempt(): number` | Current reconnect attempt (0 when connected). |
| `onConnectionStateChange(listener: (state: ConnectionState, attempt?: number) => void): () => void` | Subscribe to connection state changes; returns an unsubscribe function. |
| `getConnectionMode(): ConnectionMode` | 'control' or 'observe'. |
| `async waitForConnection(timeout: number = 60000): Promise<void>` | Wait for the WebSocket to (re)connect. |
| `async checkBotStatus(): Promise<BotStatus>` | Bot status from the gateway's HTTP /status/:username. 'unknown' when the gateway can't be reached. |
| `async isBotConnected(): Promise<boolean>` | A client is registered with the gateway for this bot (status not dead/unknown). |
| `launchClient(): ChildProcess` | Spawn `bun client/runner.ts <botUsername>` detached (log: bots/<botUsername>/client.log). |
| `async waitForBotConnection(timeout: number = 90_000): Promise<void>` | Poll /status until a client publishes fresh state for this bot. |
| `getStateReceivedAt(): number` | Gateway time (ms epoch) the current state arrived from the client. |
| `getStateAge(): number` | Milliseconds since the current state arrived at the gateway (0 before any state). |
| `onStateUpdate(listener: (state: BotWorldState) => void): () => void` | Subscribe to state snapshots; returns an unsubscribe function. |

### Other

| Signature | Description |
|---|---|
| `wasPreempted(): boolean` | True when the gateway dropped this connection because another control connection for the same bot took over (newest control connection wins). The game client is still running; only this SDK lost control. Cleared by the next connect(). |
| `setMoveGuard(guard: MoveGuard \| null): () => void` | Cut every move from here on (sendMoveTo, and so walkTo, walkToObject, castSpell's approach and killNpc's chase) by `guard`, or none with null. A move cut to where we stand is refused with reason 'water'. Returns a function that removes this guard (and no later one). |

### State Access

| Signature | Description |
|---|---|
| `getPreemptedReason(): string \| null` | The gateway's message for the takeover ("Disconnected: another controller connected"), or null. |
| `getState(): BotWorldState \| null` | Last world state snapshot, or null before the first one. |
| `getPlayer(): PlayerState \| null` | Our character, or null when not in game. |
| `getPosition(): Position \| null` | Our region and global coordinates. |
| `getMovement(): MovementState \| null` | Mover state: moving, destination, waypoints, last stop reason. |
| `getInventory(): InventoryItem[]` | Backpack items (slots 40-79), occupied slots only. Pass `item.slot` to send* calls. |
| `getInventoryItem(slot: number): InventoryItem \| null` | Backpack item in a slot, or null. |
| `findInventoryItem(pattern: NamePattern): InventoryItem \| null` | Backpack item by name (case-insensitive substring or RegExp; shortest name wins). |
| `countInventoryItems(pattern: NamePattern): number` | Total quantity across every backpack slot whose name matches. |
| `getFreeInventorySlots(): number` | Free backpack slots (40 total). |
| `getEquipment(): InventoryItem[]` | Equipped items (slots 10-37). |
| `getEquipmentItem(slot: number): InventoryItem \| null` | Equipped item in a slot (see EquipmentSlot), or null. |
| `findEquipmentItem(pattern: NamePattern): InventoryItem \| null` | Equipped item by name (shortest name wins). |
| `getVault(): InventoryItem[]` | Vault items (populated after the vault window has been opened). |
| `getNearbyNpcs(): NearbyNpc[]` | Nearby NPCs and monsters. |
| `getNearbyNpc(objectId: number): NearbyNpc \| null` | Nearby NPC by object id. |
| `findNearbyNpcs(pattern: NamePattern = /.*/, options: FindNpcOptions = {}): NearbyNpc[]` | All NPCs matching a name and filters, nearest first. |
| `findNearbyNpc(pattern: NamePattern, options: FindNpcOptions = {}): NearbyNpc \| null` | Best NPC by name (shortest name, then nearest) after filters: maxDistance, minLevel, maxLevel, attackable. |
| `getNearbyPlayers(): NearbyPlayer[]` | Nearby players. |
| `getNearbyPlayer(objectId: number): NearbyPlayer \| null` | Nearby player by object id (enemy players are named by race, so their names are not unique). |
| `findNearbyPlayer(pattern: NamePattern, options: FindOptions = {}): NearbyPlayer \| null` | Nearby player by name (shortest name, then nearest). |
| `getNearbyObjects(): NearbyObject[]` | Nearby static objects, doors and loot. |
| `findNearbyObject(pattern: NamePattern, options: FindOptions & { loot?: boolean } = {}): NearbyObject \| null` | Nearby object by name (shortest name, then nearest). |
| `getNearbyLoot(): NearbyObject[]` | Loot on the ground, nearest first. |
| `getObject(objectId: number): NearbyNpc \| NearbyPlayer \| NearbyObject \| null` | Any nearby NPC, player or object by object id. |
| `getTarget(): NearbyNpc \| NearbyPlayer \| NearbyObject \| null` | Our current target (player.targetObjectId) when it is nearby. |
| `getSkills(): SkillsState` | Specializations, abilities, styles and spells. |
| `findSpecialization(pattern: NamePattern): Specialization \| null` | Specialization by any name of its line: as listed ('Shield'), its DB key ('Shields', from classes.json, Style.specName or ItemBonus.spec) or an item's bonus name ('Cave Magic'). Failing those, by part of the listed name (shortest wins). Look lines up here rather than with === on the list, which only knows the listed name. |
| `findSpell(pattern: NamePattern): Spell \| null` | Spell by name; pass its lineIndex/spellIndex to sendCastSpell, or for a hybrid's, those being -1, its skillIndex to sendUseSkill. Highest level wins among equal names. |
| `findStyle(pattern: NamePattern): Style \| null` | Combat style by name; pass its skillIndex to sendUseSkill. |
| `findAbility(pattern: NamePattern): Ability \| null` | Ability by name; pass its skillIndex to sendUseSkill. |
| `getEffects(): Effect[]` | Active buffs/debuffs. |
| `findEffect(pattern: NamePattern): Effect \| null` | Active effect by name, or null. A string matches inside a name: Lesser Bark Skin passes for Bark Skin. |
| `getMerchant(): MerchantState \| null` | Open merchant window, or null when none is open. |
| `getTrainer(): TrainerState \| null` | Open trainer window, or null when none is open. |
| `getTrade(): TradeWindow \| null` | Open player trade window, or null when none is open. Its partnerItems carry the partner's slots, never ours. |
| `getPetState(): PetState \| null` | Our pet's window (0x88), or null without a pet. It holds while the pet is out of view. A pet the window doesn't list (a Theurgist's, a minion) never shows here. |
| `getPet(): NearbyNpc \| null` | Our window pet's NPC entry, or null: no pet, or it is out of view right now. |
| `getSummons(): NearbyNpc[]` | Our own pets with no window, the entries in view, nearest first: a Theurgist's, a fire-and-forget turret, a bomber, a Bonedancer's minion. Known from the 0x1B of their summon (BotWorldState.summons), and never in getPetState. Orders don't reach them. |
| `getDialog(): DialogBox \| null` | Open 0x81 dialog box (group invite, quest offer, yes/no), or null. Answer with sendRespondDialog. |
| `getResurrectionOffer(): ResurrectionOffer \| null` | The resurrection offer waiting for our answer, or null. Answer with bot.acceptResurrection or bot.respondToDialog. |
| `getNpcDialog(): NpcDialog \| null` | Last NPC dialogue with its [keywords]; answer with sendWhisper(npcObjectId, keyword). |
| `getTextWindow(): TextWindow \| null` | Last custom text window (0xC4), or null. |
| `getGroup(): GroupMember[]` | Group members (empty when not grouped). |
| `getPetAttackSentAt(): number \| null` | When the last attack order went to our pet (Date.now()), null before any. Its refusal comes on the one line stream with everything else, and castSpell has to tell it from its own. |

### Chat

| Signature | Description |
|---|---|
| `getGameMessages(): GameMessage[]` | Messages in the latest snapshot (last 100), oldest first. |
| `getChat(opts: ChatQuery = {}): GameMessage[]` | Recent chat from the 500-deep history (player chat by default), oldest first. |
| `getNewChat(opts: Omit<ChatQuery, 'limit'> = {}): GameMessage[]` | Chat that arrived since the last getNewChat call (cursor-based). |
| `getChatFrom(name: string, opts: { limit?: number } = {}): GameMessage[]` | Recent chat from one sender (case-insensitive substring). |
| `async waitForChat(opts: { from?: string; matching?: RegExp \| string; types?: readonly ChatType[] \| 'all'; includeSelf?: boolean; timeout?: number } = {}): Promise<GameMessage \| null>` | Wait for the next message matching the filters (arriving after this call). Returns null on timeout (default 30 s). |
| `async say(text: string, opts: ChatSendOptions = {}): Promise<ActionResult[]>` | Say text of any length: split into chunks and paced. One ActionResult per chunk sent. |
| `async send(to: string, text: string, opts: ChatSendOptions = {}): Promise<ActionResult[]>` | Private message ('/send') of any length to a player by name, chunked like say(). |

### Geometry

| Signature | Description |
|---|---|
| `distanceTo(target: { x: number; y: number; z?: number }): number` | Distance from our player to an object or position (3D when both have z). Infinity when not in game. |
| `headingTo(target: { x: number; y: number }): number` | DAoC heading (0..4095) from our player to an object or position; pass it to sendFace. |

### Raw Actions

| Signature | Description |
|---|---|
| `async sendAction(action: BotAction): Promise<ActionResult>` | Dispatch one BotAction and resolve with the client's ActionResult. Timeouts, disconnects mid-flight and gateway errors come back as a failed result (phase 'dispatch'); only "not connected" throws. |
| `async sendMoveTo(x: number, y: number, z?: number, opts: { tolerance?: number; waypoints?: Vec3[]; speedFactor?: number } = {}): Promise<ActionResult>` | Walk/run to x,y (z optional) via the client's mover; optional waypoints and speed factor (≤1). |
| `async sendStop(): Promise<ActionResult>` | Stop moving (final position update with speed 0). |
| `async sendFace(heading: number): Promise<ActionResult>` | Turn to a heading (0..4095). |
| `async sendFaceObject(objectId: number): Promise<ActionResult>` | Turn to face an object. |
| `async sendJump(): Promise<ActionResult>` | Jump. |
| `async sendSetTarget(objectId: number \| null): Promise<ActionResult>` | Select a target by object id (null clears it). |
| `async sendInteract(objectId: number): Promise<ActionResult>` | Right-click interact with an NPC or object (opens merchant/trainer/dialog). |
| `async sendWhisper(objectId: number, text: string): Promise<ActionResult>` | Whisper text to an NPC, e.g. a [keyword] from its dialog. |
| `async sendPickup(objectId: number): Promise<ActionResult>` | Pick up loot on the ground. |
| `async sendAttack(on: boolean = true): Promise<ActionResult>` | Toggle melee auto-attack on the current target. |
| `async sendUseSkill(skillIndex: number): Promise<ActionResult>` | Use a style or ability by skillIndex (see findStyle/findAbility). |
| `async sendCastSpell(lineIndex: number, spellIndex: number): Promise<ActionResult>` | Cast a spell by lineIndex/spellIndex (see findSpell) on the current target. |
| `async sendSetGroundTarget(x: number, y: number, z?: number): Promise<ActionResult>` | Set the ground target. Without `z` the client snaps it to its terrain, the ground the mover walks on, under a river the mesh's plane 16 below the surface (else our own height); a z passed goes out as given. In a zone where the server has a navmesh loaded it drops a target more than 16 units off the mesh (ground_target_snap_max_distance), and says only "Your ground target is not visible!", and it snaps one it takes to the nearest walkable ground, so its spot can differ from state.groundTarget: usually by a few units, by more beside a gap in the mesh (PlayerGroundTargetHandler.cs:21-33, ground.ts groundTargetSnap). An NPC's coordinates are always a valid spot. Two sets need a pause of about 300 ms: that line names no spot, so the answer to a bad one wipes a good one sent within the round trip from state.groundTarget, and the next cast reads it as not in view. |
| `async sendPetCommand(command: PetCommand, targetObjectId?: number): Promise<ActionResult>` | Order our pet; with `targetObjectId`, target that first (our target stays moved). Success means dispatched: bot.* observes the answer. |
| `async sendUseItem(slot: number, useType?: number): Promise<ActionResult>` | Use an item in a slot (potions, charged items). |
| `async sendMoveItem(fromSlot: number, toSlot: number, count?: number): Promise<ActionResult>` | Move an item between slots (equip, unequip, stack split, vault). |
| `async sendDropItem(slot: number): Promise<ActionResult>` | Drop an item on the ground. |
| `async sendDelve(slot: number): Promise<ActionResult>` | Ask the server to delve the item in a slot; the answer is the next text window (getTextWindow), and an empty slot gets none. bot.delveItem waits for it and parses the bonuses. |
| `async sendDelveMerchantItem(page: number, slot: number): Promise<ActionResult>` | Ask the server to delve an item in the open merchant window; the answer is the next text window. bot.delveMerchantItem opens the window, waits for the answer and parses it. |
| `async sendDestroyItem(slot: number): Promise<ActionResult>` | Destroy an item. |
| `async sendBuy(page: number, slot: number, count: number = 1): Promise<ActionResult>` | Buy from the open merchant by page/slot (see getMerchant). |
| `async sendSell(slot: number): Promise<ActionResult>` | Sell a backpack item to the open merchant. |
| `async sendOpenTrainer(): Promise<ActionResult>` | Open the trainer window, anywhere while allow_train_anywhere is on (train.cs:143), else with a trainer targeted. |
| `async sendTrainSpec(specIndex: number, levels?: number): Promise<ActionResult>` | Train a specialization (index from getTrainer().specs). |
| `async sendTradeOfferItem(partnerObjectId: number, slot: number): Promise<ActionResult>` | Add a backpack item to the trade window with a player, opening it if needed. Evidence is the slot in getState().trade.mySlots. Never from both sides at once: two adds that open a window in one server tick can hang the server (learnings/trading.md). bot.offerTrade keeps them apart. |
| `async sendTradeOfferMoney(partnerObjectId: number, copper: number): Promise<ActionResult>` | Add copper to the trade window with a player, on top of what is there. It goes out as one drop per coin, and the server holds only that drop against the purse, never the total (PlayerMoveItemRequestHandler.cs:258): an amount above the purse can be refused in part, or shown in full and fail at the commit. bot.offerTrade checks the purse first. |
| `async sendTradeAccept(revision?: number, windowId?: number): Promise<ActionResult>` | Accept the open trade; with a revision, only while the window still shows it, and with a window id, only while it is that window, because revisions start over per window (reason trade_changed otherwise). The second accept commits. |
| `async sendTradeCancel(): Promise<ActionResult>` | Close the trade window, also one the server holds but never told us about. A no-op on the server without one. |
| `async sendRespondDialog(accept: boolean): Promise<ActionResult>` | Answer the open dialog box (yes/accept or no/decline). |
| `async sendCloseMerchant(): Promise<ActionResult>` | Close the merchant window. |
| `async sendSay(text: string): Promise<ActionResult>` | Say one message (no chunking; see say()). |
| `async sendSend(to: string, text: string): Promise<ActionResult>` | Private message ('/send') one message to a player (no chunking; see send()). |
| `async sendGroupSay(text: string): Promise<ActionResult>` | Group chat. |
| `async sendCommand(command: string): Promise<ActionResult>` | Slash command sent verbatim, e.g. '&stick', '/bind' ('/' becomes '&'). |
| `async sendSit(sit: boolean = true): Promise<ActionResult>` | Sit (true) or stand (false). |
| `async sendRegionChangeRequest(zonePointId: number): Promise<ActionResult>` | Ask the server to use a zone point, by its id (0x90). Success means dispatched: the server silently ignores a wrong id or another realm's zone point. bot.useZonePoint walks to the zone point and observes the jump. |
| `async sendRemoveConcentrationEffect(index: number): Promise<ActionResult>` | Drop one of our concentration buffs (frees its concentration), by its `index` in `state.concentrationEffects`. Observe the effect leaving that list. |
| `async sendRelease(): Promise<ActionResult>` | Release after death (back to bind point). |
| `async sendQuit(): Promise<ActionResult>` | Quit to the character screen ('&quit'; the server timer is 20 s+). |
| `async sendNone(): Promise<ActionResult>` | No-op round trip: succeeds once the client's action queue reaches it. |
| `async sendWait(ms: number = 600): Promise<ActionResult>` | Occupy the client's action queue for `ms` milliseconds. |

### Condition Waiting

| Signature | Description |
|---|---|
| `async waitForReady(timeout: number = 15000): Promise<BotWorldState>` | Wait until in game with a player present. Throws on timeout. |
| `async waitForCondition(predicate: (state: BotWorldState) => boolean, timeout: number = 30000): Promise<BotWorldState>` | Wait until the predicate passes on a state (the current one counts) and return it. THROWS `Error('waitForCondition timed out')` on timeout. |
| `async waitForStateChange(timeout: number = 30000): Promise<BotWorldState>` | Wait for the next state snapshot. |
| `async waitForTicks(ticks: number = 1): Promise<BotWorldState>` | Wait for `ticks` more published snapshots (state.tick is the client's publish counter). |

---

## Types

### Position

```typescript
interface Position {
  regionId: number;
  x: number;
  y: number;
  z: number;
}
```

### Vec3

```typescript
interface Vec3 {
  x: number;
  y: number;
  z: number;
}
```

### Stats

```typescript
interface Stats {
  strength: number;
  dexterity: number;
  constitution: number;
  quickness: number;
  intelligence: number;
  piety: number;
  empathy: number;
  charisma: number;
}
```

### Money

```typescript
interface Money {
  copper: number;
  silver: number;
  gold: number;
  mithril: number;
  platinum: number;
  /** Everything expressed in copper (1s = 100c, 1g = 100s, 1p = 1000g, 1m = 1000p). */
  totalCopper: number;
}
```

### PlayerState

```typescript
interface PlayerState {
  name: string;
  lastName: string;
  guildName: string;
  accountName: string;
  objectId: number;
  sessionId: number;
  level: number;
  realm: Realm;
  className: string;
  raceName: string;
  regionId: number;
  zoneId: number;
  zoneName: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Current speed reported by our own mover, units/s. */
  speed: number;
  /** Absolute max run speed, units/s (191 * maxSpeedPercent / 100). */
  maxSpeed: number;
  /** Absolute max swim speed in deep water, units/s (85 at 100 %, up to 170 with water speed bonuses). */
  maxSwimSpeed: number;
  maxSpeedPercent: number;
  health: number;
  maxHealth: number;
  healthPercent: number;
  mana: number;
  maxMana: number;
  manaPercent: number;
  endurance: number;
  maxEndurance: number;
  endurancePercent: number;
  concentration: number;
  maxConcentration: number;
  experience: number;
  experienceForNextLevel: number;
  /** Progress toward next level, 0..1000. */
  levelPermill: number;
  realmPoints: number;
  bountyPoints: number;
  specPoints: number;
  realmSpecPoints: number;
  money: Money;
  stats: Stats | null;
  /** The same without item bonuses: base, buffs and realm abilities, what a percent power cost goes by (SpellHandler.cs:1190-1199). Absent from an older client. */
  statsWithoutItems?: Stats | null;
  /** Constitution lost to PvE deaths (from level 6); a town healer (GameHealer) restores it for money. */
  constitutionLost: number;
  encumbrance: { current: number; max: number } | null;
  isDead: boolean;
  isSitting: boolean;
  /** Melee auto-attack toggled on (server 0x74 AttackMode). */
  attacking: boolean;
  /** In a fight as far as we can see: attack mode on, a swing or harmful spell by or on us, our pet or a summon within the last 8 s, or an NPC on one of them. Not the server's own flag: that lasts 10 s (GameLiving.cs:31, :227), so what the server gates on it ("You have been in combat recently") can refuse for up to 2 s after this reads false. */
  inCombat: boolean;
  targetObjectId: number | null;
  /** Server tick-independent counter incremented on each death. */
  deathCount: number;
  lastDeathAt: number | null;
  /** A Necromancer in shade (the negative effect with icon 403, ShadeECSEffect.cs:8, :10; Stealth has that icon as a positive one): the servant fights, we can't melee (ClassDisciple.cs:91), and its death is ours. Leaving shade cuts our health to the pet's percent as it last went (:72-82, :149): a release or the tether leaves min(current, max(10, its %)), its death 10 %. A zone change or a quit in shade uses that percent stale (:155-160), 10 % with no release this session: releasePet first. False out of shade, absent from an older client. */
  isShade?: boolean;
}
```

### NearbyNpc

```typescript
interface NearbyNpc extends WorldObjectBase {
  kind: 'npc';
  guildName: string;
  level: number;
  model: number;
  realm: Realm;
  healthPercent: number;
  speed: number;
  /** Object the NPC is attacking/targeting, if any. Its 0xA1 names one only at a standstill within reach (PacketLib168.cs:820-828), so its swings and spells on us, our pet or a summon name it too. That holds for 5 s while it is on the move, and 6 s between its casts, from a cast's first animation when it was on one of those then. When a pet of ours is lost, not to a region change or our death, a mob on it reads as on us at once: the server re-aims it. So does the window pet's own target if it was moving or hurt, on its first run at the pet and never named. That holds for its run: its distance at 150 units/s, slower below 33 % health, plus 2 s, at least 5 s, and on while it reads 0xFFFF and comes nearer, 30 s at most, until a real id or a 0 says otherwise. The server goes by threat, so where it has another to turn to it reads as on nobody until its next swing or 0xA1: with another pet of ours within 600 of it, a minion's mob while its commander lives, and in a group of two or more. So does a mob on the pet at full health with nothing to show that it or we attacked it: it has no aggro on us (StandardMobBrain.cs:566-571). A 0 clears any of this, and a 0x72 under 6 s after its naming puts it back: a caster's 0 can come first. A DoT's tick on one of ours names nobody when the mob was named on another of ours in the last 6 s: it has no 0x1B, and says where the spell landed some time ago. */
  targetObjectId: number | null;
  /** `targetObjectId` stands on a spell alone: a mob casting from range at us or a pet of ours, with its 0x1B or its damage spell's 0xBC to go by, or held through 0xA1's 0 between casts. Its target for the bot's own fight all the same, as the server sends none (PacketLib168.cs:820-828). The group reads it as the others' clients do, from the spell (observeState, Contact.targetBySpell), so what is on a member isn't told by whose report came last. Absent otherwise: the server's own id, a swing, or a run at us (65535). */
  targetBySpell?: boolean;
  /** When the client first held this entry, on its clock (as `receivedAt`): a death under this id before then was another mob's, as the server hands ids on at once (Region.cs:955). Absent from an older client. */
  firstSeenAt?: number;
  inCombat: boolean;
  /** Flags decoded from 0xDA. */
  isPeaceful: boolean;
  isTargetable: boolean;
  hasQuest: boolean;
  isPet: boolean;
  /** Best-effort guess from guild/name text: 'merchant', 'trainer', 'guard', 'healer', 'stablemaster', ... */
  role: string | null;
}
```

### NearbyPlayer

```typescript
interface NearbyPlayer extends WorldObjectBase {
  kind: 'player';
  sessionId: number;
  guildName: string;
  lastName: string;
  level: number;
  realm: Realm;
  /** Rounded down by the server (GameLiving.cs:2621): a living player with a few hit points reads 0. */
  healthPercent: number;
  /** The death signal: set by the death event (0xAE) and kept until the player shows health again; never inferred from 0 %. */
  isDead: boolean;
  isSitting: boolean;
  inCombat: boolean;
  /** Its model, from its create (PacketLib1124.cs:382) and every change since (0xDB, PacketLib168.cs:990-998). Absent from an older client. */
  model?: number;
  /** A Necromancer in shade, model 822 (GamePlayer.cs:12345-12346): nobody can attack it, and no pet can be ordered at it: `You can't attack a shadowed necromancer!` (AbstractServerRules.cs:449-455). Its servant can be. Absent from an older client. */
  isShade?: boolean;
  /** What it shows it wears and holds (0x15 EquipmentUpdate), as any client in view draws it. Absent before its first 0x15 and from an older client. */
  gear?: PlayerGear;
}
```

### PlayerGear

A living's visible equipment (0x15, PacketLib1124.cs:52-105).

```typescript
interface PlayerGear {
  /** VisibleActiveWeaponSlots: low nibble the right hand's slot - 10, high nibble the left's; 0xF none, 0xFF nothing drawn (GameLiving.cs:2037). */
  activeWeapons: number;
  /** Slot (eInventorySlot: 10 right hand, 11 left, 12 two-hand, 13 ranged, 21-28 armour, 26 cloak) and item model. */
  items: { slot: number; model: number }[];
  /** When it came (ms epoch). */
  at: number;
}
```

### NearbyObject

```typescript
interface NearbyObject extends WorldObjectBase {
  kind: 'object';
  model: number;
  realm: Realm;
  /** Door id when this object is a door. */
  doorId: number | null;
  /** True when this is likely loot on the ground (bag/coins/drop). */
  isLoot: boolean;
  /** True when the server says this loot belongs to us. */
  ownedByUs: boolean;
}
```

### InventoryItem

```typescript
interface InventoryItem {
  /** DAoC inventory slot (see EquipmentSlot / backpack 40-79). */
  slot: number;
  name: string;
  level: number;
  count: number;
  model: number;
  objectType: number;
  condition: number;
  durability: number;
  quality: number;
  weight: number;
  /** Raw value fields from ItemData (DPS/AF, SPD/ABS etc. depending on type). */
  value1: number;
  value2: number;
  /** See ItemHand. Only a weapon's means anything. */
  hand: number;
}
```

### Specialization

```typescript
interface Specialization {
  /** The server's display name, not always the key elsewhere: 'Shield' (key Shields), 'Light Magic' (key Light). sdk.findSpecialization takes either. */
  name: string;
  level: number;
  internalId: number;
  /** Levels added on top of `level` by items and the like. */
  bonus: number;
}
```

### Ability

```typescript
interface Ability {
  name: string;
  level: number;
  internalId: number;
  /** Index to pass to the useSkill action. */
  skillIndex: number;
  /** The server's tooltip fields as sent; a plain ability has little beyond Index and Name. */
  details?: Record<string, string>;
}
```

### StyleDetails

A style as the server's tooltip describes it.

```typescript
interface StyleDetails {
  /** Endurance cost as the style table lists it. */
  fatigue: number;
  /** To-hit and defence modifiers while the style lands. */
  attackMod: number;
  defensiveMod: number;
  /** Damage growth: the style's GrowthRate * 200. */
  openingDamage: number;
  /** What it needs: his own last attack (offensive), the enemy's (defensive), or where he stands (positional). */
  opening: 'offensive' | 'defensive' | 'positional';
  /** The attack result `opening` asks for; null for any. 'styledHit' with `openingStyle` is a follow-up. */
  result: CombatResult | null;
  position: 'back' | 'side' | 'front' | null;
  /** The style this one follows. */
  openingStyle: string | null;
  /** Styles that follow this one, learned or not. */
  followUps: string[];
  /** Weapon it needs, in the server's words. */
  weapon: string | null;
  /** Needs stealth. */
  stealth: boolean;
  /** Internal id of the spell it procs, and that spell's details when the server sent them. */
  procSpellId: number | null;
  procSpell?: SpellDetails;
}
```

### SpellDetails

A spell as the server's tooltip describes it.

```typescript
interface SpellDetails {
  /** 0 when instant; null for a cast under 2 s, which the tooltip doesn't state. */
  castTimeMs: number | null;
  damageType: string | null;
  /** Negative: a percent of the full pool. */
  powerCost: number;
  costType: 'power' | 'health' | 'endurance';
  range: number;
  durationSeconds: number;
  recastSeconds: number;
  target: 'self' | 'enemy' | 'group' | 'pet' | 'realm' | 'corpse' | 'area';
  radius: number;
  concentration: number;
  /** Time between pulses or ticks. */
  frequencyMs: number;
  /** The server's description; empty when it has none. */
  description: string;
}
```

### Style

```typescript
interface Style {
  name: string;
  internalId: number;
  specLevel: number;
  /** The line's DB key, so 'Shields' where the skill list says 'Shield': find its level with sdk.findSpecialization(specName). */
  specName: string | null;
  /** Index to pass to the useSkill action. */
  skillIndex: number;
  /** Raw prerequisite code from 0x16/01 (0x100 = none). `details` says the same in words. */
  prerequisite: number;
  /** From the 0xD8 tooltip the server pushes after the skills list. */
  details?: StyleDetails;
}
```

### Spell

```typescript
interface Spell {
  name: string;
  level: number;
  internalId: number;
  lineName: string;
  /** Indices to pass to the castSpell action. */
  lineIndex: number;
  spellIndex: number;
  /** Seconds remaining on cooldown, 0 when ready. */
  cooldownRemaining: number;
  /** Set for hybrid-class spells that live in the usable-skills list instead of a spell line (lineIndex/spellIndex are then -1): cast them with useSkill(skillIndex). */
  skillIndex?: number;
  /** From the 0xD8 tooltip the server pushes after the skills list. */
  details?: SpellDetails;
}
```

### ConcentrationEffect

Server 0x75 concentration list entry.

```typescript
interface ConcentrationEffect {
  index: number;
  name: string;
  ownerName: string;
  concentration: number;
  icon: number;
}
```

### SkillsState

```typescript
interface SkillsState {
  specializations: Specialization[];
  abilities: Ability[];
  styles: Style[];
  spells: Spell[];
}
```

### Effect

```typescript
interface Effect {
  index: number;
  name: string;
  icon: number;
  spellId: number;
  remainingSeconds: number;
  isNegative: boolean;
}
```

### GameMessage

```typescript
interface GameMessage {
  /** Monotonic id assigned by the client; stable across snapshots. */
  id: number;
  type: ChatType;
  /** Raw eChatType byte. */
  rawType: number;
  text: string;
  /** Parsed sender for player chat ("Bob says, ..."), else null. */
  sender: string | null;
  /** True for popup-window ("##") messages, e.g. NPC dialog text. */
  popup: boolean;
  receivedAt: number;
}
```

### NpcDialog

Last NPC dialogue seen (GameNPC.SayTo text), with [keywords] extracted.

```typescript
interface NpcDialog {
  npcObjectId: number | null;
  npcName: string | null;
  text: string;
  keywords: string[];
  receivedAt: number;
}
```

### DialogBox

Server 0x81 dialog box (group invite, quest offer, custom yes/no, ...).

```typescript
interface DialogBox {
  isOpen: boolean;
  code: number;
  data: [number, number, number, number];
  /** 0 = OK only, 1 = yes/no. */
  type: number;
  text: string;
  receivedAt: number;
  /** Set when this box is a resurrection offer. */
  resurrection?: ResurrectionOffer;
}
```

### ResurrectionOffer

Another player's rez waiting for our answer: who cast it and the health it restores. It expires after 15 s, and the caster's power is gone then.

```typescript
interface ResurrectionOffer {
  caster: string;
  healthPercent: number;
}
```

### ItemBonus

One bonus line of an item delve (sdk/delve.ts).

```typescript
interface ItemBonus {
  category: BonusCategory;
  /** The server's name for it: "Strength", "Body Magic Focus". */
  name: string;
  /** Negative for a penalty. */
  value: number;
  unit: 'pts' | '%' | 'lvls' | null;
  /** category 'stat'. */
  stat?: 'STR' | 'DEX' | 'CON' | 'QUI' | 'INT' | 'PIE' | 'EMP' | 'CHR' | 'ACU';
  /** category 'skill' and 'focus': the specialization's DB key, as in classes.json (sdk.findSpecialization takes it), null when no class has one. */
  spec?: string | null;
  /** category 'skill': its ePropertyType group; 'skillGroup': the group it raises, null for "All Skills". */
  group?: SkillGroup | null;
  /** The line as the server sent it. */
  text: string;
}
```

### WeaponDelve

A weapon's "Damage Modifiers" lines.

```typescript
interface WeaponDelve {
  baseDps: number;
  /** DPS at this character's level (GamePlayer.GetWeaponDpsCap). */
  clampedDps: number;
  /** Seconds per swing. */
  speed: number;
  quality: number;
  condition: number;
}
```

### ParsedDelve

```typescript
interface ParsedDelve {
  bonuses: ItemBonus[];
  /** Non-blank lines that are neither a bonus nor known layout: proc spell text, descriptions, new formats. */
  unknown: string[];
  /** "Bonus Level: N" (GameInventoryItem.cs:478-482). Nothing enforces it: only the delve and spellcrafting read it. */
  bonusLevel: number | null;
  /** "Level Requirement: N Level" (:564). It gates the item's spells (GamePlayer.cs:7045), not its bonuses. */
  levelRequirement: number | null;
}
```

### TextWindow

Server 0xC4 custom text window.

```typescript
interface TextWindow {
  caption: string;
  lines: string[];
  receivedAt: number;
}
```

### MerchantItem

```typescript
interface MerchantItem {
  page: number;
  slot: number;
  name: string;
  level: number;
  price: number;
  model: number;
  /** The server's verdict: this character has the ability to use it. */
  usable: boolean;
  /** See ObjectType (the same number as InventoryItem.objectType). */
  objectType: number;
  /** See ItemHand. */
  hand: number;
  /** Crush, slash or thrust for a weapon; null otherwise. */
  damageType: 'crush' | 'slash' | 'thrust' | null;
  /** DPS * 10 for a weapon, AF for armour, pack size for ammunition (PacketLib1125.cs:640-675). */
  value1: number;
  /** Speed in 0.1 s for a weapon, absorption for armour. */
  spdAbs: number;
}
```

### MerchantState

```typescript
interface MerchantState {
  isOpen: boolean;
  merchantObjectId: number | null;
  windowType: number;
  items: MerchantItem[];
}
```

### TrainerSpec

```typescript
interface TrainerSpec {
  index: number;
  /** The server's display name, as in Specialization.name. */
  name: string;
  level: number;
  /** Cost in spec points to train the next level. */
  nextLevelCost: number;
}
```

### TrainerState

```typescript
interface TrainerState {
  /** True from a 0x7B trainer window until the target moves off its trainer, we walk more than 512 units from where it arrived, or the region changes (the server never sends a close). */
  isOpen: boolean;
  specPoints: number;
  specs: TrainerSpec[];
  /** The object targeted when the window arrived (the trainer), or null. */
  trainerObjectId?: number | null;
  /** ms timestamp of the last 0x7B; kept when the window closes. Compare it to detect a fresh window. */
  receivedAt?: number;
}
```

### GroupMember

```typescript
interface GroupMember {
  name: string;
  className: string;
  level: number;
  objectId: number;
  healthPercent: number;
  manaPercent: number;
  endurancePercent: number;
  isDead: boolean;
  inOtherRegion: boolean;
}
```

### CombatEvent

```typescript
interface CombatEvent {
  id: number;
  kind: 'melee' | 'spellCast' | 'spellEffect' | 'interrupt' | 'death';
  attackerObjectId: number | null;
  targetObjectId: number | null;
  result?: CombatResult;
  targetHealthPercent?: number;
  /** Spell cast time in ms for kind 'spellCast'. */
  castTimeMs?: number;
  /** For kinds 'spellCast' and 'spellEffect': the spell's client effect id (Spell.ClientEffect, SpellHandler.cs:1273/:1290), not its spell id. */
  effectId?: number;
  /** Kind 'melee': the 0xBC animation, when not a plain swing: a style's (Style.Icon, or its TwoHandAnimation with a two-hander; StyleProcessor.cs:448-452), or a dual wield's or a bow's. */
  style?: number;
  /** Kind 'melee': the model of the weapon it swung or shot. */
  weaponModel?: number;
  receivedAt: number;
}
```

### MovementState

```typescript
interface MovementState {
  moving: boolean;
  destination: Vec3 | null;
  /** Remaining waypoints, including the destination. */
  waypoints: Vec3[];
  /** Set when the last move stopped without arriving. */
  lastStopReason: 'arrived' | 'stopped' | 'teleported' | 'regionChange' | 'died' | null;
  /** Count of server position corrections (0x04 CharacterJump / 0x20) received. */
  correctionCount: number;
  /** In deep water: position updates carry the swim flag and z sits under the river surface (sdk/ground.ts). */
  swimming: boolean;
}
```

### ConnectionInfo

```typescript
interface ConnectionInfo {
  phase: ClientPhase;
  serverName: string;
  clientVersion: string;
  /** Last login/disconnect error if any (e.g. "AccountIsInLogoutProcedure"). */
  lastError: string | null;
}
```

### TradeWindow

Open player trade (server 0xEA). Accept state is not on the wire: every 0xEA means both accepts were reset.

```typescript
interface TradeWindow {
  /** Process-wide, new per window. */
  id: number;
  /** 1 on open, +1 per 0xEA. */
  revision: number;
  /** From "Trading with <name>". Null is a self-craft window: never accept it. */
  partnerName: string | null;
  /** Our offered slots. The items stay there until the commit. */
  mySlots: number[];
  /** Copper. */
  myMoney: number;
  /** slot is the PARTNER's slot, never ours. */
  partnerItems: InventoryItem[];
  /** Copper. */
  partnerMoney: number;
}
```

### PetState

Our pet as the server's pet window (0x88) has it. A pet the window doesn't list (a Theurgist's, a fire-and-forget turret, a bomber, a Bonedancer's minion: SetBrainToOwner is empty or the commander holds it) never shows here. Its health and position are its entry in nearbyNpcs (sdk.getPet): that entry can be gone while the window stays: out of view, or until the client has asked for it again after a jump.

```typescript
interface PetState {
  objectId: number;
  /** Its name, from its entry when we last had one, so it holds while the pet is out of view. Absent until an entry was seen, and from an older client. */
  name?: string;
  /** From the server, not from what we asked: an order can change it (ControlledMobBrain.cs:213-214, :228-233). */
  aggression: PetAggression;
  /** Where it was told to go. A turret's reads 'follow' for its whole life: its walk orders change nothing (TurretBrain.cs:100-108). */
  walk: PetWalk;
  /** Effect icons on it, at most 8 (PacketLib181.cs:157-166). */
  icons: number[];
  /** Who it is fighting, a caster pet between casts and a pet on its way included. Set by the answer to an attack order (to what the order named), by its 0xBC swing or 0x1B cast at an enemy, and by an 0xA1 naming the id. An 0xA1 reading 0, as a caster's does between casts (PacketLib168.cs:820), clears it only when all that is over 6 s old; one reading 0xFFFF (on the move) keeps it and counts as that evidence, for a run of any length. Cleared at once by the target's death (an 0xA1 still naming it in the next 2 s, older than the death, reads 0), a change to passive, and the answer to a follow, stay, come here or go to target order (a defensive pet that hits back gets a fresh target from that swing). Null when it isn't fighting. */
  targetObjectId: number | null;
}
```

### PetLoss

How our last window pet went. Stays until the next loss: compare `at`. 'released' is any close that came first: our order, a charm or duration ending, the tether, or a death out of our view (its 0xA2 goes only to players near it).

```typescript
interface PetLoss {
  objectId: number;
  /** From its NPC entry, also one since gone out of view; null when we never had one. */
  name: string | null;
  cause: PetLossCause;
  /** Client wall-clock time (ms epoch). */
  at: number;
  /** The NPCs that read as on it when it went; absent with none. Their entries can't say so any more: the model hands them to us at the loss, or with another for them to turn to (a groupmate, another pet of ours) clears them. Absent from an older client. */
  targetedBy?: number[];
  /** Who it aimed at when it went (PetState.targetObjectId), which targetedBy can't say of a mob it was on its way to. Absent with nobody, and from an older client. */
  targetObjectId?: number;
}
```

### BotWorldState

```typescript
interface BotWorldState {
  /** Monotonic publish counter (one per published snapshot). */
  tick: number;
  revision: number;
  /** Client wall-clock time (ms epoch) when the snapshot was built. */
  timestamp: number;
  inGame: boolean;
  connection: ConnectionInfo;
  player: PlayerState | null;
  movement: MovementState;
  nearbyNpcs: NearbyNpc[];
  nearbyPlayers: NearbyPlayer[];
  nearbyObjects: NearbyObject[];
  /** Backpack (slots 40-79). */
  inventory: InventoryItem[];
  /** Equipped items (slots 10-37). */
  equipment: InventoryItem[];
  /** Vault items, populated after the vault window has been opened. */
  vault: InventoryItem[];
  /** When a vault keeper last opened the vault in this client session; null or absent means `vault` says nothing yet. */
  vaultOpenedAt?: number | null;
  skills: SkillsState;
  effects: Effect[];
  group: GroupMember[];
  /** Last 100 messages, oldest first. */
  gameMessages: GameMessage[];
  npcDialog: NpcDialog | null;
  dialog: DialogBox | null;
  textWindow: TextWindow | null;
  merchant: MerchantState;
  trainer: TrainerState;
  /** Last 200 combat events in view (ours and everyone else's), oldest first. */
  combatEvents: CombatEvent[];
  /** Concentration effects we maintain (server 0x75). */
  concentrationEffects?: ConcentrationEffect[];
  /** Current ground target, when set via setGroundTarget or the server (0xEC). Null again once the server drops it: 'Your ground target is not visible!'. */
  groundTarget?: Vec3 | null;
  /** Open player trade window; absent or null when closed. */
  trade?: TradeWindow | null;
  /** Our pet's window; null without one, absent from an older client. */
  pet?: PetState | null;
  /** How the last window pet went; null before the first loss. */
  lastPetLoss?: PetLoss | null;
  /** Object ids of our own pets with no window, in view or not (sdk.getSummons has the entries in view): a Theurgist's, a fire-and-forget turret, a bomber, a Bonedancer's minion. Known from the 0x1B of their summon on an entry just seen, so a buff of ours on a groupmate's fresh pet can land here too. Gone with their 0xA2 type 0, a region change, a 0xDA under that id with no pet flag or another name (ids get reused), for a minion the window closing (it goes with its commander), or 30 s with no entry: one that ends out of view leaves no 0xA2, so it lingers that long, and one of ours that comes back after that reads as a stranger's. A minion is exempt from the 30 s while its window is open: it can't outlive the commander, and it would be a pet nothing could address. Absent from an older client. */
  summons?: number[];
  /** Those of `summons` that came under 3.5 s ago, minions left out. One that fights by itself is in its fight from the start (TheurgistPetBrain.cs), with nothing to show it yet: a caster in range reads target 0 until its first cast lands (PacketLib168.cs:820). Absent from an older client. */
  freshSummons?: number[];
}
```

### ActionResult

```typescript
interface ActionResult {
  success: boolean;
  message: string;
  data?: unknown;
  /** Machine-readable failure reason, e.g. 'timeout', 'busy', 'not_in_game', 'unknown_object'. */
  reason?: string;
  phase?: ActionPhase;
}
```

### BotStatus

```typescript
interface BotStatus {
  status: 'active' | 'stale' | 'dead' | 'unknown';
  inGame: boolean;
  stateAge: number | null;
  controllers: string[];
  observers: string[];
  player: { name: string; regionId: number; x: number; y: number; z: number } | null;
}
```

### SDKConfig

```typescript
interface SDKConfig {
  botUsername: string;
  password?: string;
  gatewayUrl?: string;
  connectionMode?: ConnectionMode;
  /** Spawn a headless client process for this bot when none is attached. */
  autoLaunchClient?: boolean | 'auto';
  readyTimeout?: number;
  connectTimeout?: number;
  actionTimeout?: number;
  autoReconnect?: boolean;
  reconnectMaxRetries?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  /** false hides other players' chat (say/send/group/... from someone else). Our own echoes, popup text and NPC speech stay: NPCs talk as CT_Say too (GameNPC.cs:2607-2608), and bot.say/talkTo/whisper observe those lines. Default true. */
  showChat?: boolean;
}
```

### FindNpcOptions

```typescript
interface FindNpcOptions {
  /** Max 3D distance from the player. */
  maxDistance?: number;
  minLevel?: number;
  maxLevel?: number;
  /** Only NPCs {@link isAttackable} says we can fight. */
  attackable?: boolean;
}
```

### FindOptions

```typescript
interface FindOptions {
  maxDistance?: number;
}
```

### ChatQuery

```typescript
interface ChatQuery {
  /** Max messages (default 20; 0 = all retained). */
  limit?: number;
  /** Chat types to include (default player chat), or 'all'. */
  types?: readonly ChatType[] | 'all';
  /** Include our own echoed speech (default false). */
  includeSelf?: boolean;
}
```

### ChatSendOptions

```typescript
interface ChatSendOptions {
  /** Max chars per chunk (capped at {@link BotSDK.maxMessageLength}). */
  maxLen?: number;
  /** Pause between chunks (default 700 ms: '&say' rejects faster than 500 ms, commands/playercommands/say.cs:47). */
  delayMs?: number;
}
```

### WalkOptions

```typescript
interface WalkOptions {
  /** Destination height; default: the navmesh ground where the zone has a mesh, else estimated from static data (by the path provider). */
  z?: number;
  /** Arrival radius on the ground plane (default 64). */
  tolerance?: number;
  /** Overall deadline in ms, planning included (default: 1.5 × ETA along the planned route + 15 s, extended when a correction re-plans a longer route). */
  timeout?: number;
  /** Route planner (default getDefaultPathProvider(): NavmeshPathProvider when meshes are built with bun run navmesh:build, else StraightLinePathProvider; DAOC_NAVMESH=off forces straight lines). */
  pathProvider?: PathProvider;
  /** Fraction of max speed (default 0.9, the mover's safe cap). */
  speedFactor?: number;
  /** Fail after this long without getting closer (default 8000 ms). */
  stuckMs?: number;
}
```

### RepairResult

```typescript
interface RepairResult extends ActionResult {
  /** What was handed over; null for repairAll. */
  item: InventoryItem | null;
  /** The same item as it is now; null for repairAll. Its `condition` is a percent rounded up, so 100 can still hide wear. */
  repaired: InventoryItem | null;
  /** Copper the purse lost. */
  cost: number;
  messages: GameMessage[];
}
```

### VaultResult

```typescript
interface VaultResult extends ActionResult {
  keeper: NearbyNpc | null;
  items: InventoryItem[];
}
```

### WalkResult

```typescript
interface WalkResult extends ActionResult {
  position: Vec3 | null;
  /** Remaining 2D distance to the destination. */
  distance: number;
  /** Times the move was re-issued after a server correction or stop. */
  reissues: number;
}
```

### WalkToObjectOptions

```typescript
interface WalkToObjectOptions {
  /** Required 3D distance to the target (default 100). */
  range?: number;
  /** The whole walk, however often the target moves on (default: each leg's own, see WalkOptions). */
  timeout?: number;
}
```

### WalkToObjectResult

```typescript
interface WalkToObjectResult extends WalkResult {
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  /** With reason already_dead: the target died during this walk, or just before it with its id gone. It says nothing against the walker. */
  targetDied?: true;
}
```

### FaceResult

```typescript
interface FaceResult extends ActionResult {
  heading: number;
}
```

### TargetResult

```typescript
interface TargetResult extends ActionResult {
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
}
```

### InteractOptions

```typescript
interface InteractOptions {
  /** Walk until within this 3D distance first (default 150; the server allows 192). */
  range?: number;
  /** How long to wait for a response (default 4000 ms). */
  timeout?: number;
}
```

### InteractResult

```typescript
interface InteractResult extends ActionResult {
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  response: InteractResponse | null;
  dialog: NpcDialog | null;
  /** Messages that arrived in response. */
  messages: GameMessage[];
}
```

### DialogResult

```typescript
interface DialogResult extends ActionResult {
  npc: NearbyNpc | null;
  dialog: NpcDialog | null;
  /** [keywords] in the newest dialog text. */
  keywords: string[];
  text: string;
  messages: GameMessage[];
}
```

### RespondDialogResult

```typescript
interface RespondDialogResult extends ActionResult {
  dialog: DialogBox | null;
}
```

### AttackResult

```typescript
interface AttackResult extends ActionResult {
  /** The target when it is an NPC (null for a player). */
  npc: NearbyNpc | null;
  /** The resolved target, NPC or player. */
  target: NearbyNpc | NearbyPlayer | null;
  /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
  retryAfterMs?: number;
}
```

### KillOptions

```typescript
interface KillOptions {
  /** Give up after this long (default 60000 ms). */
  timeout?: number;
  /** Style names to rotate through, one per swing (endurance permitting). */
  styles?: string[];
  /** Pick the style, or a style and its backup, per swing instead of rotating `styles`. */
  useStyle?: StyleChooser;
  /** Follow a target that moves away (default true). */
  chase?: boolean;
  /** Stop chasing a target that has moved this far on the ground plane from where it stood when the fight began (default 2500). How far off it stands doesn't count: one that hasn't moved isn't running. */
  maxChaseDistance?: number;
  /** Allow NPCs isKillable() rejects (realm NPCs, peaceful flags) (default false). An enemy realm's pet needs no force. */
  force?: boolean;
  /** Order a window pet that isn't passive onto the target too (default true). It wouldn't join by itself: it only answers a hit on us (GamePlayer.cs:5152-5153). A group run another controller took a member from can leave one passive (setPetAggression). In shade the pet does all of it, as petKill. False there is reason 'refused': a shade can't melee. */
  usePet?: boolean;
  /** End the fight, reason 'pet_died' as petKill's, as soon as the window pet we had at its start is gone, for a caller with something to do about that (default false: we fight on, and nothing looks at the pet). The swing stops with it, as at any end of the fight, and starting it again costs nothing (AttackAction.cs:54). */
  endOnPetLoss?: boolean;
}
```

### KillResult

```typescript
interface KillResult extends ActionResult {
  /** The target's entry as the fight ended; once it has gone, the one the fight began with. */
  npc: NearbyNpc | null;
  killed: boolean;
  /** All the XP gained during the fight: another kill of ours in that time counts too, a fire-and-forget pet's say. */
  xpGained: number;
  rpGained: number;
  moneyGained: number;
  itemsGained: InventoryItem[];
  durationMs: number;
  levelsGained: number;
  stylesUsed: number;
  /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
  retryAfterMs?: number;
  /** For reason 'attacked': the mob on us. */
  attacker?: NearbyNpc;
}
```

### KillPlayerOptions

killPlayer's options: KillOptions' timeout, styles, chase and maxChaseDistance, with a style chooser for players.

```typescript
interface KillPlayerOptions extends Omit<KillOptions, 'useStyle' | 'force' | 'usePet'> {
  /** Pick the style per swing instead of rotating `styles`. */
  useStyle?: PlayerStyleChooser;
}
```

### KillPlayerResult

KillResult's numbers for an enemy player. A player kill gives realm points: rpGained counts those that arrived by the time the death did (killPlayer does not wait for the award).

```typescript
interface KillPlayerResult extends Omit<KillResult, 'npc'> {
  player: NearbyPlayer | null;
}
```

### ResurrectOptions

```typescript
interface ResurrectOptions {
  /** The rez to cast; default our strongest (resurrectSpell). */
  spell?: Spell;
  /** How long to wait for the target's answer once the cast is done (default 16 s: its question expires after 15 s). */
  answerMs?: number;
  /** Walk into range (default true). */
  approach?: boolean;
}
```

### ResurrectResult

```typescript
interface ResurrectResult extends ActionResult {
  spell: Spell | null;
  target: NearbyPlayer | null;
  /** The cast itself. A finished cast only asks the target. */
  cast: CastResult | null;
}
```

### AcceptResurrectionResult

```typescript
interface AcceptResurrectionResult extends ActionResult {
  offer: ResurrectionOffer | null;
}
```

### CastOptions

```typescript
interface CastOptions {
  /** Walk into range first (default true). */
  approach?: boolean;
  /** Spell range override (default: data spell range, else 1500). */
  range?: number;
  /** Wait for this long beyond the cast time for completion (default 2500 ms). */
  timeout?: number;
  /** Re-select the target and cast once more on "You must select a target" (default true). Only when the refusal came before the cast began and the target is still the one we chose: no death since we selected it and the same name under its ID (the server hands a dead mob's ID to the next spawn). Otherwise the result keeps reason 'no_target' and its message ends in " (target gone, not retried)". */
  retryNoTarget?: boolean;
}
```

### CastResult

```typescript
interface CastResult extends ActionResult {
  spell: Spell | null;
  /** As it read before the cast: a charmed mob here still has no realm, the pet's entry has its new one. For a Group spell only what was selected: it lands on us and our group whatever that is (SpellHandler.cs:1747-1761). */
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  /** The real cast time, from the server's animation (0x72). Null when it sent none: an instant spell, or a cast begun right after a jump such as a respawn, when that goes by who is around us and we aren't yet (SpellHandler.cs:1266-1275). */
  castTimeMs: number | null;
  /** The server reported the cast finished ("You cast a <spell> spell!", or an effect, damage or resist once the cast time is up). False with `queued`. */
  completed: boolean;
  /** A servant's spell that all we know of is "will begin casting this spell after its current action is finished" (AI.txt:4): paid, and not yet cast. It holds its current spell and one more, the last wins, and each one dropped was paid for, with no line about it (NecromancerPetBrain.cs:124, CastingComponent.cs:383-386). Cast again only after "cast a X spell!". */
  queued?: true;
  /** A resist line naming the target (a player's has the real name, so any name counts there: we know enemies by race), with our own 0x1B at it within 250 ms and no pet's 0x1B nearer: a pet's resist reads the same (SpellHandler.cs:2390, :2446-2456). Always false for a summon, which can't be resisted (SummonSpellHandler.cs:195), and a Self spell. */
  resisted: boolean;
  /** The cast went off (success, power spent) but its effect did not land: "Your target is immune to this effect!" (CCSpellHandler.cs:173/288, SpellHandler.cs:571). A player already mezzed or stunned, or within the 60 s immunity that follows one (CrowdControlECSEffect.cs), an NPC's mezz immunity, a snare immunity. `resisted` stays false: the target did not resist, nothing could have landed. So too a mezz at an NPC under 75 % health, "Your target is enraged and resists the spell!" (CCSpellHandler.cs:174-178), which the message reads as `(target enraged)`: the same branch, words apart. */
  effectImmune?: boolean;
  /** With reason already_dead: our target died during this cast, or on the walk to it, or its id was gone just after its death: those two with no cast at all. Nothing landed and nothing was paid, and it says nothing against the caster: it is the fight's end. */
  targetDied?: true;
  /** With reason must_wait: the server holds this spell as the follow-up of the cast still running ("You prepare this spell as a follow up!"), and starts it by itself after retryAfterMs, unless another replaces it or that cast fails at its end (its target gone, say), which drops it without a word. This long is its own cast time. */
  followUpMs?: number;
  /** The cast went off but the server refused the effect: "{0} already has that effect. Wait until it expires. Spell failed." The same spell is still on a player (EffectListComponent.cs:689), as for a second root while one holds. */
  alreadyOn?: boolean;
  /** Whether the server said its effect landed: the spell's own line for that ("{0} is entranced!", Message2), sent to the caster. false when the spell has one and it never came, undefined when it has none. A monster's repeat replaces the old effect without a word (ECSGameEffect.cs OnEffectStartsMsg). */
  effectLanded?: boolean;
  /** The name in that line: an enemy player's real name, which its race-named entry in the world state never shows. */
  landedOn?: string;
  /** Damage from "You hit X for N damage!" / "Your <this spell> hits X for N damage!" lines that arrived once the cast time was up. Other spells' DoT ticks and "extra damage" lines are left out; a damage shield's "You hit X for N damage!" in the same moment cannot be told apart. Always 0 for a summon. A bomber's hit comes when it arrives, up to 4 s later, and reads like any other (BomberBrain.cs:25-30): watch the mob's health for it. */
  damage: number;
  messages: GameMessage[];
  /** For reason 'must_wait' / 'interrupted' / 'immune' / 'crowd_controlled': ms until casting is allowed again ("You must wait N seconds"). For reason 'refused', a song with no instrument in hand only: 60 s, as only a change of hand cures it. */
  retryAfterMs?: number;
}
```

### SummonPetOptions

```typescript
interface SummonPetOptions extends CastOptions {
  /** The spell's target: a Theurgist's pet, a bomber and a charm take an enemy. Default: the current target. */
  target?: ObjectTarget | null;
  /** Set this ground target first: an Animist's turrets stand on it (SummonAnimistPet.cs:21-40). It must be in the spell's range. Without z the client snaps it to its terrain, under a river the mesh's plane there (else our own height); a z passed goes out as given. The server drops a spot over 16 units off the mesh (PlayerGroundTargetHandler.cs:21-30, :63-85): reason refused. An NPC's coordinates are always valid. That drop wipes the ground target we had as well, and nothing puts it back. With `replace` a spot with no z that its height puts out of range is refused after it was set, and the ground target we had goes back; with none before, the refused spot is wiped too, so a later summon with no spot reads no_ground_target. */
  groundTarget?: Point;
  /** Release the window pet we have and wait for the close first: until then the server refuses (default false: reason 'pet_exists'). A fire-and-forget pet or a minion replaces nothing. The pet stays when the new cast can't go: the spell's cooldown, power below the most it can cost (a focus item we can't see may lower the real cost, so this can refuse what would go: releasePet by hand goes on regardless), melee for a spell with a cast time (reason in_combat: a mob on us, a mob on the pet near enough to swing at us by the cast's half way, 220 units/s (faster if it reads so) and 250 more, about 910 for 6 s, as the release turns it on us (StandardMobBrain.cs:569-570, CharmECSEffect.cs:87-95), our swing on, a swing of ours within its weapon's interval, which holds the cast back, or a hit on us under 3 s ago, which can interrupt it at its half way, SpellHandler.cs:356-372, :603-620; releasePet by hand goes on regardless), for a turret a ground target that is missing, out of range, within 16 of the range or put beyond it by the mesh where one is loaded (the server moves a spot to the nearest walkable ground, then measures in 3D), or dropped, and for a charm a mob that can't be taken, with the walk to it before the release. In shade the release costs health: PlayerState.isShade. */
  replace?: boolean;
  /** How long after the cast the pet gets to appear (default 3000 ms). */
  appearTimeout?: number;
}
```

### CharmPetOptions

SummonPetOptions without the target, which charmPet takes itself.

```typescript
interface CharmPetOptions extends Omit<SummonPetOptions, 'target' | 'groundTarget'> {
  /** This charm and no other (default: the best known, then the next when the mob is of the wrong type). */
  spell?: NamePattern;
}
```

### SummonPetResult

```typescript
interface SummonPetResult extends CastResult {
  /** Its NPC entry: the window's, or else the one named by the "under your control" line. Null for a silent summon (a bomber) or when it isn't in view yet. */
  pet: NearbyNpc | null;
  /** Null for a pet the window doesn't list: a fire-and-forget pet or a minion. */
  petState: PetState | null;
}
```

### PetCommandOptions

```typescript
interface PetCommandOptions {
  /** How long the server gets to answer (default 3000 ms). */
  timeout?: number;
}
```

### ReleasePetOptions

```typescript
interface ReleasePetOptions extends PetCommandOptions {
  /** One pet of ours with no window to release: a selected fire-and-forget turret or a minion, which the server accepts (CharacterClassBase.cs:336-341). Default: the window pet. */
  target?: NpcTarget | null;
}
```

### PetTargetOptions

A pet order that selects a target first.

```typescript
interface PetTargetOptions extends PetCommandOptions {
  /** Select our previous target again afterwards (default false). The order moves our target, and our own melee reads it on every swing (AttackAction.cs:84). */
  restoreTarget?: boolean;
}
```

### PetCommandResult

```typescript
interface PetCommandResult extends ActionResult {
  command: PetCommand;
  /** Its NPC entry; null when out of view. After a release as it reads then: null when it has gone, or a charm's ex-pet. */
  pet: NearbyNpc | null;
  /** As the server has it after the order; null without a window. */
  petState: PetState | null;
  messages: GameMessage[];
}
```

### PetAttackResult

```typescript
interface PetAttackResult extends PetCommandResult {
  target: NearbyNpc | NearbyPlayer | null;
  /** For reason 'immune' (PvP immunity, ours or the target's): ms until trying again makes sense. */
  retryAfterMs?: number;
}
```

### PetKillOptions

```typescript
interface PetKillOptions {
  /** Give up after this long (default 60000 ms). The pet keeps its order: setPetAggression('passive') calls it off; petFollow only drops the order, and a defensive pet hits back while the mob stays on it. */
  timeout?: number;
  /** Walk within range of an order when the target is beyond it (2000 units from us, not from the pet), or when the server refuses a first order as out of range; never into melee (default true). A turret's owner doesn't walk. A shade walks within 1000 and steps after its servant during the fight, for the tether. False: no walking at all, and the tether is the caller's to mind. */
  approach?: boolean;
  /** Fight on while another mob is on us (default false: reason 'attacked'). An ordered pet won't turn to help (ControlledMobBrain.cs:549-552). */
  ignoreAttackers?: boolean;
  /** End the wait as soon as the target stands this near us, reason 'arrived', for a caller with something to do then: grind's melee as a mob on us gets here. The pet keeps its order. Default: no such end. */
  endWithin?: number;
  /** As endWithin, once the target reads on us as well: a pass with the mob on the pet, for a caller who can swing when it turns. Default: no such end. */
  endOnUsWithin?: number;
}
```

### MeleeSlotResult

```typescript
interface MeleeSlotResult extends ActionResult {
  /** The slot used, 10 or 12; null when no slot fits, or `keepOnTie` left the hand alone (success). */
  slot: number | null;
}
```

### SkillUseResult

```typescript
interface SkillUseResult extends ActionResult {
  name: string;
  messages: GameMessage[];
}
```

### FindKillableOptions

```typescript
interface FindKillableOptions {
  /** NPC name filter. */
  pattern?: NamePattern;
  /** Max npc.level - player.level. */
  maxLevelDiff?: number;
  /** Min npc.level - player.level. */
  minLevelDiff?: number;
  /** Con range (-3 grey .. 3 purple; default -2 green .. 0 yellow; grey gives no XP). */
  minCon?: number;
  maxCon?: number;
  /** Max 2D distance from `from` (default 2500). */
  radius?: number;
  /** Measure radius from here (default: the player). */
  from?: Point;
  /** Object ids to skip. */
  exclude?: Iterable<number>;
  /** Also return NPCs already fighting someone else (default false). */
  includeEngaged?: boolean;
}
```

### LootOptions

```typescript
interface LootOptions {
  /** 2D search radius (default 500). */
  radius?: number;
  /** Overall deadline (default 20000 ms). */
  timeout?: number;
  /** Wait this long first so autoloot can finish (default 800 ms). */
  settleMs?: number;
}
```

### LootResult

```typescript
interface LootResult extends ActionResult {
  picked: string[];
  skipped: { name: string; reason: string }[];
  itemsGained: InventoryItem[];
  moneyGained: number;
  messages: GameMessage[];
}
```

### RestOptions

```typescript
interface RestOptions {
  /** Stand when health reaches this (default 90). */
  healthPercent?: number;
  manaPercent?: number;
  endurancePercent?: number;
  /** Not done until our window pet's health reaches this as well, also with our own health full, as a shade's stays. Ignored with no pet, or none in view. It regains whether we sit or not. Live: after a fight its first real tick comes in anything up to about 37 s, the last in-combat one being 30 s off (GameLiving.cs:2448), then about 10 % per 6 s for most pets, in whole points; the top Necromancer's servant about 0.2 % a second, a low one more, and a Regenerate line heals about 6 % per 3 s for 12 s. */
  petHealthPercent?: number;
  timeout?: number;
}
```

### RestResult

```typescript
interface RestResult extends ActionResult {
  healthPercent: number;
  manaPercent: number;
  endurancePercent: number;
  durationMs: number;
}
```

### RespawnResult

```typescript
interface RespawnResult extends ActionResult {
  position: Vec3 | null;
  regionId: number | null;
}
```

### ItemResult

```typescript
interface ItemResult extends ActionResult {
  item: InventoryItem | null;
  messages: GameMessage[];
}
```

### MerchantDelveResult

```typescript
interface MerchantDelveResult extends Omit<DelveResult, 'item'> {
  item: MerchantItem | null;
}
```

### DelveResult

```typescript
interface DelveResult extends ActionResult {
  item: InventoryItem | null;
  /** The delve window as the server sent it, blank lines included. Empty unless it answered. */
  lines: string[];
  bonuses: ItemBonus[];
  /** Lines that are neither a bonus nor known layout: spell text, descriptions, new formats. */
  unknown: string[];
  /** "Bonus Level: N". Nothing enforces it. */
  bonusLevel: number | null;
  /** "Level Requirement: N Level". It gates the item's spells, not its bonuses. */
  levelRequirement: number | null;
}
```

### MerchantResult

```typescript
interface MerchantResult extends ActionResult {
  merchant: NearbyNpc | null;
  items: MerchantItem[];
}
```

### BuyResult

```typescript
interface BuyResult extends ActionResult {
  item: MerchantItem | null;
  /** Units that arrived in the backpack. */
  count: number;
  spent: number;
  itemsGained: InventoryItem[];
}
```

### SellResult

```typescript
interface SellResult extends ActionResult {
  item: InventoryItem | null;
  earned: number;
}
```

### SellItemsResult

```typescript
interface SellItemsResult extends ActionResult {
  sold: InventoryItem[];
  failed: { item: InventoryItem; reason: string }[];
  earned: number;
}
```

### TrainResult

```typescript
interface TrainResult extends ActionResult {
  /** The line as the skill list names it, whichever of its names was asked for. */
  spec: string | null;
  fromLevel: number;
  toLevel: number;
  specPointsLeft: number;
}
```

### TrainBuildResult

```typescript
interface TrainBuildResult extends ActionResult {
  /** The build's name; null when there is none. */
  build: string | null;
  /** Every line this call raised, by KeyName, also when a later one failed. */
  trained: { spec: string; fromLevel: number; toLevel: number }[];
  /** The line the points are banked for, when that is what stopped the training. */
  waiting: { spec: string; cost: number; points: number } | null;
  /** Nothing left to raise at this level. */
  done: boolean;
  /** Lines with points spent beyond the current target, by KeyName. Only a respec gets those back. */
  over: { spec: string; level: number; target: number }[];
  specPointsLeft: number;
}
```

### RespecResult

```typescript
interface RespecResult extends ActionResult {
  /** What player.specPoints rose by. */
  regained: number;
  specPointsLeft: number;
  /** Every line as it stands now, as the skill list names it. */
  specs: { name: string; level: number }[];
}
```

### TravelResult

```typescript
interface TravelResult extends WalkResult {
  spawn: NpcSpawnMatch | null;
}
```

### UseZonePointOptions

```typescript
interface UseZonePointOptions {
  /** Walk to the source when farther than this (default 200). */
  tolerance?: number;
  /** How long to watch for the jump after the request, ms (default 20000). */
  timeout?: number;
}
```

### ZonePointResult

```typescript
interface ZonePointResult extends ActionResult {
  /** The zone point used; null when the id names none. */
  zonePoint: ZonePoint | null;
  /** Where we stand now. */
  regionId: number | null;
  position: Vec3 | null;
  /** Server messages since the request. */
  messages: string[];
}
```

### ChatResult

```typescript
interface ChatResult extends ActionResult {
  /** Our own echo was seen ("You say, ..."). */
  echoed: boolean;
}
```

### GroupResult

```typescript
interface GroupResult extends ActionResult {
  group: GroupMember[];
}
```

### TradeOfferOptions

```typescript
interface TradeOfferOptions {
  /** Backpack items, at most 10. A stack always goes whole. */
  give?: Array<InventoryItem | NamePattern | number>;
  /** TOTAL copper our side should show, not an increment. */
  money?: number;
  /** Approach distance (default 100). The server allows 128 in 3D. */
  range?: number;
  /** The whole call (default 30000 ms). Seeing a failure's window close can take up to 2 s more. */
  timeout?: number;
}
```

### TradeOptions

TradeOfferOptions (give, money, range, timeout) plus the judge of each offer.

```typescript
interface TradeOptions extends TradeOfferOptions {
  /** Judge each new offer before accepting it; false means "not yet". A partner's change can cross our accept in flight, so this is no safeguard against strangers. */
  accept?: (window: TradeWindow) => boolean;
}
```

### AcceptTradeOptions

```typescript
interface AcceptTradeOptions {
  /** Only this partner's window; anyone else's is closed while waiting. Default: whoever opens one. */
  from?: PlayerTarget;
  accept?: (window: TradeWindow) => boolean;
  /** The whole call (default 30000 ms). */
  timeout?: number;
}
```

### TradeOfferResult

```typescript
interface TradeOfferResult extends ActionResult {
  partner: NearbyPlayer | null;
  trade: TradeWindow | null;
  /** The server's refusal of an add, and the item it was for (null for money). */
  refused: { item: InventoryItem | null; message: string } | null;
  messages: GameMessage[];
}
```

### TradeResult

```typescript
interface TradeResult extends ActionResult {
  partner: string | null;
  /** As they were in our backpack. */
  gave: InventoryItem[];
  /** Real slots of ours, ready for equipItem. */
  received: InventoryItem[];
  /** Offered, completed, not found in our backpack (reason 'item_missing'). */
  missing: InventoryItem[];
  /** Copper. */
  moneyGiven: number;
  /** Copper. */
  moneyReceived: number;
  refused: { item: InventoryItem | null; message: string } | null;
  messages: GameMessage[];
}
```

### FollowOptions

```typescript
interface FollowOptions {
  /** Keep within this 2D distance (default 150). */
  distance?: number;
  /** Stop after this long (default 60000 ms). */
  durationMs?: number;
  /** Stop (successfully) when this returns true. */
  until?: (state: BotWorldState) => boolean;
}
```

### FollowResult

```typescript
interface FollowResult extends ActionResult {
  durationMs: number;
  target: NearbyPlayer | null;
}
```

### GrindPetOptions

How grind fights with a pet.

```typescript
interface GrindPetOptions {
  /** The summon (default: the best main or turret one, see summonPet). It must give a pet the window lists. A charm here is reason not_supported, before any cast: grind can't choose its mob, so charm first (charmPet) and pass pet: true. So is a fire-and-forget pet, a bomber or a minion: orders don't reach them, so cast those with summonPet per target, or per spot for an Animist's. So is a known spell that is no summon at all, with its type in the message. A spell that can't be found is reason spell_not_found, up front too, with a pet up or not. A turret needs its ground target set first (sdk.sendSetGroundTarget): with none set, the first try ends the run with reason no_ground_target. */
  spell?: NamePattern | Spell;
  /** 'pet' (default): the pet fights and we stand off (petKill). A new pet's threat can take long to take a mob off us, so while a mob on us is within 250, and we have a melee weapon and aren't a shade, we swing as well (killNpc, which orders the pet); one farther off the pet has, until it gets there. There is no health floor in either: a caller that wants one watches from outside. It is the pet's fight in both, so a passive pet is lifted to defensive first, as an order lifts one. 'both': we fight too (killNpc, which orders the pet, and leaves a passive one out of it). With nothing to swing it reads as 'pet': in shade (ClassDisciple.cs:91), and with no melee weapon in slots 10 or 12 (a shield, a left-hand weapon alone and a bow are none), as the server refuses melee with a bow in hand (PlayerAttackRequestHandler.cs:12-18). A summon with a cast time goes with a mob on us only while that is farther off than it can swing from by the cast's half way (220 units/s, faster if it reads so, and 250 more, about 910 for 6 s); nearer, we go to melee as it arrives, not walking out while it runs at us, and with nothing to swing it goes anyway, as the cast is all there is: until it can, the fight waits, with no failure. A Necromancer's goes that way too, weapon or not: melee is no answer for it. A mob our own hit pulled counts as on us for this, by a fight of ours or our hit in the last 10 s, while it closes with no target reading. With no mob on us a wait for a summon of 6 s or less, and any "You must wait N seconds", is waited out rather than spent on a pull; a long recast still pulls under 'both'. */
  fight?: 'pet' | 'both';
  /** Summon again after a loss or a respawn (default true). With no main or turret spell to do it with, a lost pet ends the run at once with reason not_supported, a mob on us or not, in a melee pass of ours too; false fights on in melee, and with no melee weapon ends the run at once: stopReason 'error', reason no_pet, and the message says what is on us. */
  resummon?: boolean;
  /** Between fights, with no mob on us or the pet, no pull while our pet is below this: rest instead, up to restToPetHealth (default 50; 0 never, and no rest waits for it). Its health only: a shade's own stays full, so nothing else protects a Necromancer, whose servant's death is its own. A refused rest is a wait. Adds aren't covered: a mob on the pet is fought before any rest, however low the pet is. A rest in progress at the end of a run goes on in the next grind of this script, for the same pet, and the message says so: `; resting our pet (42 %, to 90 %)`. A new script knows nothing of it: it goes by the gate. A run that stops for lack of time before the gate is looked at says `; our pet at 18 %`. */
  restBelowPetHealth?: number;
  /** How far a rest takes our pet, however long it takes, once restBelowPetHealth has called for one and on any rest of ours for our own health or mana (default 90; never less than restBelowPetHealth). Most pets are there in a minute. The top Necromancer's servant regains about 0.2 % a second, a low one more, so this can take minutes; a Regenerate line heals about 6 % per 3 s for 12 s. releasePet then summonPet has a fresh one in about 20 s, at the cost of our own health falling to the pet's percent (PlayerState.isShade): grind doesn't do that by itself, because it is the caller's to weigh. */
  restToPetHealth?: number;
}
```

### GrindOptions

```typescript
interface GrindOptions {
  pattern?: NamePattern;
  maxLevelDiff?: number;
  minLevelDiff?: number;
  minCon?: number;
  maxCon?: number;
  /** Hunt within this 2D distance of the anchor (default 2000). */
  radius?: number;
  /** Centre of the hunting area (default: where grind starts). */
  anchor?: Point;
  /** Rest when health falls below this between fights (default 50), up to restToHealth. */
  restBelowHealth?: number;
  /** Rest until this health (default 90; never less than restBelowHealth). */
  restToHealth?: number;
  /** Also rest below this mana percent (casters). */
  restBelowMana?: number;
  /** Total run time (default 180000 ms). No new target is pulled once less than `minEngageMs` remains, and a fight still going at the deadline is given up at most 30 s after it, so a run overshoots by at most about 30 s, or 40 s with a mob below 5 % then. A pet's fight has the same time, and so has a mob from a fight left unfinished by a lost pet or a mob on us (GrindOptions.pet). A pet's fight still standing then is called off (passive, defensive, follow), and the message says so with both numbers, `called off at 17 % with giant wolf at 37 %`, as does GrindResult.calledOff; a pet on an enemy player is left to the caller, at the deadline. No order takes a mob off a pet, though: one still on it gets an answer at its next swing, and that fight goes on with nobody watching. */
  durationMs?: number;
  /** Do not pull a new target when less than this much of `durationMs` remains (default: the average kill time of this run, 15000 ms before the first kill, at most half of `durationMs`). Monsters already attacking us are still fought. */
  minEngageMs?: number;
  /** Stop after this many kills. A pet on another mob by then is called off and the message says so, as at the deadline (durationMs). */
  maxKills?: number;
  /** Pick up loot after each kill (default true). */
  loot?: boolean;
  /** Release and walk back after dying instead of stopping (default false). A death in the last fight is also released, so grind never returns dead with this set. */
  respawn?: boolean;
  styles?: string[];
  useStyle?: StyleChooser;
  /** Called after each kill; return false to stop, which treats a pet on another mob like maxKills does. `kill` has the whole fight's time, in durationMs and its message, as killLog does, when it took several goes; what it gained is from the last go, which is where a kill's rewards come. A death only seen as the go ran out is a kill too, with xpGained 0 if the XP hadn't come by then. */
  onKill?: (kill: KillResult, stats: GrindStats) => void | boolean | Promise<void | boolean>;
  /** One go at a mob (default 60000 ms). The time is only when grind looks: while the mob is wearing down the fight goes on, or in melee while it stays on us, up to 30 s past the deadline. A pet that got nowhere in this time is called off with petFollow, and the mob is left alone for 60 s. */
  killTimeout?: number;
  /** Stop with stopReason 'no_targets' after this long near the anchor without a single candidate (default 60000 ms; 0 or Infinity waits out the whole duration, e.g. for respawns). Typical cause: everything around the anchor cons grey after levelling. */
  noTargetTimeoutMs?: number;
  /** Fight with a pet: summon it before the first fight and again after a loss, and after a respawn before the walk back (it follows; a window turret, which doesn't, goes up at the anchor), and neither pull nor rest while it fights. Next comes, in this order: a mob on us; the pet's mob; a mob from a fight left unfinished by a lost pet or a mob on us, while it lives within 2500 of us, with a new pet ordered onto it; and only then a fresh one. Without a pet, a mob on us over 250 away gets a try at a summon first, as does one nearer by for a summon with no cast time, or when we have nothing to swing, and mobs on us are fought in melee until it is back: a melee pass lasts until the summon's timer is up, at least 3 s, and the fight goes on from there. A turret is given only what it reaches, one that stays out of that in the fight is let go after about 2 s, and a mob on us beyond that is fought in melee. A mob a lost pet engaged turns on us (StandardMobBrain.cs:569), so one that is hurt, on us or was on the pet at the loss holds the run however short of time we are: it is the next target, and worth a new pet, until it dies, goes beyond 2500 or the overrun is up (durationMs). One the pet never reached has drawn nothing: with time short it holds nothing and gets no summon. If one still stands at the end the message says `; our pet died with X at 17 %, and it is coming for us` (in shade also `: we are at N % health`, unless it is beside us more than 3 s after the loss: our health is melee's by then), when it reads as on us or had the pet as its target at the loss; else `; we lost our pet on its way to X`. Beside us by then: `; our pet died with X at 90 %, and it is on us at 80 %`, the percent at the loss and now. A release or a tether's cut says `we lost our pet` in these. Nothing is said while a new pet has it. A run ended by our own death says `; our pet died first, with X at 84 %`. GrindResult.lastPetLoss has that mob in all of these. Stops with stopReason 'error' when summoning keeps failing with time left. Past the deadline a try that fails ends the run as 'duration', and so does the last one when short of time. In the overrun a recast it can't outlast isn't waited for, unless the mob had the pet as its target. A pet a window doesn't list can't be used here (reason not_supported, see GrindPetOptions.spell). A run that ends with no pet says why: while a recast holds the summon `; waiting on Hunter's Pet (10s)`, short of power `; no pet: short of power for X (it can cost 26, and we have 9)`, and otherwise `; could not summon: <the last line>`. Short of power it rests to the most the summon can cost and 5 points, at most 60 %. A run in shade is this with `true`, from the pass that sees the shade and with or without the option: a shade fights through its servant alone (ClassDisciple.cs:91), and its own full health says nothing of it. */
  pet?: boolean | GrindPetOptions;
}
```

### GrindResult

```typescript
interface GrindResult extends ActionResult {
  kills: number;
  /** Fights that failed, and each pet lost, once however many passes hear of it, between passes too; not the owner's death, nor a pet that went with a region change. */
  failures: number;
  deaths: number;
  xpGained: number;
  rpGained: number;
  moneyGained: number;
  levelsGained: number;
  durationMs: number;
  /** 'no_targets': nothing in the con window around the anchor for `noTargetTimeoutMs`. 'error': `reason` says what stopped it, not_supported among them. */
  stopReason: 'duration' | 'maxKills' | 'died' | 'onKill' | 'no_targets' | 'error';
  /** Each kill's durationMs covers its whole fight, across a lost pet, a mob that came between or a go that ran out of killTimeout. */
  killLog: { name: string; level: number; xp: number; durationMs: number }[];
  /** The last window pet this run lost, absent when it lost none. `mob` is what it was fighting then, with its health at that moment, if that fight still stands at the end: alive and within 2500 of us, after our own death too. Null otherwise. That mob comes for us (StandardMobBrain.cs:569), and with no script running nothing answers it, so a caller should look here before it stops. */
  lastPetLoss?: PetLoss & { mob: { objectId: number; name: string; healthPercent: number } | null };
  /** The fight grind called our pet off at the end of the run, absent when there was none: the mob and both healths as they stood, so a caller can heal, or release while a shade's cut is still the pet's percent. Null for a pet out of view. That doesn't end the fight (GrindOptions.durationMs), and the run can read as a success with its pet about to die. */
  calledOff?: { mob: { objectId: number; name: string; healthPercent: number }; petHealthPercent: number | null };
  /** The mob on us as a run ended for its time, with its health as it stood, absent with none: the overrun is over, nothing answers it now, and our swing may still be on. The message says so too, unless its note on the lost pet has said it. */
  stillFighting?: { objectId: number; name: string; healthPercent: number };
}
```
