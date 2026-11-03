// Holds what the class guides (learnings/classes/) claim to the data and to the Spellbook a member fights with.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, specCost } from '../../data/builds';
import { getClass, getSpell } from '../../data/index';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { planBuffs } from '../group/buffs';
import type { MemberContext } from '../group/member';
import { roleForClass } from '../group/strategy';
import type { MemberReport, Role } from '../group/types';
import { paladin } from './paladin';
import { reach, reachOfBuild, type Reach } from './reach';
import { shaman } from './shaman';
import { skald } from './skald';
import { sorcerer } from './sorcerer';
import { theurgist } from './theurgist';
import { thrifty } from './thrifty';

const guide = (name: string) => readFileSync(join(import.meta.dir, `../../learnings/classes/${name}.md`), 'utf-8').replaceAll('\r\n', '\n');
const names = (list: { spell: { name: string } }[]) => list.map(s => s.spell.name);

/** The build table of a guide is what the rule gives. */
function tableHolds(className: string, builds: string[]) {
    const text = guide(className.toLowerCase());
    const multiplier = getClass(className)!.specializationMultiplier;
    for (const level of [10, 20, 24, 30, 40, 50]) {
        const cells = builds.map(name => {
            const build = getBuild(className, name)!;
            const specs = buildPath(build)[level - 1]!.specs;
            return Object.keys(build.targets.at(-1)!.specs).map(line => specs[line] ?? 1).join(' / ');
        });
        expect(text).toContain(`| ${level} | ${earnedSpecPoints(multiplier, level)} | ${cells.join(' | ')} |`);
    }
}

describe('reach', () => {
    test('a line spell comes with its spec', () => {
        expect(reach('Druid', 24, {}).known.some(k => k.name === 'Greater Regrowth')).toBe(false);
        expect(reach('Druid', 24, { Regrowth: 19 }).known.some(k => k.name === 'Greater Regrowth')).toBe(true);
    });
});

describe('druid guide', () => {
    const heal = () => reachOfBuild(getBuild('Druid', 'Heal druid')!, 24);

    test('its table is what the rule gives', () => tableHolds('Druid', ['Heal druid', 'Buff druid', 'Group Nature', 'Solo Nature']));

    test('Heal druid heals up to Greater Regrowth, then the instant, and never picks a group heal or Appreciation', () => {
        const r = names(heal().heals);
        expect(r.at(-2)).toBe('Greater Regrowth');
        expect(r.at(-1)).toBe("Nature's Blessing");
        expect(r).not.toContain('Renewing Conflux');
        expect(r).not.toContain("Nature's Appreciation");
    });

    test('its crowd control is a root, its rez the lesser one', () => {
        const r = heal();
        expect(r.cc?.kind).toBe('root');
        expect(r.cc?.spell.name).toBe('Holding Vines');
        expect(r.rez?.spell.name).toBe('Lesser Reconstitution');
    });

    test('Nurture 9 has no acuity; Regrowth 21, Nurture 11 has it, keeps the instant, and fits the budget', () => {
        expect(heal().buffs.some(b => b.slot === 'acuity')).toBe(false);
        const moved = reach('Druid', 24, { Regrowth: 21, Nurture: 11 });
        expect(names(moved.buffs.filter(b => b.slot === 'acuity'))).toEqual(["Nature's Sight"]);
        expect(names(moved.heals)).toContain("Nature's Blessing");
        expect(specCost(1, 21) + specCost(1, 11)).toBeLessThanOrEqual(earnedSpecPoints(10, 24));
    });

    test('a Bard at 24 has no acuity either', () => {
        expect(reachOfBuild(getBuild('Bard', 'Nurture support')!, 24).buffs.some(b => b.slot === 'acuity')).toBe(false);
    });
});

describe('bard guide', () => {
    const support = () => reachOfBuild(getBuild('Bard', 'Nurture support')!, 24);
    const music = () => reachOfBuild(getBuild('Bard', 'Music crowd control')!, 24);
    const songValue = (r: ReturnType<typeof support>, kind: string) => r.songs.find(s => s.kind === kind)?.value;

    test('its table is what the rule gives', () => tableHolds('Bard', ['Nurture support', 'Music crowd control']));

    test('the mezz is baseline: Music 1, 10 and 21 cast the same one, and the area ones never go off', () => {
        expect(support().cc?.spell.name).toBe('Mesmerizing Hymn');
        expect(music().cc?.spell.name).toBe('Mesmerizing Hymn');
        expect(reach('Bard', 24, { Music: 1 }).cc?.spell.name).toBe('Mesmerizing Hymn');
        expect(support().areaMezz?.spell.name).toBe('Mesmerizing Hymn');
        expect(music().known.some(k => k.name === 'Captivate Swarms')).toBe(true);
    });

    test('Music crowd control has every song a rank lower', () => {
        expect([songValue(support(), 'speed'), songValue(support(), 'endurance'), songValue(support(), 'power')]).toEqual([174, 3, 2]);
        expect([songValue(music(), 'speed'), songValue(music(), 'endurance'), songValue(music(), 'power')]).toEqual([159, 2, 1]);
    });

    test('no damage song, and a mezz cure no behaviour casts', () => {
        expect(support().songs.map(s => s.kind).sort()).toEqual(['endurance', 'health', 'power', 'speed']);
        expect(support().unused.map(k => k.name)).toContain('Clarifying Harmonies');
    });
});

