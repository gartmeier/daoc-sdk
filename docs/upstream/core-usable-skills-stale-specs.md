# Upstream PR draft: stale skill list after `/player class`

For [OpenDAoC/OpenDAoC-Core](https://github.com/OpenDAoC/OpenDAoC-Core). The fix is [core-usable-skills-stale-specs.patch](core-usable-skills-stale-specs.patch), branch `fix/usable-skills-stale-specs` in `server/core`. It is based on f0aaa1ea2 (tag 2026.09.36, our pin) and applies unchanged to upstream `master` a4dc4ed15, where `GamePlayerUtils.cs` hasn't changed since. Nothing is pushed or opened yet.

---

**Title:** `GamePlayerUtils.UpdateUsableSkills`: Replace entries whose instance changed

**Body:**

After a GM changes a player's class with `/player class`, the player's skill list keeps the specialization levels from before the change for the rest of the session. A later raise never shows in it either. The trainer window shows the right levels, and a relog fixes it.

### Cause

`SetClass` in `commands/gmcommands/player.cs` calls `RemoveAllSpecs`, `Reset` and `SetCharacterClass`, so the player gets new `Specialization` instances, then `SendUpdatePlayerSkills(true)`. That rebuilds the cached list in `GamePlayerUtils.UpdateUsableSkills`, whose local `UpdateAt` replaces an entry only when

```csharp
if (existing.Item1 != primary || existing.Item2 != secondary)
```

`Skill` overloads `==` and `!=` to compare IDs (`Skill.cs`, `Equals`), and the new instance has the same ID as the old one. So the old object stays in the list, and every skill list packet reads the levels of that orphaned instance. The trainer window (`PacketLib1105.SendTrainerWindow`) reads `player.GetSpecList()` and shows the live levels.

The ability entries keep the old `Specialization` as their second item in the same way.

A promotion at a trainer keeps the spec instances, so only `/player class` (and anything else that replaces spec instances in a session) is affected.

### Fix

Compare with `ReferenceEquals`, so the entry is replaced whenever the player holds a different instance. The slot and order logic is unchanged: entries are still matched by ID (specs, abilities, styles) or by spell line slot (spells). Only the decision to overwrite a matched slot changes. The list is copy-on-write in `GamePlayer.GetAllUsableSkills`, and nothing compares its entries by reference, so a replaced entry with the same content costs one tuple write.

### How to reproduce

1. As a GM, log in a level 1 Viking (or any base class).
2. Target yourself, `/player class Warrior`, then `/player level 24`.
3. Train Hammer to 24 and Parry to 16.
4. The Specializations list still shows Hammer 1 and Parry 1, and so does every 0x16 skill list. The trainer window shows Hammer 24 and Parry 16. Shield is right, because it is new to the Warrior.

It also works the other way: on a trained character, `/player class` puts every line back to 1, but the list keeps showing the trained levels.

### Tested

Both directions on a local server built from 2026.09.36, with a headless client reading the 0x16 skill list and the 0x7B trainer window:

| | Skill list | Trainer window |
|---|---|---|
| Before, Viking → Warrior at 24, trained | Hammer 1, Parry 1, Shield 18 | Hammer 24, Parry 16, Shield 18 |
| After, same steps | Hammer 24, Parry 16, Shield 18 | Hammer 24, Parry 16, Shield 18 |
| After, `/player class Warrior` again | every line 1 | every line 1 |

---

## Our side

- `server/core` follows the `server/db` pattern (docs/SERVER.md): branch `daoc-sdk` merges every fix branch and adds a README notice ([core-daoc-sdk-readme-notice.patch](core-daoc-sdk-readme-notice.patch), GPLv3 5(a)). These branches exist only in this worktree's submodule so far.
- Still to do, the user's call: create the fork `gartmeier/OpenDAoC-Core`, push `daoc-sdk` and `fix/usable-skills-stale-specs`, point `.gitmodules` at the fork and the `server/core` pin at `daoc-sdk`, open the upstream PR from the fix branch, rebuild `daoc-sdk-gameserver:latest`.
- To recreate the branches from the patches: in `server/core`, `git switch -c fix/usable-skills-stale-specs f0aaa1ea2 && git am ../../docs/upstream/core-usable-skills-stale-specs.patch`, then `git switch -c daoc-sdk f0aaa1ea2 && git merge --no-ff fix/usable-skills-stale-specs && git am ../../docs/upstream/core-daoc-sdk-readme-notice.patch`.
- Once the server runs the fix, the SDK-side workaround (1ce87c8, `trainBuild`/`trainSpec` read the trainer window) can stay: it costs one window request. The relog advice in learnings/builds.md "What the server does" no longer applies then.
