import type { ClassBuilds } from './types';

export default {
    className: 'Warrior',
    notes: 'Multiplier 20 (ClassWarrior.cs:33): 584 at 24, 2979 at 50. Autotrain on Axe, Hammer and Sword (ClassWarrior.cs:27,40-43): levels up to floor(level/4) are free (GamePlayer.cs:4833,4844, train.cs:115), so up to 6 at 24 worth 20 points and up to 12 at 50 worth 77, per line. SkillSpecialtyPoints recomputes this on every read (GamePlayer.cs:3512), so it holds on both training paths. Key is Shields; the skill list shows Shield. Shields also grants Shields 7 (Engage), Shields 15 (Guard) (level 3). Role: tank. A build must name the key and the weapon.',
    builds: [
        {
            name: 'Hammer, Shields 42, high Parry',
            role: 'Group tank who is hard to peel off, with snare openers.',
            why: 'Shields 42 (Slam) is the stun both guides insist on and it exists at that level here. Hammer keeps Hammer 12 (Frost Hammer) and Hammer 29 (Conquer) as snares for peeling. Level 50 verbatim; level 24 spends all 584 points and leaves Slam for later.',
            order: "Hammer at level from 2, since a Viking can train it; after promotion autotrain makes its levels up to level / 4 free. Shields comes at 5 and follows one to three behind: Shields 7 (Engage) at 9, Shields 15 (Guard III) at 16, Shields 18 (Incapacitate) at 19. Then Parry 16 at 24. After 24 Hammer stays at level to Hammer 50 (Mjolnir's Fury) at 50. Shields goes straight on: Shields 29 (Bash) at 33, Shields 35 (Mangle) at 38, Shields 42 (Slam) at 43. Parry stays at 16 until 42, then takes the rest, Parry 41 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Hammer: 24, Shields: 18, Parry: 16 } },
                { level: 50, specs: { Hammer: 50, Shields: 42, Parry: 41 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/warrior-guide',
                    title: 'Blackthorn wiki: warrior guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Hammer, 42 Shield, 41 Parry as the main 8v8 spec; Sword and Axe are excluded for group play because they lack back and side snares.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: weapon at level (Hammer), rest Shield, leftover Parry. RvR: at least 42 Shield.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Hammer, Shields 50, less Parry',
            role: 'Group tank that blocks and stuns first and gives up Parry.',
            why: 'The other group spec. Fits with the autotrain refund: 2966 of 2979. At 24 this is the Uthgard levelling rule on this budget and reaches Shields 23 (Paralyze).',
            order: "Hammer at level from 2. Shields comes at 5 and follows one to three behind, Shields 15 (Guard III) at 16, then is at level from 20 as the free Hammer levels pay for it: Shields 23 (Paralyze) at 23. Then Parry 7 at 24. After 24 Hammer stays at level to Hammer 50 (Mjolnir's Fury) at 50. Shields runs one behind and is at level again from 36: Shields 29 (Bash) at 30, Shields 35 (Mangle) at 36, Shields 42 (Slam) at 42, Shields 50 (Brutalize) at 50. Parry stays at 7 until 39, then takes the rest, Parry 31 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Hammer: 24, Shields: 23, Parry: 7 } },
                { level: 50, specs: { Hammer: 50, Shields: 50, Parry: 31 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/warrior-guide',
                    title: 'Blackthorn wiki: warrior guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: 'Alternative group spec: Shield 50, Parry 31, Hammer unstated but apparently still 50.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/how-far-do-warriors-spec-into-weapon-and-other-questions-about-warriors-01D1RER8HG754X67HTVD4S0J5M',
                    title: 'How far do Warriors spec into weapon?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Thread attribution not certain: 50 Hammer, 50 Shield, rest Parry as the standard group RvR spec.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Sword two-hander, Shields 42',
            role: 'Tank with more damage, swapping to a two-handed Sword when not blocking.',
            why: 'Numbers unconfirmed: the only source is a Phoenix thread that is now a parked domain, and its attribution was already uncertain. A Phoenix option for a Warrior who already fights with a Sword. Hammer 29 (Conquer) keeps one snare; the first 12 Hammer levels are free at 50. Blackthorn rejects Sword and Axe for group play for lack of back and side snares. Use Axe the same way: a Phoenix poster ran 50 Axe, 42 Shield, 41 Parry.',
            order: 'Sword at level from 2, since a Viking can train it. Shields comes at 5 and follows one to three behind: Shields 18 (Incapacitate) at 19. Then Parry 16 at 24. After 24 Sword stays at level to Sword 50 (Ragnarok) at 50, and Shields goes on to Shields 42 (Slam) at 43. Hammer stays at 1 until 42, then Hammer 29 (Conquer) at 47, its first 12 levels free by 50. Parry stays at 16 until 46, then takes the rest, Parry 31 at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Sword: 24, Shields: 18, Parry: 16 } },
                { level: 50, specs: { Sword: 50, Shields: 42, Hammer: 29, Parry: 31 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/10080-warriorwhich-weapon-line',
                    title: 'Warrior...which weapon line?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Search summary, thread attribution not certain: 50 Sword, 42 Shield, 29 Hammer, rest Parry for a two-handed build. The rest computed here as Parry 31.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
