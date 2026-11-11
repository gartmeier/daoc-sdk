import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { candidate, hasMezz, lineupPool, pairKey, pickLineup, writeLineup, type LineupCandidate } from './lineup';
import { applyLineup, lineupArg, loadGroup } from './roster';

describe('hasMezz', () => {
    test('a base-line mezz counts at the level, a spec-line one only by the build', () => {
        expect(hasMezz('Sorcerer', null)).toBe(true);
        expect(hasMezz('Healer', null)).toBe(true);
        expect(hasMezz('Bard', null)).toBe(true);
        expect(hasMezz('Mentalist', null)).toBe(false);
        expect(hasMezz('Mentalist', { className: 'Mentalist', name: 't', targets: [{ level: 24, specs: { Mentalism: 15 } }] })).toBe(true);
        expect(hasMezz('Cabalist', null)).toBe(false);
        expect(hasMezz('Druid', null)).toBe(false);
        expect(hasMezz('Armsman', null)).toBe(false);
    });

    test('an area mezz alone is no mezzer: the coordinator assigns crowd control only to a single-target mezz', () => {
        // Lugh's build reaches Paralyzing Veil (radius 350) in Light; the Sorcerer has single-target mezzes besides its area one.
        expect(hasMezz('Eldritch', { className: 'Eldritch', name: 't', targets: [{ level: 24, specs: { Light: 22, Mana: 9 } }] })).toBe(false);
        expect(hasMezz('Sorcerer', null)).toBe(true);
    });
});

const c = (bot: string, role: LineupCandidate['role'], cc = false, className = ''): LineupCandidate =>
    ({ bot, className, role, healer: role === 'healer', front: role === 'tank' || role === 'melee', cc });

describe('pickLineup with an any-of class', () => {
    // Midgard: Warrior, Healer, Shaman, Skald, Spiritmaster; Berserker, Thane, Runemaster on the bench.
    const pool = [c('thorgrim', 'tank', false, 'Warrior'), c('sigrid', 'healer', true, 'Healer'), c('ulfgar', 'healer', false, 'Shaman'),
        c('bragi', 'tank', false, 'Skald'), c('hrafna', 'nuker', true, 'Spiritmaster'), c('ragnar', 'melee', false, 'Berserker'),
        c('sigurd', 'tank', false, 'Thane'), c('gudrun', 'nuker', false, 'Runemaster')];

    test('a Warrior or a Thane plays, the one of them who played fewer', () => {
        // Round 130: hrafna, bragi, sigrid, gudrun, ulfgar, with no tank but the Skald.
        const played = { thorgrim: 9, sigurd: 8, sigrid: 1, ulfgar: 0, bragi: 0, hrafna: 0, ragnar: 9, gudrun: 0 };
        const choice = pickLineup({ pool, current: [], size: 5, played, classes: ['Healer', ['Warrior', 'Thane']] });
        expect(choice.lineup).toContain('sigrid');
        expect(choice.lineup).toContain('sigurd');
        expect(choice.lineup).not.toContain('thorgrim');
        expect(choice.why).toContain('Warrior/Thane sigurd');
    });

    test('met already by a class listed before it: no second one forced in', () => {
        const choice = pickLineup({ pool, current: [], size: 5, played: { thorgrim: 0 }, classes: ['Warrior', ['Warrior', 'Thane']] });
        expect(choice.lineup.filter(b => b === 'thorgrim' || b === 'sigurd')).toEqual(['thorgrim']);
    });
});