describe('hero guide', () => {
    const tank = () => reachOfBuild(getBuild('Hero', 'Sword and board tank')!, 24);
    const style = (name: string) => tank().styles.find(s => s.name === name);

    test('its table is what the rule gives', () => tableHolds('Hero', ['Sword and board tank', 'Large Weapons and Slam', 'Celtic Spear and Slam', 'Shield-heavy']));

    test('the styles it names are in reach at 24, and Slam is not', () => {
        for (const name of ['Horizon Blade', 'Incapacitate', 'Stun', 'Disable', 'Glowing Blade', 'Numb', 'Fire Blade', 'Taunting Blade']) expect(style(name)).toBeDefined();
        expect(style('Slam')).toBeUndefined();
        expect(style('Paralyze')).toBeUndefined();
    });

    test('Enervating Blade detaunts and Taunting Blade taunts, as their spells say', () => {
        const proc = (name: string) => getSpell(style(name)!.procs![0]!.spellId)!;
        expect(proc('Enervating Blade').value).toBeLessThan(0);
        expect(proc('Taunting Blade').value).toBeGreaterThan(0);
    });

    test('Shields 18 has every rank of Guard', () => {
        expect(tank().abilities).toContain('Guard III');
    });
});

describe('warrior guide', () => {
    test('its table is what the rule gives', () => tableHolds('Warrior', ['Hammer, Shields 42, high Parry', 'Hammer, Shields 50, less Parry', 'Sword two-hander, Shields 42']));

    test('on Axe, Plague taunts and Hoarfrost detaunts', () => {
        const r = reach('Warrior', 24, { Axe: 24, Shields: 18, Parry: 16 });
        const proc = (name: string) => getSpell(r.styles.find(s => s.name === name)!.procs![0]!.spellId)!;
        expect(proc('Plague').value).toBeGreaterThan(0);
        expect(proc('Hoarfrost').value).toBeLessThan(0);
    });
});

describe('healer guide', () => {
    const first = () => reachOfBuild(getBuild('Healer', 'Mending first')!, 24);

    test('its table is what the rule gives', () => tableHolds('Healer', ['Mending first', 'Augmentation healer', 'Pacification tri-spec', 'Full Augmentation solo']));

    test('Mending first heals up to Greater Reparation, then the instant; the mezz is baseline', () => {
        expect(names(first().heals).slice(-2)).toEqual(['Greater Reparation', 'Boon from Eir']);
        expect(first().cc?.spell.name).toBe('Sedate');
        expect(reach('Healer', 24, {}).cc?.spell.name).toBe('Sedate');
    });

    test('its rez is the 30 % one, the stun and mezz cure go unused, and no area mezz at Pacification 4', () => {
        expect(first().rez?.spell.name).toBe('Reception from Valhalla');
        const unused = first().unused.map(k => k.name);
        expect(unused).toContain('Halt Attack');
        expect(unused).toContain('Cleanse Mind');
        expect(first().known.some(k => k.name === 'Allay Area')).toBe(false);
    });
});

describe('shaman guide', () => {
    const buffer = () => reachOfBuild(getBuild('Shaman', 'Buffer healer')!, 24);

    test('its table is what the rule gives', () => tableHolds('Shaman', ['Buffer healer', 'Augmentation buffer', 'Cave nuker']));

    test('the kit is a healer that also fights, and assist goes in above position', () => {
        const kit = shaman();
        expect(kit.role).toBe('healer');
        const list = withCharacter(defaultBehaviors().healer, kit).map(b => b.name);
        expect(list.indexOf('assist')).toBe(list.indexOf('position') - 1);
        expect(list.indexOf('heal')).toBeLessThan(list.indexOf('assist'));
    });

    test('what it casts: the DoT, then a small bolt; a root; the 10 % rez', () => {
        expect(names(buffer().nukes)).toEqual(['Fungal Erosion', 'Fungal Pin']);
        expect(buffer().cc?.kind).toBe('root');
        expect(buffer().rez?.spell.name).toBe('Arrival from Valhalla');
    });

    test('Mending 15 needs 15 points and it has 1 spare', () => {
        const spent = specCost(1, 19) + specCost(1, 14) + specCost(1, 3);
        expect(earnedSpecPoints(10, 24) - spent).toBe(1);
        expect(specCost(1, 15) - specCost(1, 14)).toBe(15);
        expect(reach('Shaman', 24, { Mending: 15 }).rez?.spell.name).toBe('Reception from Valhalla');
    });
});

