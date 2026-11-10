import { describe, expect, test } from 'bun:test';
import { ClassReadLog, formatClassReads } from './class-score';
import { enemy, picture } from './fixtures';
import type { ClassGuess } from './class-read';

const guess = (classes: string[], role?: ClassGuess['role']): ClassGuess => ({ classes, p: classes.map(() => 1 / classes.length), ...(role ? { role } : {}), basis: ['race Dwarf'] });

describe('ClassReadLog', () => {
    test('right after: from first sight to the read that stayed; in its fight: from its first threat', () => {
        const log = new ClassReadLog();
        const T = 1_000_000;
        const at = (s: number, g: ClassGuess, threat = false) => log.sample(picture([], [enemy(7, 'midgard', { name: 'Dwarf', firstSeen: T, classGuess: g, threat })], {}, T + s * 1000));
        at(0, guess(['Warrior', 'Healer']));
        at(4, guess(['Healer']), true);
        at(6, guess(['Warrior']), true);
        at(12, guess(['Healer', 'Shaman'], 'healer'), true);
        // Another enemy, never scored: no truth for it.
        log.sample(picture([], [enemy(8, 'hibernia', { name: 'Celt', firstSeen: T, classGuess: guess(['Hero'], 'tank') })], {}, T));
        const r = log.result(new Map([['200:7', 'Healer']]))!;
        expect(r).toMatchObject({ enemies: 2, scored: 1, right: 1, rightIn10s: 0, fought: 1, rightIn10sOfFight: 1, roleRight: 1 });
        expect(r.rows.find(x => x.truth)).toMatchObject({ enemy: 'Dwarf #7', truth: 'Healer', rightAfterS: 12, rightInFightS: 8, right: true, role: 'healer', truthRole: 'healer', path: '0s Warrior, 4s Healer, 6s Warrior, 12s Healer' });
        expect(r.rows.find(x => !x.truth)).toMatchObject({ enemy: 'Celt #8', truth: null, rightAfterS: null, right: false });
        const md = formatClassReads(r).join('\n');
        expect(md).toContain('## Class reads');
        expect(md).toContain('| Dwarf #7 | Healer | Healer 0.5, Shaman 0.5 | healer | 12 s | 8 s |');
    });

    test('wrong at the end: never; no reads at all: no section', () => {
        const log = new ClassReadLog();
        expect(log.result(null)).toBeNull();
        log.sample(picture([], [enemy(7, 'midgard', { name: 'Troll', classGuess: guess(['Thane'], 'melee') })]));
        const r = log.result(new Map([['200:7', 'Warrior']]))!;
        expect(r.rows[0]).toMatchObject({ right: false, rightAfterS: null, roleRight: false, truthRole: 'tank' });
        expect(formatClassReads(r).join('\n')).toContain('| melee (is tank) | never |');
    });
});
