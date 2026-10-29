# SDK API Reference

> Auto-generated from TypeScript source. Do not edit directly.
> Run `bun run docs:api` to regenerate or `bun run docs:api:check` to verify it.

## Execution model

- `bot.*` methods are high-level helpers. They observe evidence (position, HP, inventory, messages, dialogs) before reporting success. Inspect `success` and any `reason` or `message` on the result.
- `sdk.send*` methods are low-level dispatches. A successful `ActionResult` means the headless client accepted and dispatched the action (packets written); it does **not** prove that the DAoC server applied it.
- Methods whose signature returns `Promise<...>` are asynchronous and must be awaited. State reads (`get*`, `find*`) are synchronous reads of the last snapshot.
- Coordinates are DAoC global region coordinates: `x`/`y` on the ground plane, `z` is height. Headings are 0..4095 (0 = +Y, clockwise). Distances are world units (~191 units/s at full run speed).
- Backpack slots are 40-79, equipment slots 10-37 (`EquipmentSlot`). `getInventory()` lists occupied slots only: pass `item.slot`, never an array index.
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
| `async attack(npc: NpcTarget, options: { timeout?: number } = {}): Promise<AttackResult>` | Approach, target, face and switch melee on; observed via attack mode or a swing. |
| `async killNpc(target: NpcTarget, options: KillOptions = {}): Promise<KillResult>` | Fight an NPC to the death: walk into melee range (adopting its z), face, target, attack, re-approach when it moves, use styles, and wait for the death (remove packet / 0 HP). Reports XP, RP, money, items and duration. |
| `async castSpell(spell: NamePattern \| Spell, target?: ObjectTarget \| null, options: CastOptions = {}): Promise<CastResult>` | Cast a spell (name, RegExp or Spell) on a target, or on the current target when none is given. Selects the target every time (the server drops it on death without telling the client) and re-selects and retries once on "You must select a target". Observes the cast start ("You begin casting", cast animation) and completion ("You cast a <spell> spell!", or an effect/damage/resist once the cast time is up). Reason 'died' when we die mid-cast; 'dead' when already dead before casting. |
| `async useStyle(name: NamePattern): Promise<SkillUseResult>` | Queue a combat style for the next swing; observed by "You prepare to perform a ...". |
| `findKillableNpc(options: FindKillableOptions = {}): NearbyNpc \| null` | Best monster to fight nearby: killable, not engaged with someone else, within the con (or level-difference) window, nearest first. |
| `findKillableNpcs(options: FindKillableOptions = {}): NearbyNpc[]` | All candidates findKillableNpc considers, best first. |
| `getAttackers(): NearbyNpc[]` | NPCs currently targeting us, nearest first. |

### Other

