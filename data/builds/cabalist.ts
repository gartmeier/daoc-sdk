import type { ClassBuilds } from './types';

export default {
    className: 'Cabalist',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassCabalist.cs:31). Before promotion only Matter Magic, Body Magic train (Mage): the rule raises those a target lists and banks the rest. 44 Matter, 31 Spirit, 4 Body from Uthgard also fits (1493). Simulacra are baseline, so they follow character level (spelllines.json).',
    builds: [
        {
            name: 'Matter',
            role: 'Damage over time and area damage over time behind a simulacrum, the PvE farmer.',
            why: 'Sources agree Matter is the efficient PvE line, and 46 is the last area damage over time. Level 50 uses every point. At 24 Spirit 3 costs Perforate Spirit one level: Matter 24 with Spirit 3 needs level 25, and Matter 24 alone (299) is the alternative if the area DoT matters more than reclaiming the pet. Reaches at 24: Matter Magic 18 Puncture Spirit, Matter Magic 21 Devolution, Matter Magic 22 Channel Blow; at 50: Matter Magic 46 Lance Spirit, Matter Magic 40 Channel Offense, Body Magic 28 Seize Lifeforce.',
            order: "Mage levels: Matter to 4. Promotion's 5 points buy Spirit 3 for Convert Spirit at 3, which reclaims the pet for power, because the source wants it early. That leaves Matter one under character level from level 6 to 40: Contamination at 13 by level 14, Puncture Spirit at 18 by level 19 is the first area DoT, Devolution at 21 by level 22, Matter 23 by level 24. What has banked by then pays for Body 5 at 24. After 24 Matter climbs the next area DoTs: Perforate Spirit at 24 by level 25, Bore Spirit at 29 by level 30, Drill Spirit at 36 by level 37. The half levels put it at character level from 41, and it stops at Lance Spirit at 46 by level 46. Then Body, Seize Lifeforce at 28 by level 50, and Spirit 4 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Spirit Magic': 3, 'Matter Magic': 23, 'Body Magic': 5 } },
                { level: 50, specs: { 'Matter Magic': 46, 'Body Magic': 28, 'Spirit Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://camelotherald.fandom.com/wiki/Cabalist',
                    title: 'Cabalist (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: '46 Matter, 28 Body, 4 Spirit as a common level 50 spec, with the last area DoT and a better tap.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: both 46, 28, 4 specs, with the 50% Body debuff on the Spirit one.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=100&t=38252',
                    title: 'Leveling Guide 1-50 (Uthgard forum, Cabalist)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Area DoTs at 18, 24, 29, 36, 46, and at least 3 Spirit early to reclaim the pet.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 3 Spirit to reclaim the pet moves the first area DoT from 18 to 19; 46 is the last area DoT. The steps at 24 and 29 were not in the excerpt but are in spelllines.json.',
                },
            ],
        },
        {
            name: 'Spirit debuffer',
            role: 'Body resist debuffer whose taps hit harder, with a strong buffed pet.',
            why: 'The other 46, 28, 4 on the wiki, and it uses every point. Body resist debuff first appears at Spirit 22 and reaches 50% at 46. Simulacra come from the Spirit baseline with character level, whatever the spec. Level 24 is fitted here. Reaches at 24: Spirit Magic 22 Diminish Immunities, Spirit Magic 19 Animate Golem, Spirit Magic 18 Invigorate Golem; at 50: Spirit Magic 46 Banish Immunities, Body Magic 28 Seize Lifeforce, Body Magic 24 Cursed Soul.',
            order: 'Spirit only opens at promotion, so the Mage levels bank their 9 points and promotion buys Spirit 5 at once. Then every point, at character level to 22: Expose Flaw at 10, Strengthen Golem at 11, Invigorate Golem at 18, Animate Golem at 19, Diminish Immunities at 22. Levels 23 and 24 pay for Body 8 by level 24 (Pilfer Lifeforce at 7, Inflict Greater Malaise at 8) and Matter 4. After 24 Spirit again, two under character level at first, and at it from 43 to Banish Immunities at 46 by level 46. Then Body, Seize Lifeforce at 28 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 5, specs: { 'Spirit Magic': 5 } },
                { level: 24, specs: { 'Spirit Magic': 22, 'Body Magic': 8, 'Matter Magic': 4 } },
                { level: 50, specs: { 'Spirit Magic': 46, 'Body Magic': 28, 'Matter Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://camelotherald.fandom.com/wiki/Cabalist',
                    title: 'Cabalist (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: '46 Spirit, 28 Body, 4 Matter, with a 50% Body debuff that strengthens the tap.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: both 46, 28, 4 specs, with the 50% Body debuff on the Spirit one.',
                },
            ],
        },
        {
            name: 'Tri-spec',
            role: 'RvR utility: nearsight, disease, body debuff and pet interrupts.',
            why: 'The RvR build in the guide and the Uthgard overview; level 50 leaves 16 points spare. It spreads thin at 24, so it is the weakest of the three at that level. Level 24 is fitted here. Reaches at 24: Body Magic 15 Cursed Spirit, Body Magic 14 Siphon Lifeforce, Spirit Magic 12 Hurry Golem; at 50: Spirit Magic 33 Dissipate Immunities, Matter Magic 25 Clouded Sight, Body Magic 34 Cursed Vitality.',
            order: 'Body at character level from the first point to 16: Drain Lifeforce at 10, Siphon Lifeforce at 14, Cursed Spirit at 15. Then Matter: Encrust Eyes at 11 by level 20, Matter 12 by level 21. Spirit, open from promotion, comes last: Strengthen Golem at 11 and Hurry Golem at 12 by level 24. After 24 one line at a time: Body to Cursed Soul at 24 by level 30, Matter to Clouded Sight at 25 by level 37, Spirit to Dissipate Immunities at 33 by level 46, then Body to Cursed Vitality at 34 by level 50, with 16 points spare.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Body Magic': 16, 'Matter Magic': 12, 'Spirit Magic': 12 } },
                { level: 30, specs: { 'Body Magic': 24, 'Matter Magic': 12, 'Spirit Magic': 12 } },
                { level: 50, specs: { 'Matter Magic': 25, 'Spirit Magic': 33, 'Body Magic': 34 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'RvR: Body 34, Spirit 33, Matter 25.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=100&t=41486',
                    title: 'Cabalist - Overview and expected roles (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Lists 25 Matter, 34 Body, 33 Spirit among tri-specs for nearsight, disease and debuff.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 25 Matter, 34 Body, 33 Spirit for one Cabalist in an 8-man group.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