describe('pickLineup with required classes', () => {
    // Hibernia: Hero, Druid, Bard, Mentalist, Enchanter; Blademaster, Warden, Eldritch on the bench.
    const pool = [c('cuchulainn', 'tank', false, 'Hero'), c('brigid', 'healer', false, 'Druid'), c('oisin', 'support', true, 'Bard'),
        c('niamh', 'nuker', true, 'Mentalist'), c('ciaran', 'nuker', false, 'Enchanter'), c('fionn', 'melee', false, 'Blademaster'),
        c('aine', 'healer', false, 'Warden'), c('lugh', 'nuker', false, 'Eldritch')];

    test('one of each listed class plays, even when both have played most', () => {
        const played = { cuchulainn: 1, brigid: 9, oisin: 9, niamh: 1, ciaran: 1, fionn: 0, aine: 0, lugh: 0 };
        const choice = pickLineup({ pool, current: [], size: 5, played, classes: ['Druid', 'Bard'] });
        expect(choice.lineup).toContain('brigid');
        expect(choice.lineup).toContain('oisin');
        // The Warden, who played least, is no healer the line-up needs any more: the Druid is one.
        expect(choice.why).toContain('Druid brigid, Bard oisin');
    });

    test('a listed class nobody available plays is noted and skipped; the class name matches in any case', () => {
        const choice = pickLineup({ pool, current: [], size: 5, available: new Set(pool.map(p => p.bot).filter(b => b !== 'oisin')), classes: ['druid', 'Bard'] });
        expect(choice.lineup).toContain('brigid');
        expect(choice.lineup).not.toContain('oisin');
        expect(choice.why).toContain('no Bard available');
        expect(choice.lineup).toHaveLength(5);
    });

    test('on a tie in played rounds the bench mixes: whoever played least with those picked comes in', () => {
        // Rounds 129-156: the other six alternated as {lugh, niamh, fionn} and {aine, ciaran, cuchulainn}, 14 rounds each.
        const together: Record<string, number> = {};
        const trios = [['lugh', 'niamh', 'fionn'], ['aine', 'ciaran', 'cuchulainn']];
        for (const trio of trios) for (const a of [...trio, 'brigid', 'oisin']) for (const b of [...trio, 'brigid', 'oisin']) if (a < b) together[pairKey(a, b)] = 14;
        const played = Object.fromEntries(pool.map(p => [p.bot, 14]));
        const choice = pickLineup({ pool, current: ['brigid', 'oisin', 'lugh', 'niamh', 'fionn'], size: 5, played, together, classes: ['Druid', 'Bard'] });
        // fionn stays the front-liner (current); the nuker is ciaran, who shared no round with fionn; then niamh, who stays on the tie.
        expect([...choice.lineup].sort()).toEqual(['brigid', 'ciaran', 'fionn', 'niamh', 'oisin']);
        // Round 160: Hero, Warden and Blademaster had played least together with Druid and Bard, and nobody did damage. A nuker is a need.
        const fewest = { ...played, niamh: 15, ciaran: 15, lugh: 15 };
        const r160 = pickLineup({ pool, current: [], size: 5, played: fewest, together, classes: ['Druid', 'Bard'] });
        expect(r160.lineup.some(b => ['niamh', 'ciaran', 'lugh'].includes(b))).toBe(true);
        expect(r160.why).toMatch(/nuker (niamh|ciaran|lugh)/);
        // Without the counts the current trio stays, as it did.
        const old = pickLineup({ pool, current: ['brigid', 'oisin', 'lugh', 'niamh', 'fionn'], size: 5, played, classes: ['Druid', 'Bard'] });
        expect(old.lineup.sort()).toEqual(['brigid', 'fionn', 'lugh', 'niamh', 'oisin']);
    });
});

describe('pickLineup', () => {
    // Albion with its bench: Paladin, Cleric, Sorcerer, Cabalist, Theurgist; Armsman, Friar, Wizard.
    const pool = [c('galahad', 'tank'), c('nimue', 'healer'), c('merlin', 'nuker', true), c('morgana', 'nuker'), c('taliesin', 'nuker'),
        c('gawain', 'tank'), c('tuck', 'healer'), c('vivien', 'nuker')];
    const current = ['galahad', 'nimue', 'merlin', 'morgana', 'taliesin'];

    test('nobody played yet: the current five stay', () => {
        const r = pickLineup({ pool, current, leader: 'galahad' });
        expect(r.lineup).toEqual(current);
        expect(r.leader).toBe('galahad');
    });

    test('the fewest played come in, and the needs still hold', () => {
        const played = { galahad: 3, nimue: 3, merlin: 3, morgana: 3, taliesin: 3 };
        const r = pickLineup({ pool, current, leader: 'galahad', played });
        // Gawain front, Tuck healer, Vivien; the mezz is only Merlin's, and two more of the current fill.
        expect(r.lineup).toEqual(['galahad', 'merlin', 'gawain', 'tuck', 'vivien']);
        expect(r.leader).toBe('galahad');
        expect(r.why).toContain('cc merlin');
    });

    test('a leader who sits out hands over to the first front-liner', () => {
        const played = { galahad: 5, nimue: 1, merlin: 1, morgana: 1, taliesin: 1 };
        const r = pickLineup({ pool, current, leader: 'galahad', played });
        expect(r.lineup).not.toContain('galahad');
        expect(r.leader).toBe('gawain');
    });

    test('a bot not available never plays; a need nobody meets is skipped', () => {
        const r = pickLineup({ pool, current, available: new Set(['merlin', 'morgana', 'taliesin', 'vivien', 'galahad']) });
        expect(r.lineup.sort()).toEqual(['galahad', 'merlin', 'morgana', 'taliesin', 'vivien']);
        expect(r.why).toContain('no healer available');
    });

    test('fewer available than the size: all of them', () => {
        expect(pickLineup({ pool, current, available: new Set(['merlin', 'tuck']) }).lineup).toEqual(['merlin', 'tuck']);
    });
});

