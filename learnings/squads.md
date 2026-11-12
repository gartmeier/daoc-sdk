# Small squads (solo, duo, trio)

A squad of 1 to 3 roams a battleground through the same coordinator as a group: `sdk/group/squad.ts` wraps the RvR
roaming decide (`rvr.ts decideRvr`) with three rules of its own. Tests: `sdk/group/squad.test.ts` (fixtures for each
rule, and 90 generated boards through solo, duo and trio). Built offline on 2026-11-11 for the night's phase 2 gate; the
live results go below as they come.

## Running one

- A squad is a folder like a group's: `groups/<squad>/group.json` (1 to 3 members, a leader) and `groups/<squad>/rvr.ts`,
  copied from `groups/_template/squad-rvr.ts`. Field mode starts it like any group: `bun groups/<squad>/rvr.ts Infinity [--flags]`.
- The nine folders for the night: `groups/{camelot,midgard,hibernia}-s{1,2,3}` (private, like every group folder). Their
  group.json starts with one bot each; field mode writes the line-up before each sortie (`lineup.ts writeLineup`).
- The folder's last number picks the lane it starts on (`squad-run.ts squadVariant`): s1 and s2 of one realm start on
  different enemies' sides. `--squad.variant=<n>` overrides it.
- The strategy alone: `squadRoaming`, or `squadStrategy({ friends, inner })` for friends to run to and a realm's own decide inside.

## The rules

**Picking fights** (`sizeUp`). Both sides' strength is the sum of each one's worth times how many they are (Lanchester's
square law), so two against one is four to one.
- Our worth comes from role, health and power.
- An enemy's worth comes from its role (`classGuess.role`, else the healer and caster flags, else a fighter), health and level. A mezzer counts 1.2 and a caster 1.1.
- A healer with others on its side makes them count 1.25 more.
- An enemy busy with a third realm counts 0.6.
- The squad takes a fight at a ratio of `squad.engageAt` (0.9) or better, and leaves one below `squad.leaveAt` (0.55). In between, a fight it is in goes on.
- One against one at full health is 1: taken. A solo at 60 % health against a fresh enemy is not taken.
- A stealther (Infiltrator, Nightshade, Shadowblade) out of combat counts 1.4 when starting a fight, not once in it. It is hidden then, and its opener does about 200 damage plus a stun or bleed (N5). So a hidden solo opens on a lone mezzer, but not on two.
- A patrol that passes a group it keeps clear of says so in its reason (`; clear of N at odds ...`). That came from N5's solo run (2026-11-11 21:00): Mordred skipped a waypoint near four Midgarders, and the log showed only the patrol.

**Leaving** (flee). A fight below leaveAt becomes a `retreat` order whose reason starts with `flee:`.
- Where it runs: toward friends of our realm within `squad.friendMax` (9000) unless the enemy stands that way, else toward our portal keep, else straight away.
- It ends:
  - once nobody against us has been within engageRadius for `squad.shakenMs`; those enemies are then left alone for `squad.avoidMs`;
  - at safety (within `friendReach` of friends, or `keepReach` of our portal keep), where it fights if they are still on it;
  - after `squad.fleeMaxMs` (45 s) still followed: caught, it fights it out (reason `caught:`).
- A lone melee on us (a stealther's opener) runs as fast as we do. It is fought out unless safety is within `squad.outrunMax` (5000).
- A focus below `retreat.focusHp` is finished first.

**Keeping clear.** Enemies the squad would not take are hidden from the inner decide (no hunt, no engage) unless they
attack it. Within `squad.sizeUp` (3500) it steps away (a `travel` order, reason `avoid:`).

**Roaming the edges** (`edgePatrol`, `squad.edge`). The loop runs from our road out to each enemy lane and back. A lane
is two points:
- the bank where we meet that realm (`BattlegroundLayout.pairs`);
- that realm's road to its portal keep, 55 % of the way from the meeting point. Their released players walk back alone there.

Every point is at least 6500 from the meeting point and dry. The loops in Thidranki, starting on our own road:
- Albion: (36686, 44253).
- Midgard: (44762, 27404).
- Hibernia: (24852, 24436).

**The inner decide never retreats.** Retreat is off for it (`retreat.enabled: false`), so `retreat.margin` and the size
shares (`size.ts`, floor 5) do nothing for a squad.

## For the ledger

- Fled: a fight with a `retreat` phase whose reason starts with `flee:`. Died while fleeing: a death during it.
- Caught: an `engage` whose reason starts with `caught:`.
- Kept clear: `travel` with `avoid:`.
- The decide's memory counts `squad.fled`, `squad.caught` and `squad.avoided` per run.

## Run B, first 19 minutes (2026-11-11 23:10-23:27), and the fixes (f7e66ef)

- **Bait.** A stray at the edge of a group counted as a lone enemy, because only enemies within `sizeUp` of us counted, plus those within `joinRadius` of them. Camelot's duo engaged a Kobold "1 vs 1" and fled 13 s later from six. Midgard's Hodur did the same against a Lurikeen with two behind it.
  - Fix: before a fight starts, each group of enemies within reach is judged whole (`enemyClusters`: any realm, linked through `joinRadius`, step by step).
- **Flip-flop.** A lone Hibernian caster stood at 3600 and a Midgard group of four at 3400. The orders flipped every second between hunting the caster and stepping away from the group, because the judged set changed with the distance.
  - Fix: groups are judged one by one. Once the squad steps away it keeps going until the group is 1000 beyond `sizeUp`, and a group judged too strong stays hidden for 10 s.
- **The far member.** Tuck (a Friar) alone took a Celt at "2 vs 1": Galahad was counted while walking back from the portal keep, 9000 off. Tuck died.
  - Fix: our side is the main body (`rvr.ts mainBody`).
- **The same duo three times.** Camelot's Tuck and Galahad lost to Hibernia's Niamh and Cuchulainn (Bard and Hero) three times in five minutes. The odds read about 1.15 each time; the Bard's mezz on the Friar decided it.
  - Fix: enemies near one of ours when it died count 1.5× for ten minutes when deciding to start a fight.
- **Solos on a healer.** Scathach and Diarmuid, solo, each held Kobold#469 at 38-40 % for minutes without a kill. Open.