| Signature | Description |
|---|---|
| `async interactWith(target: ObjectTarget, options: InteractOptions = {}): Promise<InteractResult>` | Walk within ~150 of an NPC/object and interact (right-click). Success needs a response: merchant/trainer window, NPC dialog, dialog box, text window or a message from the NPC. |
| `async useAbility(name: NamePattern): Promise<SkillUseResult>` | Use an ability (e.g. Sprint); success when the server answers without a refusal or an effect appears. |
| `isInCombat(): boolean` | In combat: attack mode on, recently hit, or an NPC targets us. |
| `getSpellInfo(spell: NamePattern \| Spell): SpellInfo \| null` | Static data for a known spell (type, target, range, cast time, power), from the DB dump; null when unknown. |
| `isDead(): boolean` | Our character is dead. |
| `freeBackpackSlots(): number` | Free backpack slots (of 40). |
| `findNpcSpawn(pattern: NamePattern, options: { regionId?: number; guild?: NamePattern } = {}): NpcSpawnMatch \| null` | Nearest static spawn (DB `mob` table) in our region matching a name, or null. |
| `async travelTo(destination: NamePattern \| (Point & { regionId?: number }), options: WalkOptions = {}): Promise<TravelResult>` | Walk (same region, through walkTo: navmesh route when built, else a straight line) to a named spawn from static data or to a point. |
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
| `async equipItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Equip a backpack item; the server picks its slot. Observed in state.equipment. |
| `async unequipItem(target: number \| NamePattern): Promise<ItemResult>` | Move an equipped item (by slot or name) back into the backpack. |
| `async dropItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Drop a backpack item on the ground. |
| `async destroyItem(target: InventoryItem \| NamePattern \| number): Promise<ItemResult>` | Destroy a backpack item. |
| `async useItem(target: InventoryItem \| NamePattern \| number, options: { useType?: number } = {}): Promise<ItemResult>` | Use (right-click) a backpack or equipped item: potions, charged items. A number is a backpack (40-79) or equipment (10-37) slot. Success needs evidence about this item: a message naming it ("You attempt to use <item>.", GamePlayer.cs:6564), its stack count changing, or a new effect, and no refusal in the following ~400 ms. |
| `findInventoryItem(pattern: NamePattern): InventoryItem \| null` | Backpack item by name (shortest match wins). |
| `async buyItem(merchant: NpcTarget, item: NamePattern \| { page: number; slot: number }, count: number = 1): Promise<BuyResult>` | Buy `count` of an item (name or page/slot) and observe the backpack and purse. |
| `async sellItem(merchant: NpcTarget, item: InventoryItem \| NamePattern \| number): Promise<SellResult>` | Sell one backpack item (whole stack) to a merchant and observe the purse. |
| `async sellItems(merchant: NpcTarget, filter: NamePattern \| ((item: InventoryItem) => boolean)): Promise<SellItemsResult>` | Sell every backpack item matching a predicate or name pattern. |

### Status & Recovery

| Signature | Description |
|---|---|
| `async rest(options: RestOptions = {}): Promise<RestResult>` | Sit until health (and optionally mana/endurance) reach the thresholds, then stand. Fails if attacked. |
| `async releaseAndRespawn(options: { timeout?: number } = {}): Promise<RespawnResult>` | Release after death (retrying until the server allows it) and observe being alive at the bind point. |

### Condition Waiting

| Signature | Description |
|---|---|
| `async waitForHealth(percent: number, timeout: number = 60_000): Promise<ActionResult>` | Wait (without sitting) until health reaches `percent`. |

### Merchants

| Signature | Description |
|---|---|
| `async openMerchant(merchant: NpcTarget): Promise<MerchantResult>` | Walk to a merchant and open its window; observed via state.merchant. |
| `async closeMerchant(): Promise<ActionResult>` | Close the merchant window (client-side state). |

### Training

| Signature | Description |
|---|---|
| `async trainSpec(trainer: NpcTarget, specName: NamePattern, levels: number = 1): Promise<TrainResult>` | Train a specialization at a trainer of our class: target it, open the trainer window (falling back to '/train'), and observe the spec level rise. |

### Group