describe('skald guide', () => {
    const even = () => reachOfBuild(getBuild('Skald', 'Even songs and Hammer')!, 24);

    test('its table is what the rule gives', () => tableHolds('Skald', ['Even songs and Hammer', 'Battlesongs first', 'Hammer first']));

    test('the kit makes it melee, whose list sings and swings; a plain Skald is support', () => {
        expect(skald()).toEqual({ role: 'melee' });
        expect(roleForClass('Skald')).toBe('support');
        const list = defaultBehaviors().melee.map(b => b.name);
        expect(list).toContain('song');
        expect(list).toContain('assistMelee');
        expect(list).not.toContain('crowdControl');
    });

    test('no endurance song; Chant of the Battle at Battlesongs 22, the weaker Chant of the Charge at 16', () => {
        const damage = (r: ReturnType<typeof even>) => r.songs.find(s => s.kind === 'damage')?.spell.name;
        expect(even().songs.map(s => s.kind)).not.toContain('endurance');
        expect(damage(even())).toBe('Chant of the Battle');
        expect(damage(reachOfBuild(getBuild('Skald', 'Hammer first')!, 24))).toBe('Chant of the Charge');
    });

    test('its shout is a mezz the coordinator can assign, which the melee list never casts', () => {
        expect(even().cc?.kind).toBe('mezz');
        expect(even().cc?.spell.name).toBe('Crippling Shout');
    });
});

describe('spiritmaster guide', () => {
    const darkness = () => reachOfBuild(getBuild('Spiritmaster', 'Darkness caster')!, 24);

    test('its table is what the rule gives', () => tableHolds('Spiritmaster', ['Darkness caster', 'Suppression bomber', 'Summoning pet']));

    test('it nukes Silence Lifeforce, Cold, and mezzes with Hold Spirit', () => {
        expect(names(darkness().nukes)).toEqual(['Silence Lifeforce']);
        expect(darkness().nukes[0]!.damageType).toBe(11);
        expect(darkness().cc?.spell.name).toBe('Hold Spirit');
    });
});

describe('paladin guide', () => {
    const chants = () => reachOfBuild(getBuild('Paladin', 'Chants and sword')!, 24);

    test('its table is what the rule gives', () => tableHolds('Paladin', ['Chants and sword', 'Two-Handed hybrid', 'Thrust and chants']));

    test('the tank list has no song; the kit puts it above the fight', () => {
        expect(defaultBehaviors().tank.map(b => b.name)).not.toContain('song');
        const list = withCharacter(defaultBehaviors().tank, paladin()).map(b => b.name);
        expect(list.indexOf('song')).toBe(list.indexOf('tank') - 1);
    });

    test('it plays Chant of Persistence, from Chants 22', () => {
        expect(chants().songs.find(s => s.kind === 'endurance')?.spell.name).toBe('Chant of Persistence');
        expect(reach('Paladin', 24, { Chants: 22 }).songs.find(s => s.kind === 'endurance')?.spell.name).toBe('Chant of Persistence');
        expect(specCost(1, 24) - specCost(1, 22)).toBe(47);
    });

    test('its other chants have no behaviour', () => {
        for (const name of ["Crusader's Refreshment", "Crusader's Defense", 'Aura of Indestructability', 'Aggravate']) expect(chants().unused.map(k => k.name)).toContain(name);
    });
});

/** A group's buff plan at 24, each member on the named build. */
function planOf(members: [string, Role, string, string][]) {
    const reports = members.map(([name, role, className, build]) => ({
        name, role, isDead: false, effects: [],
        capabilities: { buffSpells: reachOfBuild(getBuild(className, build)!, 24).buffs.map(s => ({ name: s.spell.name, slot: s.slot, target: s.target, concentration: s.concentration })) },
    })) as unknown as MemberReport[];
    return (caster: string) => planBuffs(caster, reports);
}

const CAMELOT: [string, Role, string, string][] = [
    ['Galahad', 'tank', 'Paladin', 'Chants and sword'],
    ['Nimue', 'healer', 'Cleric', 'Healer'],
    ['Merlin', 'nuker', 'Sorcerer', 'Balanced body and mind'],
    ['Morgana', 'nuker', 'Cabalist', 'Matter'],
    ['Taliesin', 'nuker', 'Theurgist', 'Ice and earth'],
];

