# Build

The user-facing layer is in place and works live: `create-bot.ts`, the template, and all five examples (grinder, merchant-run, caster, explorer, duo) ran against the local server. The MCP `execute_code` snippet in CLAUDE.md also ran end to end. `bunx tsc --noEmit` is clean and `docs:api:check` passes. I added no tests for my files, and nothing is committed.

One thing to fix first: `.gitignore` has `bots/*/` with only `!bots/_template/` excepted, so `bots/examples/` is gitignored. It needs a `!bots/examples/` line; `.gitignore` isn't mine, so I left it.

## Files (all under `C:/Users/joshu/Code/daoc-sdk/`)
- **`bots/create-bot.ts`**: `[name] [--realm] [--class] [--race] [--gender] [--char=Name] [--server=host:port] [--gateway=ws://..] [--no-chat] [--list] [--help]`.
  - The name must be 12 or fewer letters and digits; `_template` and `examples` are reserved; with no name it picks a random 9-character one.
  - `CHAR_NAME` comes from the client's own `defaultCharName` (`ux1` → `Uxb`).
  - Class and race are checked with `validateCharacter`. It also refuses characters that would spawn at 0,0,0 (Inconnu Acolyte, Saracen Disciple).
  - Defaults: Albion Fighter/Briton, Midgard Viking/Norseman, Hibernia Guardian/Celt. The realm is inferred when the class name exists in only one realm, and a class given for the wrong realm gets a hint naming the right one.
  - It writes a random password, `GENDER`, `SERVER` and `GATEWAY_URL` into `bot.env`.
- **`bots/_template/`**: `bot.env`, `lab_log.md`, `script.ts`. The script prints state, walks 300 units out and back, and kills one easy mob. If no mob is in view, it first walks to the nearest easy spawn point from the DB data, then loots and rests.
- **`bots/examples/`**:
  - `grinder.ts <bot> [seconds] [pattern]`
  - `merchant-run.ts <bot> [pattern]`
  - `caster.ts <bot> [pattern]`
  - `explorer.ts <bot> [radius] [points]`
  - `duo.ts <leader> <follower> [kills]`, which opens a second `BotSDK` control connection for the follower.
- **Docs:** `README.md`, `CLAUDE.md`, `AGENTS.md` (points to CLAUDE.md), and ten files in `learnings/`: README, walking, combat, spells, npc-dialog, merchants, looting, death-and-rest, classes-and-races, regions-and-zones.

## Verified live
- **create-bot:** every error path, plus creating bots in Albion and Hibernia (female, no chat), and Mage and Elementalist bots. Every bot's account and character were then created on first login.
- **Template:**
  - **Fighter (`ux1`):** walked out and back, killed a spirit hound for 16 xp and 2c.
  - **Elementalist (`uxmage2`):** used the new spawn-walk path (3421 units to the skeleton camp) and killed a spirit hound there.
- **`grinder.ts ux1 90`:** 5 kills, +84 xp, level 1 → 2, 0 deaths, 2 drops.
- **`merchant-run.ts ux1`:** walked 2900 units and sold both drops for 2c.
- **`caster.ts uxmage1`:** walked 3906 units to a skeleton, landed one cast for 2 damage, was interrupted twice, finished in melee for +35 xp, then rested.
- **`explorer.ts ux1 600 5`:** all 5 legs arrived; it reported NPCs by role, static spawns and zone exits.
- **`duo.ts ux1 ux2 2`:** the follower walked over, the invite was accepted, and both kills split xp and loot.
- **Probes for the learnings:** the Master Visur teleporter takes a level-1 character to Camelot (region 10) and back for free. I also captured the trainer and healer dialogs and checked that the offline merchant list matches the live window.
- **Quitting:** all four clients exited 0 within seconds after `sdk.sendQuit()`.

Not verified live: walking onto a zone exit, styles, promotion at a trainer, and whether `kill -INT` from Git Bash reaches a Windows bun runner (I used `sendQuit` instead).

## Gaps and decisions for you
- **LICENSE not written.** The README says the intent is GPL-3.0-or-later (OpenDAoC ships GPL-3.0; its file headers say v2 or later), with rs-sdk's MIT code being compatible. You should confirm the choice and add the file; `sdk/execution-context.ts` and `sdk/redact.ts`, copied verbatim from rs-sdk, also need its MIT notice.
- **No `.claude/` settings.** That would change permission configuration, so I left it for you.
- **No name-collision check.** `create-bot` doesn't check whether the character name is already taken on the server (`bot1` and `botb` both map to `Botb`). The client fails at creation instead; CLAUDE.md says to set `CHAR_NAME`.

## Bugs found in other modules
- **runScript final summary:** it is printed from the last snapshot, so right after `closeMerchant` it still shows "merchant open". The next snapshot is correct.
- **Back-to-back whispers:** a second `whisper` sent right after a sub-menu answer ("towns", then "Prydwen Keep") got no reply; sent alone it worked. It may be a rate limit, or `whisper` may be matching the previous answer.

