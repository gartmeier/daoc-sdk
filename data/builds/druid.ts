import type { ClassBuilds } from './types';

export default {
    className: 'Druid',
    notes: "Budget 299 at 24, 1494 at 50 (ClassDruid.cs:31, multiplier 10). No autotrain. Starts as Naturalist with Regrowth and Nurture; Nature waits for promotion at 5. Baseline heals, group heals and Nature roots come with character level. Spec only reduces their variance: a heal's minimum is 0.25 + (spec - 1) / spell level (HealSpellHandler.cs:253-262). Blackthorn's remark that nearsight cannot be cured does not hold here: Cure Nearsight I and II exist at Regrowth 20 and 35.",
    builds: [
        {
            name: 'Buff druid',
            role: 'Group buffer first, healer second, with a small pet at 50.',
            why: "Level 50 is disorder.dk verbatim: 42 Nurture (Nature's Vision acuity), 33 Regrowth (Major Renascence), 7 Nature (Call Lesser Nature Spirit). Level 24 is ours and spends all 299. Nurture 20: Hunter's Offense (haste, 20), Squall's Dance (Dex/Qui 37, 19), Strength of the Orchard (18), Nature's Sight (acuity, 11). Regrowth 13: Healing Conflux (group heal, 13), Nature's Appreciation (instant 33%, 12), Major Regeneration (11).",
            order: "Nurture at character level from level 2 to 11, since it holds the group's buffs: 5 Strength of the Tree, 7 Breeze's Dance, 9 Strength of the Thicket, 10 Hunter's Blow, 11 Nature's Sight. Levels 12-13 buy Regrowth 6 Cure Poison. Nurture 13 Strength of the Grove by 15 and 14 Gust's Dance by 16, Regrowth 7 Cure Disease by 16 and 13 Healing Conflux by 20. Nurture 18 Strength of the Orchard by 23, 19 Squall's Dance and 20 Hunter's Offense at 24. After 24: Nurture 22 Nature's Wisdom by 26, 25 Strength of the Wood by 29, 29 Storm's Dance by 32. Regrowth 19 Greater Regrowth by 35, 26 Major Resuscitation by 40. Nurture 31 Nature's Sagacity by 41, 42 Nature's Vision by 47. Regrowth 33 Major Renascence and Nature 7 Call Lesser Nature Spirit last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 13, specs: { Nurture: 11, Regrowth: 6 } },
                { level: 20, specs: { Nurture: 14, Regrowth: 13 } },
                { level: 24, specs: { Nurture: 20, Regrowth: 13 } },
                { level: 40, specs: { Nurture: 29, Regrowth: 26 } },
                { level: 50, specs: { Nurture: 42, Regrowth: 33, Nature: 7 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Lists 42 Nurture, 33 Regrowth, 7 Nature for yellow spec buffs and red acuity, decent healing and a second pet.',
                },
            ],
        },
        {
            name: 'Heal druid',
            role: "Healer first at 24 with strong instants. At 50 it is the source's Buff Druid, with Nurture above Regrowth, so the buffs are not behind there.",
            why: "Level 50 is the Blackthorn Buff Druid spec verbatim; 12 Nature hits Call Nature Spirit here, while disorder's 40/35/9 stops between the Nature stops at 8 and 10. Level 24 is ours. Regrowth 22: Renewing Conflux (group heal 139, 22), Nature's Blessing (instant 55%, 21), Greater Regrowth (263, 19), Major Restoration (190, 20), Cure Nearsight I, Lesser Reconstitution (res, 16). One more level would be Bith's Benison at 23, but it does not fit next to Nurture 9. Nurture 9: Strength of the Thicket (9), Breeze's Dance (Dex/Qui, 7).",
            order: "Regrowth at character level from level 2 to 22 (5 Major Resurgance, 13 Healing Conflux, 16 Lesser Reconstitution, 21 Nature's Blessing, 22 Renewing Conflux), which leaves nothing else until 23. Levels 23-24 buy Nurture 9 Strength of the Thicket. After 24: Regrowth 23 Bith's Benison by 25, 25 Greater Restoration by 27, 30 Regenerating Spirits by 32. Nurture 19 Squall's Dance by 36, 29 Storm's Dance by 42. Regrowth 35 (Bith's Acclaimation, Cure Nearsight II) by 44, Nurture 39 Tornado's Dance by 49, Nature 12 Call Nature Spirit last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Regrowth: 22, Nurture: 9 } },
                { level: 42, specs: { Regrowth: 30, Nurture: 29 } },
                { level: 50, specs: { Regrowth: 35, Nurture: 39, Nature: 12 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/druid-guide',
                    title: 'Druid guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Nurture Druid at 39 Nurture, 35 Regrowth, 12 Nature: yellow buffs, strong healing, the level 35 instant group heal and a weak pet.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Alternative 40 Nurture, 35 Regrowth, 9 Nature with the better group heal in place of red acuity. For levelling, Nurture at level and the rest in Regrowth if you rarely solo.',
                },
            ],
        },
        {
            name: 'Group Nature',
            role: 'Forward disruptor in a group: roots, interrupts and a strong pet, with real heals.',
            why: 'Level 50 is the Blackthorn Natty spec: 39 Regrowth, 36 Nature, the remainder (here 9) in Nurture. Level 24 is ours. Nature 16: Patch of Tangleweed (AoE root, 16), Wither (15), Call Nature Spirit (12). Regrowth 15: Major Regrowth (15), Greater Regeneration (14), Healing Conflux (13). Nurture 9 as above. At 50: Bursting Undergrowth (36), Call Greater Nature Spirit (32), Resuscitating Spirits (39).',
            order: "Levels 2-4 buy Regrowth 4. From promotion Nature: 4 Patch of Ivy by 6, 7 Call Lesser Nature Spirit by 9, 10 Patch of Brambles by 11. Then Regrowth: 6 Cure Poison by 12, 13 Healing Conflux by 17. Nature 12 Call Nature Spirit by 18, 16 Patch of Tangleweed by 21. Nurture 9 Strength of the Thicket by 23, Regrowth 15 Major Regrowth at 24. After 24 Regrowth and Nature take turns: Regrowth 25 Greater Restoration by 32, Nature 22 Field of Ivy by 35, Regrowth 30 Regenerating Spirits by 39, Nature 28 Sprouting Undergrowth by 42, 32 Call Greater Nature Spirit by 44 and 36 Bursting Undergrowth by 46, Regrowth 35 Bith's Acclaimation by 48 and 39 Resuscitating Spirits at 50. Nurture stays at 9.",
            basis: 'adapted',
            targets: [
                { level: 17, specs: { Nature: 10, Regrowth: 13 } },
                { level: 24, specs: { Nature: 16, Nurture: 9, Regrowth: 15 } },
                { level: 35, specs: { Regrowth: 25, Nature: 22, Nurture: 9 } },
                { level: 42, specs: { Regrowth: 30, Nature: 28, Nurture: 9 } },
                { level: 50, specs: { Nature: 36, Regrowth: 39, Nurture: 9 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/druid-guide',
                    title: 'Druid guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Nature Druid at 39 Regrowth, 36 Nature, remainder in Nurture, for instant and AoE roots and a strong pet. Mentions going Nature 39 for the AoE root.',
                },
            ],
        },
        {
            name: 'Solo Nature',
            role: 'Solo levelling and solo play behind a pet and roots.',
            why: "Blackthorn asks for at least 41 and ideally 48 Nature solo; disorder.dk says Nature near level with the rest in Nurture. The 48 is sourced, every other number is ours. Nature 20: Call Major Nature Spirit (20), Corruption (19), Thornsprout (18). Nurture 11: Nature's Sight. The Bark buffs are baseline and come with level, not with this spec. Regrowth 6: Major Resurgance (5), Cure Poison (6). At 50: Defedation (48), Call Greater Nature Spirit (32), Field of Tangleweed (39), Nurture 22 Nature's Wisdom.",
            order: "Levels 2-4 bank everything: the first target is empty. At promotion the 14 points buy Nature 5, and it stays at character level to 20, which uses every point: pets at 7 Call Lesser Nature Spirit, 12 Call Nature Spirit, 20 Call Major Nature Spirit, roots at 4 Patch of Ivy, 10 Patch of Brambles, 16 Patch of Tangleweed. Levels 21-23 buy Nurture 11 Nature's Sight, level 24 Regrowth 6 Cure Poison. After 24 Nature runs three or four levels behind: 24 Blight by 28, 30 Dry Rot by 33, 32 Call Greater Nature Spirit by 35, 36 Bursting Undergrowth by 39. The half levels from 40.5 bring it back: 41 Degeneration by 43, 48 Defedation at 48. Nurture 22 Nature's Wisdom and Regrowth 11 Major Regeneration last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 4, specs: {} },
                { level: 24, specs: { Nature: 20, Nurture: 11, Regrowth: 6 } },
                { level: 50, specs: { Nature: 48, Nurture: 22, Regrowth: 11 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/druid-guide',
                    title: 'Druid guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Suggests at least 41 Nature and ideally 48 for solo, while noting it stays hard compared with other classes.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'For levelling: Nature near character level, the rest in Nurture, and capable of soloing.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
