import type { ClassBuilds } from './types';

export default {
    className: 'Eldritch',
    notes: 'Budget 299 at 24, 1494 at 50 (ClassEldritch.cs:31, multiplier 10). No autotrain. Starts as Magician with Light and Mana; Void waits for promotion at 5. Sources say Light Magic, Mana Magic and Void Magic; the keys are Light, Mana and Void. All three baselines come with character level, but a nuke from a low line has wide damage variance: its minimum falls to 20.8 % at spec 1 (SpellHandler.cs:2748-2763), which is why one line stays near level. disorder.dk warns bolts are buggy on Uthgard; whether that applies to OpenDAoC was not checked.',
    builds: [
        {
            name: 'Light nuker',
            role: 'Group nuker with nearsight, Dex/Qui debuff and AoE mez for emergencies.',
            why: 'Level 50 is verbatim in both disorder.dk and Blackthorn. Light 46 reaches Extinguish Coordination (AoE Dex/Qui debuff, 46), Shadowdoom (45), Abrogate Sight (40), Paralyzing Sphere (37). Mana 28: Lesser Health Dispersal (AoE Str/Con, 28), Entropic Illness (AoE disease, 27), Mana Flux (PBAoE, 26). Level 24 is ours. Light 22: Shadowcrash (102), Nullify Sight (19), Paralyzing Veil (AoE mez, 15). Mana 9: Greater Ensnaring Blast (snare nuke), Mana Ripple (PBAoE, 7).',
            order: 'Light at character level from level 2 to 22 Shadowcrash (15 Paralyzing Veil, 19 Nullify Sight), which uses every point. Levels 23-24 buy Mana 9 Greater Ensnaring Blast. After 24 Light runs two levels behind: 28 Shadowforce by 30, 32 Destroy Sight by 34, 35 Shadowcrush by 37, 40 Abrogate Sight by 41. Then Mana, mostly from the half levels: 16 Entropic Sickness by 43, 20 Mana Burst by 44, 26 Mana Flux by 46, 28 Lesser Health Dispersal by 47. Light 45 Shadowdoom and 46 Extinguish Coordination last, at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Light: 22, Mana: 9 } },
                { level: 47, specs: { Light: 40, Mana: 28 } },
                { level: 50, specs: { Light: 46, Mana: 28 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Gives 46 Light, 28 Mana for the best nearsight, a good Dex/Qui debuff, AE disease and yellow mez.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/eldritch-guide',
                    title: 'Eldritch guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Calls 46 Light, 28 Mana the Light Eldritch: best cold nuke, nearsight, AoE Dex/Qui debuff, plus bomb and AoE snare from Mana.',
                },
            ],
        },
        {
            name: 'Mana bomber',
            role: 'PBAoE and AoE snare caster for group levelling and keep defence.',
            why: 'Level 50 is disorder.dk verbatim: Mana Flood (PBAoE 325, 48), Greater Vitality Dispersal (49), Greater Demobilizing Blast (50); Light 20 reaches Abrogate Coordination (18) and Nullify Sight (19). Level 24 is ours. Mana 23: Webbing Blast (snare nuke 85, 23), Mana Burst (PBAoE 133, 20), Lesser Kinetic Dampening (AoE snare, 19), Disperse Vigor (18). Light 6: Paralyzing Wind (10 s AoE mez, 4), Nullify Coordination (6).',
            order: 'Mana at character level from level 2 to 23 Webbing Blast (19 Lesser Kinetic Dampening, 20 Mana Burst), which uses every point. Level 24 buys Light 6 instead (4 Paralyzing Wind, 6 Nullify Coordination). After 24 Mana runs one level behind to 40: 26 Mana Flux by 27, 32 Mana Billow by 33, 39 Mana Surge by 40. The half levels from 40.5 bring it back to character level (48 Mana Flood, 50 Greater Demobilizing Blast) and buy Light: 14 by 45, 19 Nullify Sight by 49, 20 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Mana: 23, Light: 6 } },
                { level: 50, specs: { Mana: 50, Light: 20 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Gives 50 Mana, 20 Light for the best PBAE, snare, Str/Con debuff and nearsight. Mana suits group levelling, Light suits single mobs.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/eldritch-guide',
                    title: 'Eldritch guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Most PvE Eldritches go Mana: PBAoE bomb plus AoE Str/Con debuff. Let the tank taunt first, or the bomb pulls aggro. No numbers for PvE.',
                },
                {
                    url: 'https://www.gameswelt.de/dark-age-of-camelot/komplettloesung/komplettloesung-4617/5',
                    title: 'Hibernia: Der Eldritch (Gameswelt)',
                    era: 'Old frontiers: German guide dated 21 August 2002',
                    says: 'Mana Eldritch is preferred in groups with a tank holding mobs, strong in keep defence, weaker solo. No numbers.',
                },
            ],
        },
        {
            name: 'Split Mana and Light',
            role: 'Burst caster that keeps both nuke families one tier under the top.',
            why: 'Level 50 is Blackthorn verbatim. Mana 39: Mana Surge (PBAoE 265), Disperse Health (38), Entropic Disease (37). Light 37: Paralyzing Sphere (37), Obliterate Coordination (36), Shadowcrush (35). Level 24 is ours and spends all 299. Mana 20: Mana Burst, Disperse Vigor. Light 13: Destroy Coordination (13), Shadowshock (12), Negate Sight (10).',
            order: 'Mana at character level from level 2 to 16 Entropic Sickness, which uses every point. Levels 17-19 buy Light 10 (6 Nullify Coordination, 10 Negate Sight). Mana 20 Mana Burst by 23, Light 13 Destroy Coordination at 24. After 24 they take turns by stop: Light 19 Nullify Sight by 28, Mana 26 Mana Flux by 33, Light 22 Shadowcrash by 35 and 28 Shadowforce by 39, Mana 32 Mana Billow by 42, Light 35 Shadowcrush by 46 and 37 Paralyzing Sphere by 47, Mana 39 Mana Surge at 50.',
            basis: 'adapted',
            targets: [
                { level: 19, specs: { Mana: 16, Light: 10 } },
                { level: 24, specs: { Mana: 20, Light: 13 } },
                { level: 33, specs: { Light: 19, Mana: 26 } },
                { level: 42, specs: { Light: 28, Mana: 32 } },
                { level: 50, specs: { Light: 37, Mana: 39 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/eldritch-guide',
                    title: 'Eldritch guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Split spec at 39 Mana, 37 Light, dropping nearsight and Dex/Qui debuff a tier in exchange for a much stronger Str/Con debuff, bomb, AoE disease and snare nuke.',
                },
            ],
        },
        {
            name: 'Void solo',
            role: 'Single-target bolts and AoE at range for solo and pairs.',
            why: 'Old advice only: the 2002 Gameswelt guide puts every point in Void, and recent sources skip the line, disorder.dk even warning against bolts on Uthgard. Treat as untested. All numbers are ours. Void 24: Oblivion Bolt (162, 20 s recast, 24), Sphere of Oblivion (AoE 85, 23), Nullify Hardiness (body debuff, 22), Lesser Null Ebullition (18). Baseline Way of the Eclipse adds Void Fissure (115, 22) with level. Level 50: Bolt of Uncreation (46), Null Tempest (44), Void Dissipation (49), plus Light 20 for sight and mez.',
            order: 'Levels 2-4 bank everything, since a Magician has no Void. At promotion the 14 points buy Void 5, and it stays at character level to 50, which uses every point through 40: 7 Negative Bolt, 12 Abrogation Bolt, 17 Null Bolt, 23 Sphere of Oblivion, 24 Oblivion Bolt, 31 Annihilation Bolt, 38 Obliteration Bolt, 46 Bolt of Uncreation. The half levels from 40.5 buy Light: 14 by 45, 19 Nullify Sight by 49, 20 at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Void: 24 } },
                { level: 50, specs: { Void: 50, Light: 20 } },
            ],
            sources: [
                {
                    url: 'https://www.gameswelt.de/dark-age-of-camelot/komplettloesung/komplettloesung-4617/5',
                    title: 'Hibernia: Der Eldritch (Gameswelt)',
                    era: 'Old frontiers: German guide dated 21 August 2002',
                    says: 'Void Eldritch: all points in Void from the start, good for beginners and solo, with high single-target damage, less welcome in groups.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Says not to spec bolts because they are buggy on Uthgard.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
