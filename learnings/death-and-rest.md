# Resting, death and quitting

## Resting

```typescript
const r = await bot.rest({ healthPercent: 90 });                 // casters: add manaPercent: 80
// r.healthPercent, r.manaPercent, r.durationMs, r.reason ('attacked' | 'in_combat' | 'timeout' | 'died')
```

- **Sitting:** `rest` sits, and waits for the server's "You sit down." (a refused sit fails). It stands up again when the thresholds are reached, on failure, and on cancel.
- **Live:** health went from 89 % to 100 % in 18 s at level 1. (DAoC regenerates faster sitting; standing rates were not measured.) A level-5 Blademaster from 16-34 % took about 96-160 s including its walks, and about 80 s at level 6. `rest` stops at 120 s by default, so size a script's timeout for that.
- **Attacked while sitting:** a mob attacking you while you sit ends the rest with `attacked`. Fight it (`bot.getAttackers()[0]`), then rest again. `rest` refuses to start while an NPC in view targets you or hit you in the last 6 s (`in_combat`).
- **No sitting:** `bot.waitForHealth(percent)` waits without sitting.
- **Healers** (Brother Maynard <Healer>, near the Albion start) answer interact. In DAoC they remove constitution loss after deaths; untested here.

## Death

You know you died when `bot.isDead()` / `player.isDead` is true. `player.deathCount` also goes up.

- **Running actions fail with `died`:** `walkTo`, `killNpc` and `grind` stop.
- **The server says** "You will now release automatically in 8 more seconds!" after a death. It may release you before you do.
- **Waiting for a rez instead:** see Resurrection below; once you release there is no way back.
- **Release yourself:**
  ```typescript
  if (bot.isDead()) {
      const rel = await bot.releaseAndRespawn();   // retries /release until allowed; waits for the bind point
      console.log(rel.message, rel.regionId, rel.position);
  }
  ```
  After a release you are at your **bind point**, alive with low health. Rest before fighting again.
- **Grinding:** `grind({ respawn: true })` releases, walks back to the anchor and carries on. With `respawn: false` (the default) it stops with `stopReason: 'died'`. Deaths the server auto-released are counted too.
- **Viewers:** a real client shows a player as dead from the state byte of its 0xA9 (0x14, SITTING|SWIMMING), and the server relays that byte as the player's client sent it. The client sends it while `player.isDead`. Without it a real client showed the corpse dying and vanishing over and over, with one 0xAE and no remove or create from the server; with it the corpse lies still (verified in a real 1.127 client). Moving, turning and jumping are refused while dead.
- **Nobody releases an idle corpse for you:** without a running script a dead bot lies there for the server's full release timer, 900 s.
- **Bind points:** `nearestBindpoint(regionId, x, y, realm)` from `data/index`. Binding elsewhere: `/bind` near a bind stone answers "You are now bound to this location." (verified live at Ardagh).
- **Graves:** a death that costs XP leaves a gravestone holding that XP. At the level's XP floor there is nothing to lose, so no grave (`GamePlayer.cs:1645-1653`). Experience never took a Warden below level 15's floor, over 4 deaths at that level.
- **Praying** gets a grave's XP back. There is no `bot.*` method yet:
  ```typescript
  const grave = sdk.getNearbyObjects().find(o => /grave/i.test(o.name));
  if (grave) {
      await sdk.sendSetTarget(grave.objectId);
      await sdk.sendCommand('/pray');
  }
  ```
  It needs your own grave targeted, within 2000 units, standing still and not riding (`GamePlayer.Pray`), so a grave in a camp can be reached from outside it. You sit for 5 s, then the grave's XP comes back and it's gone. Live at level 15: 19,800 and 41,400 XP from 2 graves.
- **Unverified:** the XP and constitution loss penalties at low level.

## Resurrection

```typescript
// The rezzer: walks into range (1500), casts for 4 s, waits for the answer
const r = await bot.resurrect(corpse.objectId);    // r.reason: no_power, not_dead, already_considering, no_answer, ...
// The corpse: waits for an offer, says yes, sees the revive
const a = await bot.acceptResurrection({ timeout: 60_000 });
sdk.getResurrectionOffer();                        // { caster, healthPercent } while a question is open
```

