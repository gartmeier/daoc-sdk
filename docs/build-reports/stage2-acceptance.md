Acceptance run against the live server: every step passed. I fixed four bugs or doc mismatches and re-ran their checks live. One cleanup step is not done: the gateway on :7780 is still running, because the safety classifier refused my request to kill it.

## Results per step
| Step | Result | Evidence |
|---|---|---|
| `bun run server:setup --dry-run` | PASS | All 9 properties `ok`, "0 properties would change" |
| Gateway | PASS, not started by me | `curl localhost:7780/status` already answered. An orphan gateway from an earlier stage (pid 20956, started 10:35, parent gone) holds the port. `bun gateway/gateway.ts` fails with a clear EADDRINUSE. Killing pid 20956 was refused. |
| `bun bots/create-bot.ts acpt1` | PASS | Wrote `bot.env`, `script.ts`, `lab_log.md`. Also made `acpt2 --class Mage` (space-separated form) and `acpt3`. |
| `bun client/runner.ts acpt1` | PASS | Account and character Acptb created; log shows `in game (phase playing)` within 0.6 s |
| `bun sdk/cli.ts acpt1` | PASS | `In Game: true`, inventory, equipment, specs, about 100 NPCs |
| `bun bots/acpt1/script.ts` (template) | PASS | Walked out and back, killed a spirit hound: +16 xp, 3c |
| `grinder.ts acpt1 300` | PASS | 17 kills, 0 failures, 0 deaths, +453 xp, **level 1 → 3**, +52c. CLI afterwards shows L3, 469/850 xp. |
| `merchant-run.ts acpt1` | PASS | Sold 5/5 to Alburn Hale for 6c (55c → 61c); merchant window ends closed |
| `caster.ts acpt2` (Mage) | PASS after a fix | 1st run: one cast, then the bot died in melee too early. Fixed (item 4 below). 2nd run: 3 casts, 9 spell damage, melee finish, killed, +35 xp, rested. |
| MCP `execute_code` over stdio | PASS | My driver (`acpt/mcp-drive.ts`) spawned `bun run mcp/server.ts` and ran `initialize`, `tools/list` (`execute_code, disconnect_bot, list_bots`) and `execute_code` with `args`. Result `ok: true`, walk "Arrived", a mob found; the client was auto-started in about 1.4 s. `list_bots` showed the bot; `disconnect_bot` returned `stoppedClient: true, killed: false`; the server exited 0. |
| Viewer | PASS | `/viewer` and `/viewer/acpt1` return 200; `app.js` is 46 KB; `/zones/1` and `/state/acpt1` return 200. In the browser pane the map, NPCs, player panel, inventory and messages rendered with no console errors. |
| `bun run check` | PASS | Typecheck clean; 347 pass, 0 fail (was 337, plus `./bots` and the new tests) |
| `bun run docs:api:check` | PASS | Run after regenerating `sdk/API.md` |
| Cleanup | Runners PASS, gateway not stopped | acpt1 and acpt2 quit through `sdk.sendQuit()`: "quit acknowledged (0xA4)", exit 0. The server log shows `state:CharScreen` disconnects, no link-death. acpt3 was quit by MCP `disconnect_bot`. |

## Fixes made
1. **`sdk/runner.ts`: a standalone timeout or Ctrl+C no longer leaves the bot walking.**
   - The runner keeps the raw script promise and, after an abort, waits up to `SCRIPT_SETTLE_MS` (2000 ms) for it to settle before disconnecting. This applies to both the timeout path and the signal path.
   - New test file `sdk/test/runner.test.ts` (2 tests). The cleanup test fails with the wait removed.
   - Live: a 3000-unit walk with a 3 s timeout stopped 500 units out, status "stopped".
   - `CLAUDE.md` and `learnings/walking.md` no longer call this a known bug.
2. **`sdk/actions.ts` `whisper()`: NPCs were silently ignoring fast whispers.**
   - The real limit is in `GameLiving.WhisperReceive`: an NPC silently ignores any whisper within 1500 ms of the last one it accepted from that player. The "Slow down!" message is a separate 500 ms rule. So the old advice to wait 600 ms was wrong.
   - `whisper` now spaces its own whispers 1.6 s apart (`lastWhisperAt`, `WHISPER_SPACING_MS`). After "Slow down!" it resends once; a second refusal returns `rate_limited`.
   - 2 new tests in `sdk/test/actions.test.ts`.
   - Live: the old code sent `practice weapon` then `training shield` to Master Graent, and the second got no answer. With the fix both were answered, 1.65 s apart.
   - Updated the JSDoc and regenerated `sdk/API.md`. Rewrote the whisper notes in `CLAUDE.md` and `learnings/npc-dialog.md`.
3. **`.gitignore`:** added `!bots/examples/`. Before this, `bots/*/` ignored every example, so a fresh clone would have had none.
4. **`package.json`:** the `test` script now includes `./bots`, so the create-bot tests run in `check`.
5. **`bots/examples/caster.ts`:** `must_wait` (the cooldown right after an interrupt) no longer counts as a second interrupt. Before, it pushed the Mage into melee after one cast, and the bot died.

## Remaining issues
- **Orphan gateway still on :7780** (pid 20956). It started at 10:35, before the viewer review's `routes.ts` edits (10:40), so those route-level fixes aren't live in it. Someone needs to stop it by hand (Ctrl+C in its shell, or kill the pid).
- **CLI:** lists a nameless NPC as `-  L1 100% [peaceful] - 1364u (oid 11299)`. Cosmetic.
- **`closeMerchant`:** still only reports that the packet was sent, not that the window closed (`merchant-run.ts` works around it).
- **Whisper spacing:** only tracked inside one BotActions instance. A raw `sdk.sendWhisper` or another script whispering can still be dropped silently; this is documented.
- **Grinder end state:** after 5 minutes it stopped with HP 12/77 and "IN COMBAT", because `grind` doesn't rest after its last kill. The bot recovered on its own.
- **Not exercised:** `explorer.ts` and `duo.ts`.
- Test accounts created: acpt1 (L3 Fighter), acpt2 (Mage), acpt3 (Fighter), all PrivLevel 1.

Live-test scripts are in `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/acpt/`: `mcp-drive.ts`, `abort-walk.ts`, `whisper-live2.ts`, `quit.ts`. Nothing is committed.

Files changed:
- `C:/Users/joshu/Code/daoc-sdk/sdk/runner.ts`
- `C:/Users/joshu/Code/daoc-sdk/sdk/actions.ts`
- `C:/Users/joshu/Code/daoc-sdk/sdk/API.md`
- `C:/Users/joshu/Code/daoc-sdk/sdk/test/runner.test.ts` (new)
- `C:/Users/joshu/Code/daoc-sdk/sdk/test/actions.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/bots/examples/caster.ts`
- `C:/Users/joshu/Code/daoc-sdk/.gitignore`
- `C:/Users/joshu/Code/daoc-sdk/package.json`
- `C:/Users/joshu/Code/daoc-sdk/CLAUDE.md`
- `C:/Users/joshu/Code/daoc-sdk/learnings/walking.md`
- `C:/Users/joshu/Code/daoc-sdk/learnings/npc-dialog.md`