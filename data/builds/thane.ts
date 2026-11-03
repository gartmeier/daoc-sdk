import type { ClassBuilds } from './types';

export default {
    className: 'Thane',
    notes: "Multiplier 20 (ClassThane.cs:13), no autotrain: 584 at 24, 2979 at 50. Key is Shields. Stormcalling is a spec line only for this class: its buffs and nukes all come from spec level, none from character level. Stormcalling 15 (Thunder's Force), Stormcalling 20 (Thor's Might), Stormcalling 21 (Thunder's Crush) are the self-buff steps below 24. Slam, Shields 42 (Slam), is out of reach at 24. Blackthorn's third spec, 46 Stormcalling, 44 Hammer, 42 Shield, rest Parry (Parry 3, 2976 of 2979), is not a build here. Role: tank.",
    builds: [
        {
            name: 'Stormcalling first',
            role: 'Hybrid who nukes from range and tanks second.',
            why: "Blackthorn's most rounded spec: Stormcalling 50 (Thor's Potence) closes the strength gap with a Warrior. The Uthgard guide also keeps Stormcalling high while levelling, for the self-buffs. Level 50 verbatim; level 24 fitted, reaching Stormcalling 23 (Thor's Lesser Lightning).",
            order: "Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Stormcalling. Stormcalling comes at 5, is at 3 there and at level from 7: Stormcalling 16 (Call Mjollnir) at 16, Stormcalling 22 (Invoke Mjollnir) at 22, Stormcalling 23 (Thor's Lesser Lightning) at 23. Hammer takes the rest, Hammer 15 (Provoke) at 16, Hammer 16 at 17. Shields stays at 1 until 16, then Shields 15 (Guard III) at 23, Shields 18 (Incapacitate) at 24. After 24 Stormcalling is at level from 25: Stormcalling 46 (Thunder's Rend) at 46, Stormcalling 50 (Thor's Potence) at 50. The other two take turns, and the stop at 39 is ours, so that Hammer doesn't stay at 16 until Slam: Hammer 25 (Crumble) at 32, Shields 29 (Bash) at 39, Shields 42 (Slam) at 45, Hammer 39 (Lambast) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Stormcalling: 23, Hammer: 16, Shields: 18 } },
                { level: 39, specs: { Stormcalling: 39, Hammer: 25, Shields: 29 } },
                { level: 50, specs: { Stormcalling: 50, Shields: 42, Hammer: 39 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/thane-guide',
                    title: 'Blackthorn wiki: thane guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Stormcalling, 42 Shield, 39 Hammer for group and solo; 42 Shield is mandatory for Slam.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: Stormcalling kept high for self damage add and Str/Con, Hammer for low endurance cost, Shield optional. No numbers.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Even hybrid with Parry',
            role: 'Group tank or off-tank with some ranged damage and a real Parry.',
            why: "The Uthgard RvR spec. Stops at Stormcalling 46 (Thunder's Rend), the top damage add, and pays for Parry by skipping the last buff. A Uthgard forum variant, 48 Stormcalling, 42 Shield, 39 Hammer, 15 Parry, is close to this and also fits.",
            order: "Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Stormcalling. Stormcalling comes at 5, is at 3 there and at level from 7 up to Stormcalling 22 (Invoke Mjollnir) at 22. Hammer takes the rest, Hammer 15 (Provoke) at 16. Shields stays at 1 until 15, then Shields 18 (Incapacitate) at 24, with Parry 8 at 24. After 24 Shields goes first and is at level from 29: Shields 29 (Bash) at 29, Shields 35 (Mangle) at 35, Shields 42 (Slam) at 42. Hammer stays at 15 until 29, then Hammer 25 (Crumble) at 35, Hammer 29 (Conquer) at 38. Stormcalling stays at 22 until 38, then Stormcalling 29 (Thor's Lightning) at 42, Stormcalling 46 (Thunder's Rend) at 47. Hammer stays at 29 until 46, then Hammer 39 (Lambast) at 49, and Parry 20 at 50. The stop at 42 is ours: the rule raises one line at a time, so Hammer and Stormcalling take turns.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Stormcalling: 22, Hammer: 15, Shields: 18, Parry: 8 } },
                { level: 42, specs: { Shields: 42, Hammer: 29, Stormcalling: 30, Parry: 8 } },
                { level: 50, specs: { Shields: 42, Stormcalling: 46, Hammer: 39, Parry: 20 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR: 46 Stormcalling, 42 Shield, 39 Hammer, 20 Parry; adds that Warriors do much of this job better.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=124&t=38066',
                    title: 'Thane Spec',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: 48 Stormcalling, 42 Shield, 39 Hammer, 15+ Parry as a safe all-round spec.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Hammer first',
            role: 'Melee-leaning tank with Stormcalling as a side tool.',
            why: 'Less popular per Blackthorn because ranged damage drops. Sensible for a Thane who fills the tank slot in a bot group, where taunts and swings matter more than nukes.',
            order: "Hammer at level from 2, since a Viking can train it, up to Hammer 23 at 23. Stormcalling comes at 5 and takes the rest: Stormcalling 15 (Thunder's Force) at 16, Stormcalling 16 (Call Mjollnir) at 17. Shields stays at 1 until 16, then Shields 15 (Guard III) at 23, Shields 18 (Incapacitate) at 24. After 24 Hammer is at level from 25 to Hammer 50 (Mjolnir's Fury) at 50, and Shields goes on to Shields 42 (Slam) at 43. Stormcalling stays at 16 until 42, so its buffs above that wait: Stormcalling 20 (Thor's Might) at 44, Stormcalling 38 (Thor's Greater Lightning) at 50, Stormcalling 39 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Hammer: 23, Stormcalling: 16, Shields: 18 } },
                { level: 50, specs: { Hammer: 50, Shields: 42, Stormcalling: 39 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/thane-guide',
                    title: 'Blackthorn wiki: thane guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Hammer, 42 Shield, 39 Stormcalling as the melee-leaning hybrid.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