| Signature | Description |
|---|---|
| `async groupSay(text: string): Promise<ChatResult>` | Group chat; fails with 'not_grouped' when the server says we are not in a group. |
| `async invite(player: string): Promise<ActionResult>` | Invite a player to our group ('/invite name'). |
| `async acceptGroupInvite(options: { timeout?: number } = {}): Promise<GroupResult>` | Wait for a group invite dialog, accept it and observe group membership. |

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
| `findNearbyPlayer(pattern: NamePattern, options: FindOptions = {}): NearbyPlayer \| null` | Nearby player by name (shortest name, then nearest). |
| `getNearbyObjects(): NearbyObject[]` | Nearby static objects, doors and loot. |
| `findNearbyObject(pattern: NamePattern, options: FindOptions & { loot?: boolean } = {}): NearbyObject \| null` | Nearby object by name (shortest name, then nearest). |
| `getNearbyLoot(): NearbyObject[]` | Loot on the ground, nearest first. |
| `getObject(objectId: number): NearbyNpc \| NearbyPlayer \| NearbyObject \| null` | Any nearby NPC, player or object by object id. |
| `getTarget(): NearbyNpc \| NearbyPlayer \| NearbyObject \| null` | Our current target (player.targetObjectId) when it is nearby. |
| `getSkills(): SkillsState` | Specializations, abilities, styles and spells. |
| `findSpecialization(pattern: NamePattern): Specialization \| null` | Specialization by name (shortest name wins). |
| `findSpell(pattern: NamePattern): Spell \| null` | Spell by name; pass its lineIndex/spellIndex to sendCastSpell. Highest level wins among equal names. |
| `findStyle(pattern: NamePattern): Style \| null` | Combat style by name; pass its skillIndex to sendUseSkill. |
| `findAbility(pattern: NamePattern): Ability \| null` | Ability by name; pass its skillIndex to sendUseSkill. |
| `getEffects(): Effect[]` | Active buffs/debuffs. |
| `findEffect(pattern: NamePattern): Effect \| null` | Active effect by name, or null. |
| `getMerchant(): MerchantState \| null` | Open merchant window, or null when none is open. |
| `getTrainer(): TrainerState \| null` | Open trainer window, or null when none is open. |
| `getDialog(): DialogBox \| null` | Open 0x81 dialog box (group invite, quest offer, yes/no), or null. Answer with sendRespondDialog. |
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
| `async sendDestroyItem(slot: number): Promise<ActionResult>` | Destroy an item. |
| `async sendBuy(page: number, slot: number, count: number = 1): Promise<ActionResult>` | Buy from the open merchant by page/slot (see getMerchant). |
| `async sendSell(slot: number): Promise<ActionResult>` | Sell a backpack item to the open merchant. |
| `async sendOpenTrainer(): Promise<ActionResult>` | Open the trainer window (stand near a trainer first). |
| `async sendTrainSpec(specIndex: number, levels?: number): Promise<ActionResult>` | Train a specialization (index from getTrainer().specs). |
| `async sendRespondDialog(accept: boolean): Promise<ActionResult>` | Answer the open dialog box (yes/accept or no/decline). |
| `async sendCloseMerchant(): Promise<ActionResult>` | Close the merchant window. |
| `async sendSay(text: string): Promise<ActionResult>` | Say one message (no chunking; see say()). |
| `async sendSend(to: string, text: string): Promise<ActionResult>` | Private message ('/send') one message to a player (no chunking; see send()). |
| `async sendGroupSay(text: string): Promise<ActionResult>` | Group chat. |
| `async sendCommand(command: string): Promise<ActionResult>` | Slash command sent verbatim, e.g. '&stick', '/bind' ('/' becomes '&'). |
| `async sendSit(sit: boolean = true): Promise<ActionResult>` | Sit (true) or stand (false). |
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
  /** Everything expressed in copper (1s = 100c, 1g = 100s, 1m = 1000g, 1p = 1000m). */
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
interface NearbyNpc {
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
interface NearbyPlayer {
  kind: 'player';
  sessionId: number;
  guildName: string;
  lastName: string;
  level: number;
  realm: Realm;
  healthPercent: number;
  isDead: boolean;
  isSitting: boolean;
  inCombat: boolean;
}
```

### NearbyObject

```typescript
interface NearbyObject {
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
}
```

### Specialization

```typescript
interface Specialization {
  name: string;
  level: number;
  internalId: number;
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
}
```

### Style

```typescript
interface Style {
  name: string;
  internalId: number;
  specLevel: number;
  specName: string | null;
  /** Index to pass to the useSkill action. */
  skillIndex: number;
  /** Raw prerequisite code from 0x16/01 (0x100 = none). */
  prerequisite: number;
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
  usable: boolean;
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
  /** Last 50 combat events, oldest first. */
  combatEvents: CombatEvent[];
  /** Concentration effects we maintain (server 0x75). */
  concentrationEffects?: ConcentrationEffect[];
  /** Current ground target, when set via setGroundTarget or the server (0xEC). */
  groundTarget?: Vec3 | null;
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

### WalkResult

```typescript
interface WalkResult {
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
  timeout?: number;
}
```

### WalkToObjectResult

```typescript
interface WalkToObjectResult {
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
}
```

### FaceResult

```typescript
interface FaceResult {
  heading: number;
}
```

### TargetResult

```typescript
interface TargetResult {
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
interface InteractResult {
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  response: InteractResponse | null;
  dialog: NpcDialog | null;
  /** Messages that arrived in response. */
  messages: GameMessage[];
}
```

### DialogResult

```typescript
interface DialogResult {
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
interface RespondDialogResult {
  dialog: DialogBox | null;
}
```

### AttackResult

```typescript
interface AttackResult {
  npc: NearbyNpc | null;
}
```

### KillOptions

```typescript
interface KillOptions {
  /** Give up after this long (default 60000 ms). */
  timeout?: number;
  /** Style names to rotate through, one per swing (endurance permitting). */
  styles?: string[];
  /** Pick the style per swing instead of rotating `styles`. */
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
interface KillResult {
  npc: NearbyNpc | null;
  killed: boolean;
  xpGained: number;
  rpGained: number;
  moneyGained: number;
  itemsGained: InventoryItem[];
  durationMs: number;
  levelsGained: number;
  stylesUsed: number;
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
}
```

### CastResult

```typescript
interface CastResult {
  spell: Spell | null;
  target: NearbyNpc | NearbyPlayer | NearbyObject | null;
  castTimeMs: number | null;
  /** The server reported the cast finished ("You cast a <spell> spell!", or an effect, damage or resist once the cast time is up). */
  completed: boolean;
  resisted: boolean;
  /** Damage from "You hit X for N damage!" / "Your <this spell> hits X for N damage!" lines that arrived once the cast time was up. Other spells' DoT ticks and "extra damage" lines are left out; a damage shield's "You hit X for N damage!" in the same moment cannot be told apart. */
  damage: number;
  messages: GameMessage[];
  /** For reason 'must_wait' / 'interrupted': ms until casting is allowed again ("You must wait N seconds"). */
  retryAfterMs?: number;
}
```

### SkillUseResult

```typescript
interface SkillUseResult {
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
interface LootResult {
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
interface RestResult {
  healthPercent: number;
  manaPercent: number;
  endurancePercent: number;
  durationMs: number;
}
```

### RespawnResult

```typescript
interface RespawnResult {
  position: Vec3 | null;
  regionId: number | null;
}
```

### ItemResult

```typescript
interface ItemResult {
  item: InventoryItem | null;
  messages: GameMessage[];
}
```

### MerchantResult

```typescript
interface MerchantResult {
  merchant: NearbyNpc | null;
  items: MerchantItem[];
}
```

### BuyResult

```typescript
interface BuyResult {
  item: MerchantItem | null;
  /** Units that arrived in the backpack. */
  count: number;
  spent: number;
  itemsGained: InventoryItem[];
}
```

### SellResult

```typescript
interface SellResult {
  item: InventoryItem | null;
  earned: number;
}
```

### SellItemsResult

```typescript
interface SellItemsResult {
  sold: InventoryItem[];
  failed: { item: InventoryItem; reason: string }[];
  earned: number;
}
```

### TrainResult

```typescript
interface TrainResult {
  spec: string | null;
  fromLevel: number;
  toLevel: number;
  specPointsLeft: number;
}
```

### TravelResult

```typescript
interface TravelResult {
  spawn: NpcSpawnMatch | null;
}
```

### ChatResult

```typescript
interface ChatResult {
  /** Our own echo was seen ("You say, ..."). */
  echoed: boolean;
}
```

### GroupResult

```typescript
interface GroupResult {
  group: GroupMember[];
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
interface FollowResult {
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
interface GrindResult {
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
