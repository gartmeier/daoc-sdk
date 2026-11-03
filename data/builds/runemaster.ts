import type { ClassBuilds } from './types';

export default {
    className: 'Runemaster',
    notes: "Multiplier 10 (ClassRunemaster.cs:31): 299 at 24, 1494 at 50. Train the keys Darkness, Runecarving, Suppression: the spell lines Runes of Darkness and the like are not trainable (learnings/npc-dialog.md). Starts as Mystic (Darkness, Suppression only). Uthgard's 47 Darkness, 27 Suppression costs 1504 and is 10 over here, so all targets use 26, which still reaches Suppression 26 (Runic Guard). Blackthorn says 46 Runecarving gives the strongest cold debuff; on this server that is Runecarving 48 (Vex of Ice), so its 46, 25, 13 spec does not do what it says here. No cold debuff is possible at 24: the first is Runecarving 27 (Vex of Cold). Role: nuker.",
    builds: [
        {
            name: 'Darkness nuker',
            role: 'Main nuker with the top direct damage spell and a strong damage add.',
            why: "Uthgard's pick for RvR and PvE, and one of Blackthorn's group specs. Darkness 47 (Greater Rune of Shadow) is the top nuke. The top damage add here is Darkness 49 (Rune of Torment); at 47 the add is Darkness 39 (Rune of Misery), so Blackthorn's best damage add does not hold on this server. Level 24 is simplest: Darkness 24 (Rune of Pain) spends all 299. Runecarving 5 at 50 uses the 17 spare points; a Uthgard poster also put leftovers there.",
            order: 'Darkness at level from 2, since a Mystic can train it, all the way: Darkness 13 (Rune of Murk) at 13, Darkness 18 (Rune of Hurt) at 18, Darkness 23 (Rune of Obscurity) at 23, Darkness 24 (Rune of Pain) at 24, Darkness 39 (Rune of Misery) at 39, Darkness 47 (Greater Rune of Shadow) at 47, where it stops. That takes every point until the half levels start at 40.5, so Suppression stays at 1 until 40. Then Suppression 16 (Runic Shield) at 47, Suppression 25 (Suppress View) at 50, Suppression 26 (Runic Guard) at 50, with Runecarving 5 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Darkness: 24 } },
                { level: 50, specs: { Darkness: 47, Suppression: 26, Runecarving: 5 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/runemaster-guide',
                    title: 'Blackthorn wiki: runemaster guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '47 Darkness, 26 Suppression for a group with one Runemaster: strongest spec nuke and best damage add.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'PvE: Darkness for nukes and top damage add. RvR: 47 Darkness, 27 Suppression, which is over budget here.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Suppression support',
            role: 'Support caster: group bladeturn, nearsight and snare nukes.',
            why: 'For a group with another caster. Suppression 44 (Runic Wall) is the best group bladeturn and the nearsight line tops out by 40. At 24, Suppression 20 (Field of Entrapping) with Darkness 13 (Rune of Murk) spends exactly 299 and already has Suppression 16 (Runic Shield) and Suppression 19 (Suppress Vision).',
            order: 'Levels 2-5 buy Darkness only, for the first nukes: Darkness 4 (Minor Raven Bolt, castable only from promotion) at 4, Darkness 5 (Rune of Discomfort) at 5. The target at 5 is what keeps Suppression out until then. Suppression follows one to three behind level: Suppression 11 (Suppress Sight) at 13, Suppression 16 (Runic Shield) at 17, Suppression 19 (Suppress Vision) at 20, Suppression 20 (Field of Entrapping) at 21. Darkness stays at 5 until 20, then Darkness 13 (Rune of Murk) at 24. After 24 Suppression alone: Suppression 27 (Field of Snaring) at 31, Suppression 44 (Runic Wall) at 45, Suppression 46 (Field of Mazing) at 46, Suppression 47 at 47. Darkness stays at 13 until 44, then Darkness 26 at 50, with Runecarving 5 at 50.',
            basis: 'adapted',
            targets: [
                { level: 5, specs: { Darkness: 5 } },
                { level: 24, specs: { Suppression: 20, Darkness: 13 } },
                { level: 50, specs: { Suppression: 47, Darkness: 26, Runecarving: 5 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/runemaster-guide',
                    title: 'Blackthorn wiki: runemaster guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '47 Suppression, 26 Darkness: best group bladeturn and nearsight, weaker nukes.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=61&t=32297',
                    title: 'New runemaster spec',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: Darkness to 20, then Suppression to 40, then back to Darkness for levelling.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Runecarving debuffer',
            role: 'Debuffs cold for the other casters, then nukes with base Darkness.',
            why: "Runecarving 48 (Vex of Ice) is the reason for this spec and it sits at that level in this server's table. The 48, 22, 11 split comes from a Phoenix thread seen only as a search summary; Blackthorn's readable 46, 25, 13 is the same shape with the debuff at its own level. Only sensible with other cold-damage dealers in the group. Uthgard warns the bolts miss often. At 24 there is no cold debuff yet: it has Runecarving 22 (Vex of Heat) and Runecarving 23 (Lesser Sigil of Devastation).",
            order: "Levels 2-5 buy Darkness only: Darkness 4 (Minor Raven Bolt, castable only from promotion) at 4, Darkness 5 (Rune of Discomfort) at 5. The target at 5 is what keeps Runecarving out until then. Runecarving follows one to three behind level: Runecarving 18 (Odin's Frenzy) at 19, Runecarving 19 (Mark of Ruin) at 20, Runecarving 23 (Lesser Sigil of Devastation) at 24, with Suppression 4 at 24. After 24 Runecarving stays one behind and is at level from 42: Runecarving 27 (Vex of Cold) at 28, Runecarving 36 (Vex of Frost) at 37, Runecarving 48 (Vex of Ice) at 48. Suppression stays at 4 until 41, then Suppression 11 (Suppress Sight) at 44. Darkness stays at 5 until 44, then Darkness 22 (Greater Raven Bolt) at 50.",
            basis: 'adapted',
            targets: [
                { level: 5, specs: { Darkness: 5 } },
                { level: 24, specs: { Runecarving: 23, Darkness: 5, Suppression: 4 } },
                { level: 50, specs: { Runecarving: 48, Suppression: 11, Darkness: 22 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/13719-recommended-spec-runemaster-for-rvr',
                    title: 'Recommended spec Runemaster for RVR',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '48 Runecarving, 22 Darkness, 11 Suppression as the base build with other casters present; cold debuff at 48.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/runemaster-guide',
                    title: 'Blackthorn wiki: runemaster guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: 'Also a tri-spec of 34, 34, 24 and a 46, 25, 13; its 46 claim does not hold here.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
