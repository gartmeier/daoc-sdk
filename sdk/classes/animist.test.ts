import { describe, expect, test } from 'bun:test';
import { dist } from '../group/battleground';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { animist, bomberPick, fnfPick, LEFT_BEHIND_MS, REACH_MARGIN, SUMMON_MARGIN, TURRET_REACH, turretPick, turretOffCc, turretSpot, turretState } from './animist';
import { knownThrough } from './summoner-fixtures';

describe('animist kit', () => {
    test('a nuker whose fight plants, places and bombs before the lifedrain, in every list', () => {
        expect(animist().role).toBe('nuker');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.nuker as Behavior<any>[], animist()).map(b => b.name);
            expect(list.indexOf('plantTurret')).toBeLessThan(list.indexOf('fnfTurret'));
            expect(list.indexOf('fnfTurret')).toBeLessThan(list.indexOf('bomb'));
            expect(list.indexOf('bomb')).toBeLessThan(list.indexOf('assist'));
        }
        expect(turretOffCc().side).toBe(true);
        expect(withCharacter(rvrBehaviors().nuker, animist()).map(b => b.name)).toContain('turretOffCc');
        const bare = withCharacter(rvrBehaviors().nuker, animist({ fnf: false, bombers: false })).map(b => b.name);
        expect(bare).not.toContain('fnfTurret');
        expect(bare).not.toContain('bomb');
    });

    test('a turret goes on the line to the focus, as near us as reaches it, never beyond the summon', () => {
        const me = { x: 0, y: 0 };
        const far = turretSpot(me, { x: 1500, y: 0 })!;
        expect(far.x).toBeCloseTo(1500 - (TURRET_REACH - REACH_MARGIN));
        expect(dist(far, { x: 1500, y: 0 })).toBeLessThanOrEqual(TURRET_REACH - REACH_MARGIN);
        expect(dist(far, me)).toBeLessThanOrEqual(TURRET_REACH - SUMMON_MARGIN);
        expect(turretSpot(me, { x: 0, y: 500 })).toEqual({ x: 0, y: 100 });
        expect(turretSpot(me, { x: 2000, y: 0 })).toBeNull();
        // A lord 600 above us: the ground reach left is sqrt(800² - 600²) ≈ 529, so the turret goes out 771 for one 1300 off,
        // and one 1500 off is beyond the summon's 920.
        const up = turretSpot({ ...me, z: 0 }, { x: 1300, y: 0, z: 600 })!;
        expect(up.x).toBeGreaterThan(760);
        expect(Math.hypot(1300 - up.x, 600)).toBeLessThanOrEqual(TURRET_REACH - REACH_MARGIN + 1);
        expect(turretSpot({ ...me, z: 0 }, { x: 1500, y: 0, z: 600 })).toBeNull();
        expect(turretSpot({ ...me, z: 0 }, { x: 300, y: 0, z: 900 })).toBeNull();
    });

    test('the turret: shoot what it reaches, no order in the grace, planted again after it or with none up', () => {
        const turret = { x: 0, y: 0 };
        expect(turretState(turret, { x: 800, y: 0 }, undefined, 10_000)).toBe('reach');
        expect(turretState(turret, { x: 1700, y: 0 }, undefined, 10_000)).toBe('wait');
        expect(turretState(turret, { x: 1700, y: 0 }, 10_000 - LEFT_BEHIND_MS + 1, 10_000)).toBe('wait');
        expect(turretState(turret, { x: 1700, y: 0 }, 10_000 - LEFT_BEHIND_MS, 10_000)).toBe('plant');
        expect(turretState(null, { x: 100, y: 0 }, undefined, 10_000)).toBe('plant');
        // In 3D: 800 on the ground and 700 up is 1063, out of reach (Lord Thidranki, 1222 from a turret read in reach).
        expect(turretState({ ...turret, z: 0 } as any, { x: 800, y: 0, z: 700 }, undefined, 10_000)).toBe('wait');
    });

    test("Arboreal: Forest's Sentry, the damage turret not the tangler, Spirit of Wrath", () => {
        expect(turretPick(knownThrough('Animist', 'Arboreal group', 24, 'SummonAnimistPet'))?.pick.spell.name).toBe("Forest's Sentry");
        expect(fnfPick(knownThrough('Animist', 'Arboreal group', 24, 'SummonAnimistFnF'))?.pick.spell.name).toBe("Forest's Spirit");
        expect(bomberPick(knownThrough('Animist', 'Arboreal group', 24, 'Bomber'))?.pick.spell.name).toBe('Spirit of Wrath');
    });

    test("Creeping: Grove's Agent, and no root, debuff or vent as a damage turret or bomber", () => {
        expect(turretPick(knownThrough('Animist', 'Creeping turret farm', 24, 'SummonAnimistPet'))?.pick.spell.name).toBe("Grove's Agent");
        const fnf = fnfPick(knownThrough('Animist', 'Creeping turret farm', 24, 'SummonAnimistFnF'))?.pick.spell.name;
        expect(['Spore Vent', 'Sporespawn Youngling', 'Tangler Youngling']).not.toContain(fnf);
        const bomber = bomberPick(knownThrough('Animist', 'Creeping turret farm', 24, 'Bomber'))?.pick.spell.name;
        expect(['Entangling Spirit', 'Dancing Flame', 'Constraining Spirit']).not.toContain(bomber);
    });
});
