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
| `async walkToObject(target: ObjectTarget, options: WalkToObjectOptions = {}): Promise<WalkToObjectResult>` | Walk until within `range` (3D) of an NPC, player or object; follows a target that moves. |
| `async followPath(waypoints: Point[], options: Omit<WalkOptions, 'z' \| 'pathProvider'> = {}): Promise<WalkResult>` | Walk through waypoints in order (one continuous move). |
| `async stop(): Promise<ActionResult>` | Stop moving; observed when the mover reports it is idle. |
| `async face(target: Exclude<ObjectTarget, number> \| Point \| number \| { objectId: number }): Promise<FaceResult>` | Turn to a raw heading (a number, 0..4095), toward a point, or toward an object (NPC/player/object, name pattern, or `{ objectId }`). A bare number is always a heading: object ids are small per-region integers (Region.cs:886) that overlap it. |
| `async follow(player: PlayerTarget, options: FollowOptions = {}): Promise<FollowResult>` | Follow a player client-side (OpenDAoC has no /follow or /stick; the retail client does it locally): keep within `distance` until `until`, the duration ends, or the player is lost for 5 s. |

### Combat

| Signature | Description |
|---|---|
| `async target(target: ObjectTarget \| null): Promise<TargetResult>` | Select a target (NPC, player, object, or our own objectId) and observe it in player.targetObjectId. |
| `async attack(target: LivingTarget, options: { timeout?: number } = {}): Promise<AttackResult>` | Approach, target, face and switch melee on against an NPC or a player (enemy players are named by race: pass the objectId); observed via attack mode or a swing. Reason 'immune' (with retryAfterMs) when PvP immunity, ours or the target's, refuses the swing, and 'crowd_controlled' (with retryAfterMs) when we are mezzed or stunned. |
| `async killNpc(target: NpcTarget, options: KillOptions = {}): Promise<KillResult>` | Fight an NPC to the death: walk into melee range (adopting its z), face, target, attack, re-approach when it moves, use styles, and wait for the death (remove packet / 0 HP). Reports XP, RP, money, items and duration. Reason 'crowd_controlled' (with retryAfterMs) when a mezz or stun refuses our swing. |
| `async killPlayer(target: PlayerTarget, options: KillPlayerOptions = {}): Promise<KillPlayerResult>` | Fight an enemy player to the death, like killNpc: walk into melee range (adopting its z), face, target, attack, chase while it moves (players are not extrapolated: we follow the latest position) and use styles. Enemy players are named by race, so pass the objectId (or the NearbyPlayer); a name is only a fallback. Success on its death: the death event or isDead, never 0 % health, which is truncated (GameLiving.cs:2621): a living player with a few hit points reads 0 %. Reasons: 'not_found', 'already_dead', 'not_attackable' (our realm), 'immune' (PvP immunity, ours or its; retryAfterMs), 'crowd_controlled' (we are mezzed or stunned; retryAfterMs), 'target_lost' (left view alive: stealth, range), 'out_of_reach' (beyond maxChaseDistance), 'refused', 'died', 'timeout'. Does not wait for XP after the kill: rpGained counts the realm points that arrived by then. |
| `async castSpell(spell: NamePattern \| Spell, target?: ObjectTarget \| null, options: CastOptions = {}): Promise<CastResult>` | Cast a spell (name, RegExp or Spell) on a target, or on the current target when none is given. Selects the target every time (the server drops it on death without telling the client) and re-selects and retries once on "You must select a target" while that target is still there (CastOptions.retryNoTarget). Observes the cast start ("You begin casting", cast animation) and completion ("You cast a <spell> spell!", or an effect/damage/resist once the cast time is up). Reason 'died' when we die mid-cast; 'dead' when already dead before casting; 'crowd_controlled' (with retryAfterMs) when we are mezzed, stunned or silenced. A cast whose target is immune to its effect succeeds with effectImmune. |
| `async useStyle(name: NamePattern): Promise<SkillUseResult>` | Queue a combat style for the next swing; observed by "You prepare to perform a ...". |
| `findKillableNpc(options: FindKillableOptions = {}): NearbyNpc \| null` | Best monster to fight nearby: killable, not engaged with someone else, within the con (or level-difference) window, nearest first. |
| `findKillableNpcs(options: FindKillableOptions = {}): NearbyNpc[]` | All candidates findKillableNpc considers, best first. |
| `getAttackers(): NearbyNpc[]` | NPCs fighting us, nearest first: their reported target is us, or their swing or spell landed on us within the last 6 s. The server reports a target only for a mob standing within its attack range and in attack state, so the hits are what shows a caster at range or a mob running at us. |
| `getPlayerAttackers(windowMs: number = PLAYER_AIM_MS): NearbyPlayer[]` | Enemy-realm players whose melee swing or spell effect landed on us within `windowMs` (default 6 s, longer than a two-handed weapon's or a bow's swing), nearest first. The server never sends a player's target, so these combat events are the evidence. |

