import type { ClassBuilds } from './types';

export default {
    className: 'Necromancer',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassNecromancer.cs:13). Every line trains as a Disciple; spec spells switch on at promotion (Specialization.cs:154). Servant spells take their damage range from the owner spec (SpellHandler.cs:2809-2813). Servants are baseline, at character level 1, 4, 7, 12, 20, 32, 45 (spelllines.json).',
    builds: [
        {
            name: 'Deathsight',
            role: 'Solo and farming pet caster: direct life damage and heavy debuffs through the servant.',
            why: 'The levelling rule from Eden gives both targets and spends every point: Deathsight at level until 48, then Servant to 24, then 6 Painworking. Uthgard also favours Deathsight for solo. The servant itself comes from the Death Servant baseline with character level, so it needs no spec. Reaches at 24: Deathsight 23 Pain of the Dead, Deathsight 22 Phantoms of Death, Deathsight 21 Gift of Power; at 50: Deathsight 48 Intimacy with Death, Deathsight 47 Scream of the Dead, Death Servant 24 Knives of Death.',
            order: 'A Disciple trains every line from the start, and spec spells switch on at promotion. Every point into Deathsight, at character level to 48: Puissance Vacuum at 12, Energy Vacuum at 18, Gift of Power at 21, Phantoms of Death at 22, Pain of the Dead at 23, Intimacy with Death at 48. From 40.5 the half levels are more than it can use, so they go to Death Servant, Death Servant 14 by level 45. After Deathsight stops everything does: Knives of Death at 24 by level 50, and the last 6 in Painworking at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Deathsight: 24 } },
                { level: 50, specs: { Deathsight: 48, 'Death Servant': 24, Painworking: 6 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=1724',
                    title: 'Necromancer (Eden forum)',
                    era: 'Eden, later than 1.65; excerpt',
                    says: 'Keep Deathsight at level, or one or two under, until 48; rest into Death Servant until 24; at 50 the rest in Painworking, 6.',
                    checked: 'WebFetch HTTP 403. Search excerpt 2026-11-03: Deathsight at level or 1-2 under until 48, rest into Death Servant until 24, Painworking 6 at 50.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=33495',
                    title: 'Necromancer Spec (Uthgard forum, 2014)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Deathsight for solo farming, Death Servant with a Cleric. No 48 Deathsight number here; that line is from a 2017 class-picking thread that could not be pinned.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: a 2014 thread, Deathsight for solo farming and Death Servant with a Cleric. It does not show 48 Deathsight.',
                },
            ],
        },
        {
            name: 'Sight and servant split',
            role: 'Group pet caster with a stronger servant and area damage, still with Deathsight debuffs.',
            why: 'A Eden player reports this split at level 50, and it fits the budget with 4 left for Painworking. Level 24 is fitted here on the same ratio. Reaches at 24: Deathsight 18 Energy Vacuum, Death Servant 13 Channeled Hatred, Death Servant 15 Instructing the Servant; at 50: Deathsight 39 Shriek of the Dead, Death Servant 37 Channeled Wrath, Death Servant 36 Disciplining the Servant.',
            order: 'A Disciple trains every line from the start, and spec spells switch on at promotion. Deathsight at character level to 18 for Energy Vacuum. Then Death Servant: Channeled Hatred at 13 by level 23, Instructing the Servant at 15 by level 24. Painworking 4 at 24. After 24 Death Servant again: Channeled Fury at 30 by level 36, Channeled Wrath at 37 by level 42. Deathsight waits at 18 until then and takes everything after: Lifeforce Vacuum at 25 by level 44, Shriek of the Dead at 39 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Deathsight: 18, 'Death Servant': 15, Painworking: 4 } },
                { level: 50, specs: { 'Death Servant': 37, Deathsight: 39, Painworking: 4 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=2236',
                    title: 'Please check Necro Damage Shield? (Eden forum)',
                    era: 'Eden, later than 1.65; excerpt',
                    says: 'A freshly levelled 50 at 39 Deathsight, 37 Death Servant.',
                    checked: 'WebFetch HTTP 403. Search excerpt 2026-11-03: fresh level 50 at 39 Deathsight, 37 Death Servant.',
                },
            ],
        },
        {
            name: 'Sight and pain',
            role: 'Pet caster with area damage over time, area debuff and snare.',
            why: 'Sources name a Deathsight main with Painworking off-spec, and say Painworking is taken for the area Str/Con debuff and snare, not its damage over time. They give no spec numbers in the excerpts, so the numbers are ours: the same split as the Sight and servant build. Reaches at 24: Deathsight 18 Energy Vacuum, Painworking 12 Exploding Death, Painworking 11 Shroud of Agony; at 50: Deathsight 39 Shriek of the Dead, Painworking 35 Heightening Death, Painworking 33 Shroud of Woe.',
            order: 'A Disciple trains every line from the start, and spec spells switch on at promotion. Deathsight at character level to 20 (Energy Vacuum at 18). Then Painworking: Vortex of Misery at 10 and Shroud of Agony at 11 by level 23, Exploding Death at 12 by level 24. Death Servant 4 at 24. After 24 Deathsight again, Deathsight 37 by level 40, Shriek of the Dead at 39 by level 41. Then Painworking: Heightening Death at 35 by level 49, Painworking 37 by level 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Deathsight: 20, Painworking: 12, 'Death Servant': 4 } },
                { level: 50, specs: { Deathsight: 39, Painworking: 37, 'Death Servant': 4 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=106&t=37332',
                    title: 'Necromancer Templates (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A template aimed at RvR, with Deathsight main and Painworking off-spec; numbers are for gear, not spec.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: Deathsight main with Painworking off-spec; numbers are for gear.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=1950',
                    title: 'Necromancer Painworking Spec (Eden forum)',
                    era: 'Eden, later than 1.65; excerpt',
                    says: 'Painworking DoTs are weak; the value is the area Str/Con debuff and an unbreakable snare.',
                    checked: 'WebFetch HTTP 403. Search excerpt 2026-11-03: weak DoTs, useful area Str/Con debuff and unbreakable snare.',
                },
            ],
        },
        {
            name: 'Servant with a healer',
            role: 'Melee servant build that needs a healer on the servant, for groups or a Cleric duo.',
            why: 'Sources describe Death Servant as strong with a healer and three to five times slower solo. They give no spec numbers, so these are ours, chosen to reach Channeled Frenzy at 47 and Lifeforce Vacuum at 25. Reaches at 24: Death Servant 23 Channeled Savagery, Death Servant 21 Refining the Servant, Death Servant 19 Soulbreaking Cackle; at 50: Death Servant 47 Channeled Frenzy, Death Servant 44 Soul Sundering Aura, Deathsight 25 Lifeforce Vacuum.',
            order: "A Disciple trains every line from the start, and spec spells switch on at promotion. Death Servant at character level to 23: Channeled Ferocity at 17, Refining the Servant at 21, Channeled Savagery at 23. Deathsight 6 at 24. After 24 Death Servant runs one under character level, is at it from 41 thanks to the half levels, and stops at Channeled Frenzy at 47 by level 47. The half levels it can't use go to Deathsight, Deathsight 8 by level 42, and after that everything does: Lifeforce Vacuum at 25 by level 50. Painworking 4 at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Death Servant': 23, Deathsight: 6 } },
                { level: 50, specs: { 'Death Servant': 47, Deathsight: 26, Painworking: 4 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=106&t=41456',
                    title: 'How is Death Servant Solo? (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Servant levels three to five times slower than Deathsight solo, but lasts longer in one spot; better with a friendly Cleric.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: Servant levels 3 to 5 times slower than Deathsight but stays longer in one spot.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