describe('cleric guide', () => {
    const healer = () => reachOfBuild(getBuild('Cleric', 'Healer')!, 24);

    test('its table is what the rule gives', () => tableHolds('Cleric', ['Healer', 'Buffer', 'Smite']));

    test('her instant is covered by Greater Revival, so the list leaves it out; no crowd control', () => {
        expect(names(healer().heals).at(-1)).toBe('Greater Revival');
        expect(names(healer().heals)).not.toContain('Gift of the Heavens');
        expect(healer().known.some(k => k.name === 'Gift of the Heavens')).toBe(true);
        expect(healer().cc).toBeNull();
    });

    test('her plan is 32 buffs for 232 concentration', () => {
        const tasks = planOf(CAMELOT)('Nimue');
        expect(tasks.length).toBe(32);
        expect(tasks.reduce((n, t) => n + t.spell.concentration, 0)).toBe(232);
    });
});

describe('sorcerer guide', () => {
    const balanced = () => reachOfBuild(getBuild('Sorcerer', 'Balanced body and mind')!, 24);

    test('its table is what the rule gives', () => tableHolds('Sorcerer', ['Balanced body and mind', 'Mind crowd control', 'Body nuker', 'Mind and matter charmer']));

    test('the mezz is baseline, and the kit is a nuker with a floor', () => {
        expect(balanced().cc?.spell.name).toBe('Greater Mesmerization');
        expect(reach('Sorcerer', 24, {}).cc?.spell.name).toBe('Greater Mesmerization');
        expect(sorcerer().role).toBe('nuker');
        expect(sorcerer().fight!.map(b => b.name)).toEqual(['assist']);
    });

    test('it opens on the DoT and never casts the cheaper Mind Scream', () => {
        expect(names(balanced().nukes)).toEqual(['Dissolving Smoke', 'Greater Essence Consumption']);
        expect(balanced().known.some(k => k.name === 'Lesser Mind Scream')).toBe(true);
    });

    test('Perception of Power goes on himself only: the Cleric provides the regen slot', () => {
        const plan = planOf(CAMELOT);
        expect(plan('Merlin').filter(t => t.spell.name === 'Perception of Power').map(t => t.target)).toEqual(['Merlin']);
        expect(plan('Nimue').filter(t => t.spell.slot === 'regen').map(t => t.target)).toContain('Morgana');
    });
});

describe('cabalist guide', () => {
    const matter = () => reachOfBuild(getBuild('Cabalist', 'Matter')!, 24);

    test('its table is what the rule gives', () => tableHolds('Cabalist', ['Matter', 'Spirit debuffer', 'Tri-spec']));

    test('two DoTs, then the lifedrain; a root; the debuff only at Spirit 22', () => {
        expect(names(matter().nukes)).toEqual(['Dissolving Smoke', 'Devolution', 'Greater Essence Consumption']);
        expect(matter().cc?.kind).toBe('root');
        expect(matter().known.some(k => k.name === 'Diminish Immunities')).toBe(false);
        expect(reachOfBuild(getBuild('Cabalist', 'Spirit debuffer')!, 24).known.some(k => k.name === 'Diminish Immunities')).toBe(true);
    });
});

describe('theurgist guide', () => {
    const ice = () => reachOfBuild(getBuild('Theurgist', 'Ice and earth')!, 24);

    test('its table is what the rule gives', () => tableHolds('Theurgist', ['Ice and earth', 'Earth and wind', 'Wind nuker']));

    test('one nuke, no DoT; the cheaper snare nuke goes unused; a root', () => {
        const r: Reach = ice();
        expect(names(r.nukes)).toEqual(['Ice Blast (Minor)']);
        expect(r.known.some(k => k.name === 'Ice Blast')).toBe(true);
        expect(r.cc?.kind).toBe('root');
    });

    test('the kit is a nuker with a floor', () => {
        expect(theurgist().role).toBe('nuker');
        expect(theurgist({ saveBelow: 30 }).fight!.map(b => b.name)).toEqual(['assist']);
    });
});

describe('thrifty', () => {
    const ctx = (manaPercent: number, threats: number[], maxMana = 100) => {
        const skipped: string[] = [];
        return { skipped, ctx: { threats: () => threats, me: () => ({ manaPercent, maxMana }), skip: (m: string) => { skipped.push(m); return false; } } as unknown as MemberContext };
    };
    const inner = { name: 'assist', run: () => true };

    test('below the floor with enemies about it holds back', async () => {
        const c = ctx(30, [1]);
        expect(await thrifty(inner, 40).run(c.ctx)).toBe(false);
        expect(c.skipped[0]).toContain('saving power');
    });

    test('above the floor, or with nobody to fight, or with no power at all, it runs', async () => {
        expect(await thrifty(inner, 40).run(ctx(50, [1]).ctx)).toBe(true);
        expect(await thrifty(inner, 40).run(ctx(30, []).ctx)).toBe(true);
        expect(await thrifty(inner, 40).run(ctx(0, [1], 0).ctx)).toBe(true);
    });
});
