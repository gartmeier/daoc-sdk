# Combat

## Picking a target

```typescript
const mob = bot.findKillableNpc();                                   // nearest green..yellow monster within 2500
const hounds = bot.findKillableNpcs({ pattern: /spirit hound/, radius: 3000 });
const harder = bot.findKillableNpc({ minCon: 0, maxCon: 1 });        // yellow..orange
const byLevel = bot.findKillableNpc({ maxLevelDiff: 1, minLevelDiff: -1 });
```

- **Killable** means the NPC is attackable, has realm `'none'` (a monster, not a realm NPC), and its role isn't one of merchant, trainer, guard, healer, stablemaster, vault, teleporter or service. Roles are guessed from the name and guild text; check `npc.role`.
- **Engaged mobs are skipped:** ones already fighting someone else, and wounded ones not fighting us. `includeEngaged: true` keeps them.
- **Con levels** (`conLevel(playerLevel, npcLevel)`, a port of `ConLevelGrid.cs`): -3 grey (no XP), -2 green, -1 blue, 0 yellow, 1 orange, 2 red, 3 purple. `conColor(n)` gives the name. At level 1 a level-0 spirit hound is blue.
- `bot.getAttackers()` lists the NPCs targeting us, nearest first. Fight those first.

## killNpc

```typescript
const k = await bot.killNpc(mob);
// k.killed, k.xpGained, k.moneyGained, k.itemsGained, k.durationMs, k.levelsGained, k.reason
```

What it does:

1. Walks within 90 units (3D, adopting the mob's z).
2. Targets the mob, faces it, and turns auto-attack on.
3. Re-approaches when the mob moves beyond 118, and chases up to `maxChaseDistance` (2500) from where the fight began.
4. Finishes when the server reports the death ("The X dies!"). The XP, money and loot messages arrive within about 0.5 s afterwards.

| Reason | Meaning |
|---|---|
| `died` | we died; see [death-and-rest.md](death-and-rest.md) |
| `timeout` | over `timeout` (60 s); attack and chase are stopped |
| `target_lost` | the mob vanished above 20 % health |
| `out_of_reach` | it ran beyond `maxChaseDistance` |
| `not_attackable` | `isKillable` said no; `force: true` overrides |
| `refused` | the server refused the attack (message in `k.message`) |

`bot.attack(npc)` only starts melee: it approaches, targets, faces and swings, then returns. Use it when you want to manage the fight yourself.

## Grinding

```typescript
const g = await bot.grind({
    durationMs: 120_000, radius: 3000, respawn: true,
    restBelowHealth: 50, restToHealth: 95,
    onKill: (kill, stats) => console.log(stats.kills, kill.npc?.name, kill.xpGained),
});
// g.kills, g.deaths, g.failures, g.xpGained, g.moneyGained, g.levelsGained, g.stopReason, g.reason, g.message
```

Each pass of the loop:

1. Attackers come first.
2. Otherwise rest when low on health (or mana with `restBelowMana`).
3. Walk back when farther than `radius` from the anchor.
4. Kill the best killable target, then loot.

A mob that failed is avoided for 60 s. A death stops the grind unless `respawn: true`, which releases and walks back to the anchor. Deaths the server auto-released are counted too. `onKill` returning `false` stops the run. The ready-made script is `bots/examples/grinder.ts`.

- **`stopReason`:** `duration`, `maxKills`, `died`, `onKill`, `no_targets` or `error`.
- **Nothing to fight:** after `noTargetTimeoutMs` (default 60 s; `0` or `Infinity` turns it off) idle near the anchor with no candidate, grind stops with `no_targets`. Its message names the con window and your level. Resting resets the count. Widen `maxCon`/`radius`, or move to a better spawn (`findNpcSpawns`).
- **The last fight runs past `durationMs`:** grind finishes the kill it started, so a 120 s grind can take 140 s. A death in that last fight is counted (`stopReason: 'died'` without `respawn`), but with `respawn: true` the bot can be left dead when grind returns. Check `bot.isDead()` afterwards.

## Numbers from live runs (xp_rate 3)

- **Albion Fighter at Prydwen Keep (level 1–3):**
  - Spirit hounds (level 0) give 16–17 XP each at level 1 ("You get 17 experience points. (2 camp bonus)").
  - A kill takes 4–20 s plus the walk.
  - The hounds live about 2400 units from the start point (x≈576100, y≈528300, z≈2200).
  - 3-minute grind: 14 kills, level 1 → 3, 0 deaths.
  - 90-second grind: 5 kills, level 1 → 2. Drops seen: Fortifying Cloth Gloves, staff, Sturdy Cloth Pants, 2–3 copper per kill.
- **Grouped:** two level-1/2 Fighters share XP. Each got 10 instead of 16–17, and money was split ("Your share of the loot is 1 copper"). See `bots/examples/duo.ts`.
- **Wild sows (level 2), small bears (level 4) and large skeletons (level 5)** live farther from Prydwen. Look before you pick, with `bun bots/examples/explorer.ts <bot>`.

## Styles

- `bot.useStyle(name)` queues a style for the next swing and is confirmed by "You prepare to perform a ...".
- `killNpc(mob, { styles: ['Name1', 'Name2'] })` rotates styles, one per swing, every 2.5 s while endurance is at least 15 %.
- `useStyle: ({ npc, player, styles }) => name | null` chooses a style per swing instead.
- **Base classes have no styles; promotion brings them** (verified live):
  - Style rows are keyed by class (`style.ClassId`; SkillBase.cs:600-625, Specialization.cs:374-381). `getStylesFor(14)` (Fighter), `getStylesFor(35)` (Viking) and `getStylesFor(52)` (Guardian) are empty; Armsman (2) has 84.
  - Training a weapon spec on a base class unlocks nothing: a Fighter trained Slash 1 → 2 and still had 0 styles at level 4.
  - After promotion at level 5 the styles of the new class appear in `sdk.getSkills().styles`. An Armsman with Slash 2 has Ruby Slash, and `killNpc(mob, { styles: ['Ruby Slash'] })` killed a snake with 4 styles used ("You perform your Ruby Slash perfectly!").
  - The promotion steps are in [npc-dialog.md](npc-dialog.md#promotion).

## Gotchas

- **Melee range is 128 in 3D,** plus 32 for each side that is moving. A wrong z breaks melee; `killNpc` adopts the mob's z, but raw `sdk.sendAttack` doesn't.
- **Facing:** a swing needs the target within a 120° arc in front of you. `killNpc` re-faces automatically. `bot.face(n)` with a bare number always turns to heading `n`; face an object by passing the object, a name pattern or `{ objectId }`.
- **"IN COMBAT"** in the state summary right after a kill is normal. The server's in-combat flag lingers for a few seconds.
- **Guards and other realm NPCs are never killable targets:** `isKillable` rejects any NPC whose realm isn't `'none'`. `force: true` skips that check, but the server still decides whether the attack is allowed.