- **Live (2026-11-03, level 15):** about 6 s from the cast to the target standing at the caster's feet, however far off the corpse lay. Back with the spell's health, 0 power and 1-2 % endurance for a baseline rez (hp 9-10 %). `deathCount` stays the same.
- **It must be held for:** a release sets full health, so a rez is refused on the living ("This spell only works on dead members of your realm!"). Nothing releases by itself for 900 s, unless a `/release` under 10 s after the death armed the automatic one, and that isn't stopped by an open question (`GamePlayer.cs:1450`). So decide to wait before the first release: `bot.releaseAndRespawn()` after a death starts that.
- **What a release gives instead:** full health, power and endurance at the bind point (`GamePlayer.cs:1668-1670`). Death strips buffs either way, and the illness comes either way. In RvR there's no XP or constitution at stake, so a rez only saves the walk back: learnings/rvr.md.
- **What it saves:** the release's second XP stage, the grave and the constitution loss (live: a monster's kill, control released: 0 -> 1 lost; rezzed: none). The death's first XP stage is gone at death either way (`GamePlayer.cs:5970`).
- **What it costs the caster:** half its full power at equal level, whatever the spell's power column says: `resurrectCost(maxMana, casterLevel, targetLevel)`, at least a tenth, 75 % five levels up (`ResurrectSpellHandler.PowerCost`). Paid when the cast ends. A "no" refunds it (live: 83 -> 83); no answer doesn't (live: 83 -> 52, then it regenerated: 45 -> 83 sitting in 34 s).
- **Who has one:** recognise it by `bot.resurrectSpell()` or `info.type === 'Resurrect'` (target `Corpse`), never by name: Restore Spirit, Minor Reconstitution and Reconstitution are heals too. Baseline at level 10: Cleric, Friar, Healer, Shaman, Druid, Bard, Warden and their base classes, 10 % and no power. Spec lines give 30/10 (Rejuvenation or Mending 15, Regrowth 16), 50/25 (24), 100/50 (40), though Friar, Shaman, Bard and Warden stop at 30/10. Paladin (Chants 30) and Spiritmaster (Summoning 23) get 10 %. Mentalists have none.
- **Answer every question.** The server sends no close for it and it expires after 15 s ("Your resurrection spell has expired."), yet its callback stays. The next rez then fires that callback as a "no", after already naming its new caster: saying yes answers "No one is currently trying to resurrect you." (reason `expired`) and that caster's power is gone (verified live). The rez after that works. So a corpse with no script running never comes back, and costs its rezzers power: `no_answer`.
- **After a rez:** 6 s of damage immunity (`RezDmgImmunityEffect`) and resurrection illness, 60 s, 30 s for a 100 % rez, none below level 6.
- **A GM's `/player kill` counts as RvR:** "RvR Resurrection Illness", no constitution at stake. Test what a rez saves with a monster's kill.
- **Unverified:** the rez clears neither of the death's pending-loss properties (`GamePlayer.cs:1647`, `:1699`), so a later release from a death without its own loss (RvR) might still apply them.
- **`resurrect` succeeds only when the target stands at the caster:** a release with the bind point in view shows the same alive player, and the caster's "not worth realm points" names nobody, so it can belong to another corpse's late yes.
- **Live check:** `sdk/test/live/rez-live.ts` (needs a GM account: its header says how, on a throwaway stack).

## Quitting and the 60 s lockout

- **Stopping cleanly:** a quit action. The runner sends `/quit`, waits for the character screen, then exits 0 within seconds (verified):
  - `await sdk.sendQuit()` from a script or MCP `execute_code`;
  - MCP `disconnect_bot`;
  - `bun client/dev/swarm-check.ts <bot> [<bot> ...] --seconds=0 --quit` from a shell (verified live; it also releases a dead character first);
  - Ctrl+C typed in the client's **own** console.
- **Signals from another process are not clean on Windows:** `process.kill(pid, 'SIGINT')`, `child.kill()`, `Stop-Process` and `taskkill` terminate bun outright (Node/Bun emulate signals on Windows with TerminateProcess), so the runner never sends `/quit` and you get the 60 s lockout below. Git Bash `kill -INT` doesn't reach bun at all (verified live). From a script:
  ```typescript
  await runScript(async ({ sdk }) => (await sdk.sendQuit()).message, { printState: false });
  ```
- **Quit timer:** with `disable_quit_timer` quit is instant out of combat. After recent combat the server still says "You will quit after sitting for 59 seconds", so give it a minute.
- **Lockout:** a socket that drops while you are in the world leaves the character **link-dead for 60 s**. Logins are refused meanwhile with 0x2C code 0x11 (`AccountIsInLogoutProcedure`). The runner waits 65 s and retries by itself. Just wait.
- **Quitting while dead:** `/quit` is refused while dead. `sdk.sendQuit()` releases first by itself (verified live: "quit: dead, releasing first", then exit 0).
- **Event loop:** a busy-wait loop that stalls the event loop for more than 5 s stops the heartbeat, and the server starts link-death recovery.
