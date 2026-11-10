import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { candidate, hasMezz, lineupPool, pickLineup, writeLineup, type LineupCandidate } from './lineup';
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
});

const c = (bot: string, role: LineupCandidate['role'], cc = false): LineupCandidate =>
    ({ bot, className: '', role, healer: role === 'healer', front: role === 'tank' || role === 'melee', cc });

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
