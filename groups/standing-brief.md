# Standing brief: a living Thidranki (from 2026-11-14)

This brief replaces stints. It holds the goal, the scoreboard that shows whether we're getting there, the user's principles, and how work runs day to day. It changes when the user leaves a note; each note becomes a principle here. The last stint's record is `groups/stint-lives-on-its-own.md` (its morning report is at the top).

## Vision

Thidranki is alive on its own, filled with bots, with a natural life cycle. A human (for now only the user) can log in, join a group and enjoy it without being able to tell the bots from players. The plan doc is [Living Thidranki](https://claude.ai/artifact/SehSwg1Qwnin3upWutksXB).

The user's play is the real check. The main risk is optimising the scoreboard instead of how the world feels.

## Scoreboard

Each daily report shows these as a trend, day against night, per realm where that makes sense.

0. **Alive** (`bun scripts/alive.ts`), as today:
   - fights near each portal keep;
   - all sizes fighting per 10-minute window;
   - uneven fights;
   - living in the zone per realm;
   - the life cycle against its curve.
1. **Raid funnel.** For each raid, how far it got and when. The stages are:
   - got there (the stage);
   - entrance guards;
   - wall guards;
   - the yard;
   - the inside door;
   - up;
   - the lord.

   Per realm: the share of raids that reached each stage, and the median time from the go to each one. It shows at once where raids die (today: getting there at night, and rank 3). Muster calls that never reach "got there" count too.
2. **Back in action after a death or wipe:**
   - time until "together" (every living member near the group);
   - time until "ready" (together, spec buffs up, health and power up);
   - the count of fights started without spec buffs.

   Help calls belong here too: time from the call to arrival.
3. **More human:**
   - **Movement** against the user's recorded client: sharp turns, stop-start, zigzag. Ground truth is a recording of the real client (`client/dev/record-moves.ts`, learnings/walking.md), not reasoning about it.
   - **Group decisions**, scored per occurrence:
     - rez before release;
     - rebuff in a quiet spot after a wipe;
     - tanks don't chase a sprinting caster forever.

No skill levels yet: "the bots are not very pro" is fine for now.

Items 1-3 don't exist as measures yet. Building them is the first work under this brief: a reader of the logs and reports units already write, next to `scripts/alive.ts`, with tests.

## Principles (the user's calls)

- **Indistinguishable from players.** Anything a viewer can tell apart is a bug. Compare against the real client live (recorder, tcpdump), don't just reason about it.
- **Judge enemies as a human does:**
  - by `classGuess` (race, gear, spells, styles), never by roster or bot name;
  - groups will meet pickup groups with benched and rotating players.
- **Buffs before anything.**
  - Never leave the PK, a rest or a rez unbuffed.
  - At the PK the group buffs in one tight spot, back to back, starts the speed song and goes. It doesn't buff while walking in formation.
- **No idle waiting** with a human in the group. Rest only when health, power or buffs need it.
- **Kill everything.**
  - No kills left to the human.
  - A guard with aggro is fought.
- **Full force.**
  - After a half wipe: release, meet at the PK, buff, go back together.
  - Pick up strays.
- **Varied roaming:** enemy PK approaches, the Faste, recent sightings, not one ring.
- **Raids like a player group.**
  - Clear the outside, nuke the wall casters from outside, then everyone up together to the lord ("now is the time, everyone up").
  - No standing outside, no trickling in.
- **Every Hibernian line-up has a Druid and a Bard,** chosen by class.
- **Nobody needs to leave the battleground.** The portal keeps sell potions and poisons and have a healer.
- **Looks:**
  - two colours that suit each other, not realm palettes;
  - a guild per main group with its bench, emblem on the cloak;
  - casters in a tiara or wizard hat rather than a full helm.
- **Stealthers as the user played a Nightshade:** open while travelling, hidden on sighting someone or near a hotspot, mostly around the bridges.

## How work runs

- **Daytime:** short build-and-check loops on the live world: change one thing, see it live, keep or revert.
  - Unit-side code (`sdk/`) goes live at a unit's next sortie.
  - Director changes need a field mode restart (`touch groups/field.stop`), done between musters, never during one.
  - Client changes need a swarm restart while the user isn't in game.
- **Nights are soak tests, not fix sessions.** The world runs under the supervisor and nobody touches it. Fixes found at night wait as patches in `groups/notes/` until morning.
- **One short daily report:** the scoreboard trend, what changed, open doubts. The user reads it, plays when they like, and leaves notes.
- **The world keeps running** under the supervisor, with the machine awake, until the user says stop.

- **Watchers must not leak.** The machine is shared with the user's client. A Monitor or background shell shaped as `tail -F | grep | awk` leaves its processes alive on Windows after it ends: 1,579 of them, plus 1,403 conhosts, had filled 71 of 74 GB by 2026-11-14 09:08, when the user's client dropped. Watch with `bun scripts/watch.ts` (it ends with its shell or session, and at its timeout), or a poll whose commands end each round. `scripts/sweep-orphans.ts` under the extra supervisor ends what still leaks.

### Claude decides alone

- Code, tests and commits on local main.
- Restarts of field mode and the swarm when the user isn't in game.
- Wind-downs.
- Throwaway stacks.
- Tuning the life cycle and the director.

### Claude asks first

- Pushing, and upstream PRs.
- Wiping or recreating characters.
- Anything on the user's own characters (Niamh, the GM login).
- SQL against the shared world beyond what a reviewed script in `docs/` does (always with a backup, the gameserver stopped and the supervisor's server check paused).
- Growing past 60 bots.

**State at 12:26 on 2026-11-14 (the user: "stop it cleanly"):**
- The world is stopped. Field mode ended, all 39 online bots quit (39 clean disconnects in the server's log, no link deaths), and the swarm, gateway, lfg watcher and sweep ended.
- The gameserver and db containers stay up.
- To start again: `bun scripts/supervisor.ts groups/supervisor.json` and `bun scripts/supervisor.ts groups/supervisor-extra.json`, both in the background, plus the stay-awake script for an unattended run.

## Open now (from the 2026-11-14 morning report)

1. **The raid funnel measure** (scoreboard item 1), then S2's raid list:
   - does the outside ray (a17b8cf) kill wall casters in a daytime raid;
   - rank 3's wall Runemasters;
   - the lord fight.
   - Night raids are off since 68dee41 (no muster below a target of 12).
2. **Flaky tests under load:** two pet tests in `sdk/test/actions.test.ts` fail now and then in a full run with 60 bots on the machine and pass alone (member-turns fixed in 1171006).
3. **pack.ts:** the melee chases players behind the shut gate.
4. **Supervisor:** a pause for deliberate offline windows.
5. **Realm rank cap 255:** unproven until a bot reaches RealmLevel 10.
6. ~~Emblems and dyes~~: fixed and seen in the user's client (8fd3cda, applied 10:38 UTC; the client draws the symbol in black on the two colours).
7. **Not yet seen live (11-14 morning, from the user's play):**
   - the melee opener on a mezzed or stunned focus, with the stun queued again after a bladeturn (1a70ff4, 60537eb);
   - help calls only at 1.5 to 1 (8f72e0e);
   - a full group lets a fleeing solo go and skips sightings under 3 (686c77b, 70557fc);
   - the leader holds the called target for `/assist`, and pickups ask for buffs (1caff00, 7b3514b);
   - the life cycle's human guard (3a252e8: it held Niamh at 11:45).
8. **Starting stats the Optimize way** (7aa8f76) for new characters. 42 bots still carry the old split. Re-spending them needs a client packet and a log-out to the character screen; the user hasn't decided. Uncommitted client work for it sat in the tree at 11:5x, from the stats session.
9. **Watchers:** `scripts/watch.ts` for any log watch; the sweep (`groups/sweep-orphans.log`) under the extra supervisor. Check that log for counts that climb.
10. **The keep-awake script was stopped at about 10:30.** While the machine may sleep, the world doesn't count as running on its own.

Waiting on the user:
- pushing the local commits;
- the upstream PRs in `docs/upstream/`;
- archiving the stint's sessions;
- the old branches;
- whether bots are marked as bots;
- the 150-bot question.