Accounts I created (PrivLevel 1; passwords are in each bot's `bot.env`): `ux1`, `ux2` (Fighters), `uxmage1` (Mage), `uxmage2` (Elementalist). All were quit cleanly.

# Review

I fixed four bugs in the builder's files and added a regression test file. I also found two bugs in SDK files I don't own (`sdk/runner.ts`, `sdk/actions.ts`); both are confirmed live and documented, not fixed. Typecheck and `docs:api:check` are clean; `bun test ./bots` passes 6/6 and `./sdk` 124/124. Nothing is committed.

**Bugs fixed** (all under `C:/Users/joshu/Code/daoc-sdk/`)
1. **`bots/create-bot.ts:88` (`--flag value` form):** `bun bots/create-bot.ts --realm midgard` silently created an Albion bot named `midgard` (reproduced). Value flags now accept both `--realm=midgard` and `--realm midgard`. A value flag with no value is now an error instead of becoming the bot name.
2. **`bots/create-bot.ts:124` (name collisions):** create-bot now refuses a character name that another `bots/*/bot.env` already uses, case-insensitively (`bot1` and `botb` both map to `Botb`). It can't see names taken on the server by bots outside this checkout.
   - Also new: `parseArgs` is exported, the run is guarded by `import.meta.main` (line 220), and `DAOC_BOTS_DIR` (line 29) overrides the output folder for tests.
3. **`bots/examples/duo.ts:21-45` (leak that hung the process):** `connectBot` never closed the follower's socket when it failed. I reproduced that a connected `BotSDK` left open keeps bun alive (killed by `timeout` at 20 s).
   - It now disconnects on failure.
   - It also checks that the follower's client is live (the state tick must advance), because the gateway replays a dead client's last state.
4. **`bots/examples/caster.ts:48-104` (unproven kills):** it reported `killed` when the mob simply left view.
   - `killed` now requires the server's death event for that mob, or a confirmed melee kill.
   - The loop stops casting at a corpse.
   - It breaks on `spell_not_found` and `dead`; the old check used `not_found`, which is the target-not-found reason.
   - `xp` no longer goes wrong across a level-up.
5. **`bots/examples/merchant-run.ts:36`:** it now waits for a snapshot showing the merchant window closed, so the final summary no longer says "merchant open".

**Test added:** `bots/create-bot.test.ts`, 6 tests run as subprocesses in a temp folder. They cover the space-separated flag, empty values, realm inference, both collision cases, and the name and class errors.

**Docs corrected**
- `learnings/walking.md`: said cancelled scripts stop the mover; true for MCP cancel, false for a standalone `runScript` timeout. Now documented as a known bug with workarounds; the same bullet is in `CLAUDE.md` troubleshooting.
- `learnings/npc-dialog.md` and `CLAUDE.md`: the "back-to-back whisper" failure is the server's 500 ms whisper limit (`whisper.cs:39`). Docs now say to wait 600 ms between whispers.
- `CLAUDE.md` and `learnings/death-and-rest.md`: `kill -INT` from Git Bash does not reach a Windows bun runner, so background clients should be stopped with `sdk.sendQuit()`.
- `learnings/classes-and-races.md`: notes the new create-bot name check.
- I checked every API snippet in `learnings/`, `README.md` and `CLAUDE.md` by typechecking a scratch file: all compile. I also checked documented defaults and reasons, CLI flags, MCP parameters, runner log text and package scripts against the code; they match.

**Verified live** (new PrivLevel-1 accounts `uxra`, `uxrb` Fighters and `uxrm` Mage)
- **create-bot:** created all three bots, including the `--class Mage` space form. Accounts and characters were created on first login.
- **Template (`uxra`):** walked out and back, killed a hound for +16 xp and 2c.
- **`caster.ts uxrm` (fixed version):** walked 3906 units, one cast for 4 damage, two interrupts, melee finish, +35 xp, then rested.
- **`grinder.ts uxra 60`:** 7 kills, +118 xp, level 1 → 2, 0 deaths.
- **`merchant-run.ts uxra`:** sold the Focus Staff for 1c. This ran before fix 5; the fix itself is only typechecked.
- **`explorer.ts uxrb 500 4`:** completed and returned home.
- **`duo.ts uxra uxrb 2`:** grouped, 2 kills at 10 + 10 xp each.
- **duo failure path:** with follower `ux2`, which has no live client, it now errors and exits in 32 s instead of hanging.
- **Quitting:** all three clients exited 0 via `sendQuit`; no lockouts.

**Bugs in other modules (not fixed)**
- **`sdk/runner.ts`, abort and SIGINT paths:** it disconnects before the walk's cancel-time `sendStop` is transmitted, so the bot keeps walking.
  - Reproduced: a 3000-unit walk aborted after 3 s still arrived. With `disconnectAfter: false` the stop does arrive.
  - Suggested fix: after aborting, give the script promise up to about 2 s to settle before `sdk.disconnect()`.
- **`sdk/actions.ts`:**
  - `whisper` doesn't treat "Slow down! Think before you say each word!" as a refusal. It reports `no_response` after 4 s and should wait about 600 ms and retry, as `say`/`send` already do; `navigateDialog` can trip it.
  - `closeMerchant` only dispatches and doesn't wait for the window to close.
- **`.gitignore`:** still needs a `!bots/examples/` line.
- **`package.json`:** the `test` script doesn't include `./bots`.

**Remaining gaps:** the LICENSE file and the MIT notice for `sdk/execution-context.ts` and `sdk/redact.ts` are not written. Still unverified live: walking onto a zone exit, styles, and promotion at a trainer.