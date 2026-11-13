# Bot looks: guilds, emblems, dyes, hats

[bot-looks.sql](bot-looks.sql) dresses the bots like players in guilds, and [bot-looks-undo.sql](bot-looks-undo.sql) takes it all back. Both come from [bot-looks.gen.ts](bot-looks.gen.ts), which reads the live DB (read-only; `--looks` prints who wears what). They replace the earlier `docs/bot-dyes.*`.

**Run it only while the gameserver is stopped**: the server caches guilds, item templates and logged-in inventories. Run the pair that was generated together, because the guild ids are fixed when the file is generated. On 2026-11-13 the pair was checked on a scratch copy of the tables (forward, then undo, then a byte-for-byte compare) and left the game DB untouched.

## Guilds

Nine guilds, three per realm, named from the "Server and guild naming" session (2026-11-10). Each main unit has its own guild, the squads (`-s1..s4`) share a small third one, and the realm's bench is split between the two main guilds in turns. The first group's leader is rank 0 and everyone else rank 9. The ranks are copied from Crimson Order's.

| Guild | Unit | Emblem (logo, pattern, colours) | Body / sleeves / gloves / helm |
|---|---|---|---|
| The Copper Knights | camelot | knight's helm (58), 1, rust + orange | dark brown / rust / dark brown / rust |
| Knights of the Ninth Hour | camelot-2 | crossed torches (29), 2, dark red + yellow | black / crimson / black / black |
| Order of the Brass Lion | camelot squads | lion rampant (74), 0, red + yellow | crimson / dark gold / dark gold / crimson |
| Einherjar | midgard | horned helm (61), 1, blue + gray | charcoal / gray blue / charcoal / charcoal |
| Iron Ravens | midgard-2 | raven's head (36), 2, gray + ivory | black / light gray / black / light gray |
| Mimirs Well | midgard squads | Odin's eye (27), 0, teal + blue | dark teal / gray blue / dark teal / dark teal |
| Silver Hand | hibernia | hands and heart (77), 1, dark green + ivory | forest green / light gray / light gray / forest green |
| Fianna | hibernia-2 | stag (39), 2, olive + dark khaki | olive green / tan / dark brown / olive green |
| The Cauldron | hibernia squads | cauldron (45), 0, purple + orange | black / dark purple / black / dark purple |

- **Emblem:** the value is `(logo << 9) | (pattern << 7) | (primary << 3) | secondary`, from `EmblemDialogReponseHandler`. Primary is one of 16 dark colours and secondary one of 8 light ones, from the client's `gamedata.mpk/patterns.csv` (sets 1 and 2; the bit widths match). The logos are `insignia/<b|n|h>_emblem_NNN.dds`: b Albion, n Midgard, h Hibernia, 84 each. I picked them from contact sheets of those textures.
  - Not yet checked in a real client: whether logo N is file N rather than N+1, and which colour goes on the background and which on the symbol.
- **Where it shows:** members' cloaks and shields carry the emblem. The packet sends the emblem in place of the cloak's dye (`PacketLib1104`), so the dye pair goes on the rest of the armour.
- **Not perfectly matched:** about 20 % of members leave the helm undyed and about 15 % the boots.
- **Old guilds:** the three guilds `groups/signature.ts` formed on 2026-11-04 (Crimson Order, Ravens of Jordheim, Wolves of Tir na Nog) are left in the DB with no members. The starter guilds keep their test characters.

## Everyone else

PrivLevel-1 characters in no bot guild get two colours that go together, from a list of about 30 pairs (black and gold, royal blue and light gold, forest green and tan, ...). One colour is on the cloak and the other on the body, and the choice comes from the name.

## Headgear and robes

The helm and torso models come from the item template, so the file adds per-class variants of the `t24_<class>_21/25` templates gear-template made, and points each character's item at its variant. The variants are `t24_<class>_21_hat`, `_crown` and `t24_<class>_25_robe`.
- **Casters:** pointed steeple hats (60 %) or a crown/circlet (40 %). The models are 1278/1280/1279 for the hats and 1294/1291/1298 for the crowns (Albion/Midgard/Hibernia).
- **Healers** (Cleric, Healer, Shaman, Druid): a crown or circlet (70 %).
- **Everyone else** keeps the full helm.
- **Robes:** Midgard casters get the dress robe (97). Albion and Hibernia casters already wore robe 378.

## Niamh

Niamh is in Silver Hand. She wears all black, with the robe she already had (378), a black steeple hat (1279), light gray gloves (the guild's silver hand) and the guild emblem on the cloak: hands and heart, dark green and ivory.

## Later gear stays plain

Items moved through the vault or gear-care keep their colour, emblem and template. New items come plain: loot, merchant buys, and the items a fresh `gear-template.ts` run creates (`/item create t24_*`, Color 0, no emblem, the full helm). After such a run, run the generator again, with the server stopped.