### Other

| Signature | Description |
|---|---|
| `async interactWith(target: ObjectTarget, options: InteractOptions = {}): Promise<InteractResult>` | Walk within ~150 of an NPC/object and interact (right-click). Success needs a response: merchant/trainer window, NPC dialog, dialog box, text window or a message from the NPC. |
| `async acceptResurrection(options: { timeout?: number } = {}): Promise<AcceptResurrectionResult>` | Wait for a resurrection offer, say yes and observe the revive. We come back standing at the caster, with the spell's health and power (10 % and none for a baseline rez). That saves the release's XP loss, grave and constitution loss; resurrection illness comes all the same. Reasons: not_in_game, not_dead, timeout (no offer came), expired (the offer was gone when we answered). |
| `async useAbility(name: NamePattern): Promise<SkillUseResult>` | Use an ability (e.g. Sprint); success when the server answers without a refusal or an effect appears. |
| `isInCombat(): boolean` | In combat: attack mode on, recently hit, an NPC is fighting us (getAttackers) or an enemy player hit us (getPlayerAttackers). |
| `resurrectSpell(): Spell \| null` | Our strongest resurrection spell, or null. The higher its level, the more it restores: 10 %, then 30, 50 and 100 % on a spec line. |
| `async resurrect(target: PlayerTarget, options: ResurrectOptions = {}): Promise<ResurrectResult>` | Resurrect a dead player of our realm: walk into range, cast, and wait for its answer. Success means it is alive again: a finished cast only asks, and a corpse no script controls never answers (the power is gone then). It comes back at our feet. It must be in view. Costs half our full power at equal level (resurrectCost), paid when the cast ends. Reasons: those of castSpell, plus spell_not_found, not_found, invalid_target, not_dead (alive, or released meanwhile), no_power, already_considering (someone else's rez waits for its answer), no_answer. |
| `getSpellInfo(spell: NamePattern \| Spell): SpellInfo \| null` | Static data for a known spell (type, target, range, cast time, power), from the DB dump; null when unknown. |
| `isDead(): boolean` | Our character is dead. |
| `freeBackpackSlots(): number` | Free backpack slots (of 40). |
| `async repairAll(smith: NpcTarget, options: { maxCost?: number } = {}): Promise<RepairResult>` | Have a smith repair everything at once: worn, backpack and vault, whatever its type, and 20 % over the single prices (Blacksmith.cs:14, :219-228). The only way to repair an instrument. Success with cost 0 means nothing needed it. Reasons as repairItem. |
| `findNpcSpawn(pattern: NamePattern, options: { regionId?: number; guild?: NamePattern } = {}): NpcSpawnMatch \| null` | Nearest static spawn (DB `mob` table) in our region matching a name, or null. |
| `async travelTo(destination: NamePattern \| (Point & { regionId?: number }), options: WalkOptions = {}): Promise<TravelResult>` | Walk (same region, through walkTo: navmesh route when built, else a straight line) to a named spawn from static data or to a point. |
| `async useZonePoint(target: number \| ZonePoint, options: UseZonePointOptions = {}): Promise<ZonePointResult>` | Use a zone point, by its id or as static data (getZonePointsFrom): walk to its source when farther than `tolerance`, send 0x90 and watch for the jump. Reasons: 'not_found' (no such id), 'wrong_region', 'wrong_realm', 'refused' (a server message said so), 'timeout' (no jump and no word: the server ignores a request it won't take, RegionChangeRequestHandler.cs:41-45), 'dead', and the walk's own ('stuck', 'died', ...). The server checks no distance (the handler reads only the id), so the walk is ours: a real client asks when it steps on the zone point, and a walk that stopped within 400 still asks. The realm is the zone point's in the DB, as for a PrivLevel-1 account (:33-37), and an id with a row per realm means our realm's row. The one other rule (:28, Trials of Atlantis regions go by the zone's realm) has no zone point in the dump. |
| `async say(text: string): Promise<ChatResult>` | Say text (chunked) and observe our echo. Spaces calls SAY_SPACING_MS apart: the server drops a say < 500 ms after the last accepted one with "Slow down! Think before you say each word!" (commands/playercommands/say.cs:49-53); that answer retries once, then fails with 'rate_limited'. |
| `async send(to: string, text: string): Promise<ChatResult>` | Private message a player ('/send'); fails on "not online"-style answers. |
| `async grind(options: GrindOptions = {}): Promise<GrindResult>` | Hunt around an anchor: pick a killable target (attackers first), kill, loot, rest when low, walk back when drifted. Stops on death unless `respawn` is set, and with stopReason 'no_targets' after `noTargetTimeoutMs` (default 60 s) without any candidate. |

### NPC Dialog & UI

| Signature | Description |
|---|---|
| `async talkTo(npc: NpcTarget, options: InteractOptions = {}): Promise<DialogResult>` | Interact with an NPC and return its dialog text and [keywords]. |
| `async whisper(npc: NpcTarget, keyword: string, options: { timeout?: number } = {}): Promise<DialogResult>` | Whisper a [keyword] to an NPC (targets it first) and observe its reply: new dialog text, a message from the NPC, a window, or an item. Spaces whispers 1.6 s apart (NPCs ignore faster ones) and resends once after the server's "Slow down!". |
| `async navigateDialog(npc: NpcTarget, keywords: (string \| RegExp)[], options: { timeout?: number } = {}): Promise<DialogResult>` | Talk to an NPC, then whisper each keyword in turn. A RegExp picks the first matching [keyword] from the current dialog. |
| `async respondToDialog(accept: boolean, options: { timeout?: number } = {}): Promise<RespondDialogResult>` | Answer the open dialog box (group invite, quest offer, yes/no). Waits up to `timeout` for one to open. |

### Items & Equipment

| Signature | Description |
|---|---|
| `async lootNearby(options: LootOptions = {}): Promise<LootResult>` | Pick up loot on the ground within `radius` and report what changed in the backpack and purse (autoloot usually already took it during the kill). |
| `async equipItem(target: InventoryItem \| NamePattern \| number, options: { slot?: number } = {}): Promise<ItemResult>` | Equip a backpack item; the server picks its slot, or takes `options.slot` when given (a worn item there swaps into the backpack). Observed in state.equipment: with a slot, that slot must hold this item, so an equal-named item already worn elsewhere doesn't count. What it replaces lands in the backpack slot this one left, so only this very item still there means it didn't move. A swap with a piece that reads the same changes no reading, so a magical piece counts on the server's "The magic of X flows through you". A plain one has nothing that tells them apart and no message: `timeout`. |
| `async unequipItem(target: number \| NamePattern): Promise<ItemResult>` | Move an equipped item (by slot or name) back into the backpack. |
| `async dropItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Drop a backpack item on the ground. |
| `async destroyItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Destroy a backpack item. |
| `async useItem(target: InventoryItem \| NamePattern \| number, options: { useType?: number } = {}): Promise<ItemResult>` | Use (right-click) a backpack or equipped item: potions, charged items. A number is a backpack (40-79) or equipment (10-37) slot. Success needs evidence about this item: a message naming it ("You attempt to use <item>.", GamePlayer.cs:6564), its stack count changing, or a new effect, and no refusal in the following ~400 ms. |
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
| `async rest(options: RestOptions = {}): Promise<RestResult>` | Sit until health (and optionally mana/endurance) reach the thresholds, then stand. Fails if attacked. |
| `async releaseAndRespawn(options: { timeout?: number } = {}): Promise<RespawnResult>` | Release after death (retrying until the server allows it) and observe being alive at the bind point. |
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
| `async trainBuild(trainer: NpcTarget \| null, build?: Build): Promise<TrainBuildResult>` | Spend the points on a build, as far as they reach: the rule in data/builds/rule.ts names each line and trainSpec raises it, at a trainer of the class or, with `null`, where the character stands (trainSpec). Without `build` it is the bot's own `bots/<bot>/build.ts` (loadBuild in sdk/build.ts), and a broken file throws. Success means it stopped for a good reason: `done` (nothing to raise at this level) or `waiting` (the next line costs more than there is, and the points stay banked for it). `done` sends nothing. Before `waiting` with nothing raised it talks once to a trainer in reach, because a promotion sends no points and player.specPoints can still be the base class's number. A trainer out of reach or not found gets nothing, and the number stands. A base class trains the lines it has of its advanced class's build. Reasons: `no_build`, `invalid_build` (buildProblems of a build passed in), `wrong_class`, `not_in_game`, `too_many_steps`, and those of trainSpec. |
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
| `findSpell(pattern: NamePattern): Spell \| null` | Spell by name; pass its lineIndex/spellIndex to sendCastSpell. Highest level wins among equal names. |
| `findStyle(pattern: NamePattern): Style \| null` | Combat style by name; pass its skillIndex to sendUseSkill. |
| `findAbility(pattern: NamePattern): Ability \| null` | Ability by name; pass its skillIndex to sendUseSkill. |
| `getEffects(): Effect[]` | Active buffs/debuffs. |
| `findEffect(pattern: NamePattern): Effect \| null` | Active effect by name, or null. A string matches inside a name: Lesser Bark Skin passes for Bark Skin. |
| `getMerchant(): MerchantState \| null` | Open merchant window, or null when none is open. |
| `getTrainer(): TrainerState \| null` | Open trainer window, or null when none is open. |
| `getTrade(): TradeWindow \| null` | Open player trade window, or null when none is open. Its partnerItems carry the partner's slots, never ours. |
| `getDialog(): DialogBox \| null` | Open 0x81 dialog box (group invite, quest offer, yes/no), or null. Answer with sendRespondDialog. |
| `getResurrectionOffer(): ResurrectionOffer \| null` | The resurrection offer waiting for our answer, or null. Answer with bot.acceptResurrection or bot.respondToDialog. |
| `getNpcDialog(): NpcDialog \| null` | Last NPC dialogue with its [keywords]; answer with sendWhisper(npcObjectId, keyword). |
| `getTextWindow(): TextWindow \| null` | Last custom text window (0xC4), or null. |
| `getGroup(): GroupMember[]` | Group members (empty when not grouped). |

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
| `async sendSetGroundTarget(x: number, y: number, z: number): Promise<ActionResult>` | Set the ground target. In a zone where the server has a navmesh loaded it silently drops a target more than 16 units off the mesh (ground_target_snap_max_distance): take z from navmeshGroundZ. |
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
  /** Constitution lost to PvE deaths (from level 6); a town healer (GameHealer) restores it for money. */
  constitutionLost: number;
  encumbrance: { current: number; max: number } | null;
  isDead: boolean;
  isSitting: boolean;
  /** Melee auto-attack toggled on (server 0x74 AttackMode). */
  attacking: boolean;
  inCombat: boolean;
  targetObjectId: number | null;
  /** Server tick-independent counter incremented on each death. */
  deathCount: number;
  lastDeathAt: number | null;
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
  /** Object the NPC is attacking/targeting, if any. */
  targetObjectId: number | null;
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
  /** Current ground target, when set via setGroundTarget or the server (0xEC). */
  groundTarget?: Vec3 | null;
  /** Open player trade window; absent or null when closed. */
  trade?: TradeWindow | null;
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
  /** Stop chasing beyond this 2D distance from where the fight began (default 2500). */
  maxChaseDistance?: number;
  /** Allow NPCs isKillable() rejects (realm NPCs, peaceful flags) (default false). */
  force?: boolean;
}
```

### KillResult

```typescript
interface KillResult extends ActionResult {
  npc: NearbyNpc | null;
  killed: boolean;
  xpGained: number;
  rpGained: number;
  moneyGained: number;
  itemsGained: InventoryItem[];
  durationMs: number;
  levelsGained: number;
  stylesUsed: number;
  /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
  retryAfterMs?: number;
}
```

### KillPlayerOptions

killPlayer's options: KillOptions' timeout, styles, chase and maxChaseDistance, with a style chooser for players.

```typescript
interface KillPlayerOptions extends Omit<KillOptions, 'useStyle' | 'force'> {
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
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  castTimeMs: number | null;
  /** The server reported the cast finished ("You cast a <spell> spell!", or an effect, damage or resist once the cast time is up). */
  completed: boolean;
  resisted: boolean;
  /** The cast went off (success, power spent) but its effect did not land: "Your target is immune to this effect!" (CCSpellHandler.cs:173/288, SpellHandler.cs:571). A player already mezzed or stunned, or within the 60 s immunity that follows one (CrowdControlECSEffect.cs), an NPC's mezz immunity, a snare immunity. `resisted` stays false: the target did not resist, nothing could have landed. */
  effectImmune?: boolean;
  /** Damage from "You hit X for N damage!" / "Your <this spell> hits X for N damage!" lines that arrived once the cast time was up. Other spells' DoT ticks and "extra damage" lines are left out; a damage shield's "You hit X for N damage!" in the same moment cannot be told apart. */
  damage: number;
  messages: GameMessage[];
  /** For reason 'must_wait' / 'interrupted' / 'immune' / 'crowd_controlled': ms until casting is allowed again ("You must wait N seconds"). */
  retryAfterMs?: number;
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
  /** Rest when health falls below this between fights (default 50). */
  restBelowHealth?: number;
  /** Rest until this health (default 90). */
  restToHealth?: number;
  /** Also rest below this mana percent (casters). */
  restBelowMana?: number;
  /** Total run time (default 180000 ms). No new target is pulled once less than `minEngageMs` remains, and a fight still going at the deadline is given up at most 30 s after it, so a run overshoots by at most about 30 s. */
  durationMs?: number;
  /** Do not pull a new target when less than this much of `durationMs` remains (default: the average kill time of this run, 15000 ms before the first kill, at most half of `durationMs`). Monsters already attacking us are still fought. */
  minEngageMs?: number;
  maxKills?: number;
  /** Pick up loot after each kill (default true). */
  loot?: boolean;
  /** Release and walk back after dying instead of stopping (default false). A death in the last fight is also released, so grind never returns dead with this set. */
  respawn?: boolean;
  styles?: string[];
  useStyle?: StyleChooser;
  /** Called after each kill; return false to stop. */
  onKill?: (kill: KillResult, stats: GrindStats) => void | boolean | Promise<void | boolean>;
  killTimeout?: number;
  /** Stop with stopReason 'no_targets' after this long near the anchor without a single candidate (default 60000 ms; 0 or Infinity waits out the whole duration, e.g. for respawns). Typical cause: everything around the anchor cons grey after levelling. */
  noTargetTimeoutMs?: number;
}
```

### GrindResult

```typescript
interface GrindResult extends ActionResult {
  kills: number;
  failures: number;
  deaths: number;
  xpGained: number;
  rpGained: number;
  moneyGained: number;
  levelsGained: number;
  durationMs: number;
  /** 'no_targets': nothing in the con window around the anchor for `noTargetTimeoutMs`. */
  stopReason: 'duration' | 'maxKills' | 'died' | 'onKill' | 'no_targets' | 'error';
  killLog: { name: string; level: number; xp: number; durationMs: number }[];
}
```