describe('group.json with a bench', () => {
    let root = '';
    const restores: (() => void)[] = [];
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'daoc-lineup-'));
        const cwd = spyOn(process, 'cwd').mockImplementation(() => root);
        restores.push(() => cwd.mockRestore());
        for (const [bot, cls] of [['tanky', 'Armsman'], ['heals', 'Cleric'], ['mezzy', 'Sorcerer'], ['nuky', 'Wizard'], ['subby', 'Friar']]) {
            mkdirSync(join(root, 'bots', bot!), { recursive: true });
            writeFileSync(join(root, 'bots', bot!, 'bot.env'), `BOT_USERNAME=${bot}\nCLASS=${cls}\nREALM=albion\n`);
        }
        mkdirSync(join(root, 'groups', 'g'), { recursive: true });
        writeFileSync(join(root, 'groups', 'g', 'group.json'), JSON.stringify({
            name: 'g', leader: 'tanky', members: [{ bot: 'tanky', role: 'tank' }, { bot: 'heals' }, { bot: 'mezzy' }], bench: [{ bot: 'nuky' }, { bot: 'subby' }],
        }));
    });
    afterEach(() => {
        while (restores.length) restores.pop()!();
        rmSync(root, { recursive: true, force: true });
    });
    const dir = () => join(root, 'groups', 'g');

    test('loadGroup reads the bench and refuses a bot on both lists', () => {
        const def = loadGroup(dir(), { lineup: undefined });
        expect(def.members.map(m => m.bot)).toEqual(['tanky', 'heals', 'mezzy']);
        expect(def.bench!.map(m => m.bot)).toEqual(['nuky', 'subby']);
        writeFileSync(join(dir(), 'group.json'), JSON.stringify({ members: [{ bot: 'tanky' }], bench: [{ bot: 'tanky' }] }));
        expect(() => loadGroup(dir())).toThrow('listed twice');
    });

    test('a line-up override picks from both lists; the leader stays only if it plays', () => {
        const def = loadGroup(dir(), { lineup: ['nuky', 'subby', 'heals'] });
        expect(def.members.map(m => m.bot)).toEqual(['nuky', 'subby', 'heals']);
        expect(def.bench!.map(m => m.bot)).toEqual(['tanky', 'mezzy']);
        expect(def.leader).toBe('nuky');
        expect(loadGroup(dir(), { lineup: ['heals', 'tanky'] }).leader).toBe('tanky');
        expect(() => loadGroup(dir(), { lineup: ['nobody'] })).toThrow('not in members or bench');
        expect(lineupArg(['bun', 'x.ts', '--lineup=a, b,c'])).toEqual(['a', 'b', 'c']);
        expect(lineupArg(['bun', 'x.ts'])).toBeUndefined();
        expect(applyLineup(loadGroup(dir(), { lineup: undefined }), ['mezzy']).members).toEqual([{ bot: 'mezzy' }]);
    });

    test('lineupPool reads class and role; writeLineup moves bots and keeps each entry', async () => {
        const def = loadGroup(dir(), { lineup: undefined });
        const pool = await lineupPool(def);
        expect(pool.map(p => [p.bot, p.role, p.cc])).toEqual([['tanky', 'tank', false], ['heals', 'healer', false], ['mezzy', 'nuker', true], ['nuky', 'nuker', false], ['subby', 'healer', false]]);
        writeLineup(dir(), ['mezzy', 'nuky', 'subby'], 'nuky');
        const file = JSON.parse(readFileSync(join(dir(), 'group.json'), 'utf-8'));
        expect(file).toEqual({ name: 'g', leader: 'nuky', members: [{ bot: 'mezzy' }, { bot: 'nuky' }, { bot: 'subby' }], bench: [{ bot: 'tanky', role: 'tank' }, { bot: 'heals' }] });
        expect(() => writeLineup(dir(), ['mezzy'], 'tanky')).toThrow('not in the line-up');
    });

    test('candidate: an entry role wins over the class', () => {
        expect(candidate({ bot: 'x', role: 'support' }, 'Armsman', null)).toMatchObject({ role: 'support', front: false });
    });
});
