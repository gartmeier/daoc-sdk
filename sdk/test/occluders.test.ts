import { describe, expect, test } from 'bun:test';
import { FASTE } from '../group/siege';
import { decodeOccluders, encodeOccluders, firstHit, fixtureTriangles, getOccluderStore, indexOccluders, segmentBlocked } from '../occluders';
import { getTerrainStore } from '../terrain';
import { clientLineOfSight, clientLosMode, lineOfSight, sightLineClear, sightOf, terrainGround, type GroundAt, type SolidAt } from '../vision';

/** An OBJ line in buildnav's units: x, height, y, all / 32. */
const v = (x: number, y: number, z: number) => `v ${x / 32} ${z / 32} ${y / 32}`;

/** A wall across the x axis at y = 1000, from x -500 to 500, z 0 to 300: two triangles. */
const WALL = [
    'g object 5',
    v(-500, 1000, 0), v(500, 1000, 0), v(500, 1000, 300), v(-500, 1000, 300),
];

function objWith(...groups: string[][]): string {
    // Faces index vertices across the whole file from 1: number each group's after the ones before it.
    let base = 0;
    const out: string[] = [];
    for (const g of groups) {
        const verts = g.filter(l => l.startsWith('v '));
        out.push(...g.filter(l => !l.startsWith('f ')));
        for (const f of g.filter(l => l.startsWith('f '))) out.push('f ' + f.slice(2).split(' ').map(i => Number(i) + base).join(' '));
        base += verts.length;
    }
    return out.join('\n');
}

const wallGroup = [...WALL, 'f 1 2 3', 'f 1 3 4'];

function terrainGroup(): string[] {
    const lines = ['g object 0'];
    for (let j = 0; j < 33; j++) for (let i = 0; i < 33; i++) lines.push(v(i * 256, j * 256, 100));
    for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
        const a = j * 33 + i + 1;
        lines.push(`f ${a} ${a + 1} ${a + 34}`, `f ${a} ${a + 34} ${a + 33}`);
    }
    return lines;
}

function cylinderGroup(): string[] {
    const lines = ['g object 7'];
    for (let k = 0; k < 5; k++) {
        const a = (k / 5) * 2 * Math.PI;
        lines.push(v(2000 + 40 * Math.cos(a), 2000 + 40 * Math.sin(a), -5), v(2000 + 40 * Math.cos(a), 2000 + 40 * Math.sin(a), 100));
    }
    for (let k = 0; k < 5; k++) {
        const a = 2 * k + 1, b = ((2 * k + 2) % 10) + 1;
        lines.push(`f ${a} ${a + 1} ${b + 1}`, `f ${a} ${b + 1} ${b}`);
    }
    return lines;
}

const ladderPad = ['g ladder_pad_0', v(0, 0, 50), v(64, 0, 50), v(64, 64, 50), v(0, 64, 50), 'f 1 2 3', 'f 1 3 4'];

describe('occluders: from buildnav OBJ', () => {
    test('keeps the fixtures, drops the terrain, the tree cylinders and the ladder pads', () => {
        const tris = fixtureTriangles(objWith(terrainGroup(), wallGroup, cylinderGroup(), ladderPad));
        expect(tris.length).toBe(2 * 9);
        // x, y, z in game units, the OBJ's height back in z.
        expect(Array.from(tris.subarray(0, 9))).toEqual([-500, 1000, 0, 500, 1000, 0, 500, 1000, 300]);
    });

    test('encode/decode round trip, and a file that is not ours throws', () => {
        const tris = fixtureTriangles(objWith(wallGroup));
        const o = decodeOccluders(encodeOccluders(tris));
        expect(Array.from(o.tris)).toEqual(Array.from(tris));
        expect(() => decodeOccluders(new Uint8Array(16))).toThrow();
    });
});

describe('occluders: segments through triangles', () => {
    const o = indexOccluders(fixtureTriangles(objWith(wallGroup)));

    test('through the wall blocks, over it or past its end does not', () => {
        expect(segmentBlocked(o, { x: 0, y: 0, z: 100 }, { x: 0, y: 2000, z: 100 })).toBe(true);
        expect(segmentBlocked(o, { x: 0, y: 2000, z: 100 }, { x: 0, y: 0, z: 100 })).toBe(true);
        expect(segmentBlocked(o, { x: 0, y: 0, z: 400 }, { x: 0, y: 2000, z: 350 })).toBe(false);
        expect(segmentBlocked(o, { x: 700, y: 0, z: 100 }, { x: 700, y: 2000, z: 100 })).toBe(false);
        // Short of the wall.
        expect(segmentBlocked(o, { x: 0, y: 0, z: 100 }, { x: 0, y: 900, z: 100 })).toBe(false);
    });

    test('a long diagonal finds the wall across many grid cells', () => {
        expect(segmentBlocked(o, { x: -3000, y: -2000, z: 150 }, { x: 3000, y: 4000, z: 150 })).toBe(true);
        expect(segmentBlocked(o, { x: 3000, y: 4000, z: 150 }, { x: -3000, y: -2000, z: 150 })).toBe(true);
    });

    test('an end touching the wall does not block itself', () => {
        expect(segmentBlocked(o, { x: 0, y: 1004, z: 100 }, { x: 0, y: 2000, z: 100 })).toBe(false);
        expect(segmentBlocked(o, { x: 0, y: 996, z: 100 }, { x: 0, y: 2000, z: 100 })).toBe(false);
        expect(firstHit(o, { x: 0, y: 900, z: 100 }, { x: 0, y: 2000, z: 100 })!.at).toBeCloseTo(100 / 1100);
    });

    test('an empty set blocks nothing', () => {
        expect(segmentBlocked(indexOccluders(new Float32Array(0)), { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 })).toBe(false);
    });
});

describe('vision: fixtures in the sight line', () => {
    const flat: GroundAt = () => 0;
    const o = indexOccluders(fixtureTriangles(objWith(wallGroup)));
    const wall: SolidAt = (_r, a, b) => segmentBlocked(o, a, b);

    test('lineOfSight: the wall blocks, terrain alone does not', () => {
        expect(lineOfSight(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 }, flat, undefined, wall)).toBe(false);
        expect(lineOfSight(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 2000, z: 0 }, flat, undefined, null)).toBe(true);
        // From on top of it (eyes at 360): clear.
        expect(lineOfSight(1, { x: 0, y: 0, z: 300 }, { x: 0, y: 2000, z: 300 }, flat, undefined, wall)).toBe(true);
    });

    test('a caller with its own ground gets no fixtures unless it passes them', () => {
        expect(sightLineClear(1, { x: 0, y: 0, z: 60 }, { x: 0, y: 2000, z: 50 }, { stepUnits: 64, clearance: 0 }, flat)).toBe(true);
        expect(sightOf({ regionId: 1, x: 0, y: 0, z: 0, heading: 0 }, { x: 0, y: 2000, z: 0 }, { mode: 'human', awareRadius: 500, fovDegrees: 100, eyeHeight: 60, targetHeight: 50, stepUnits: 64, clearance: 0, noticeMs: 0 }, flat, wall)).toBe('blocked');
    });

    test('DAOC_LOS: clear, terrain or full', () => {
        expect(clientLosMode('clear')).toBe('clear');
        expect(clientLosMode('off')).toBe('clear');
        expect(clientLosMode('0')).toBe('clear');
        expect(clientLosMode('terrain')).toBe('terrain');
        expect(clientLosMode('TERRAIN')).toBe('terrain');
        expect(clientLosMode(undefined)).toBe('full');
        expect(clientLosMode('on')).toBe('full');
        expect(clientLineOfSight('clear')).toBeUndefined();
    });
});

// The Faste on the real client geometry (scripts/build-occluders.ts from buildnav's zone252.obj). The walls have
// merlons along their outer edge with gaps between them open down to the wall-walk (z 3975, merlons to 4055).
const faste = getTerrainStore().forZone(252) !== null && getOccluderStore().forZone(252) !== null;
const post = (label: string) => FASTE.targets.find(t => t.label === label)!.at;
const KEEP_CENTRE = { x: 33100, y: 38250 };
const GATE_OUT = { x: 34650, y: 38250, z: 3722 };
const OUTSIDE = { x: 35500, y: 38250, z: 3570 };
const COURTYARD = { x: 33100, y: 38250, z: 3722 };
const ground = (x: number, y: number) => ({ x, y, z: getTerrainStore().at(252, x, y)!.z });
/** `d` out from a wall post, away from the keep's centre (negative: in toward it). */
const outFrom = (at: { x: number; y: number }, d: number) => {
    const l = Math.hypot(at.x - KEEP_CENTRE.x, at.y - KEEP_CENTRE.y);
    return ground(at.x + ((at.x - KEEP_CENTRE.x) / l) * d, at.y + ((at.y - KEEP_CENTRE.y) / l) * d);
};
const terrainOnly = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => lineOfSight(252, a, b, terrainGround, undefined, null);
const WALL_CASTERS = ['wall-e-n', 'wall-e-s', 'wall-se', 'wall-n', 'wall-sw', 'wall-nw'];
const ROOF_ARCHERS = ['roof-e', 'roof-n', 'roof-s'];

describe.skipIf(!faste)('the Faste: walls block the guards on them', () => {
    test('no wall caster sees the foot of its wall outside (the terrain alone did)', () => {
        for (const label of WALL_CASTERS) {
            for (const d of [150, 250]) {
                const below = outFrom(post(label), d);
                expect({ label, d, los: lineOfSight(252, post(label), below) }).toEqual({ label, d, los: false });
                expect({ label, d, los: lineOfSight(252, below, post(label)) }).toEqual({ label, d, los: false });
            }
        }
        expect(terrainOnly(post('wall-e-n'), outFrom(post('wall-e-n'), 250))).toBe(true);
    });

    test('the east wall casters and the raid at the gate or outside it: no sight either way', () => {
        for (const label of ['wall-e-n', 'wall-e-s', 'wall-se']) {
            for (const at of [GATE_OUT, OUTSIDE]) {
                expect({ label, at, los: lineOfSight(252, post(label), at) }).toEqual({ label, at, los: false });
                expect({ label, at, los: lineOfSight(252, at, post(label)) }).toEqual({ label, at, los: false });
                expect(terrainOnly(at, post(label))).toBe(true);
            }
        }
    });

    test('the walls are mostly blocked, with a few lines out through the gaps between the merlons', () => {
        let seen = 0, all = 0;
        for (const label of WALL_CASTERS) {
            let mine = 0, n = 0;
            for (let a = -60; a <= 60; a += 6) for (let d = 300; d <= 1500; d += 100) {
                const at = post(label);
                const base = Math.atan2(at.y - KEEP_CENTRE.y, at.x - KEEP_CENTRE.x) + (a * Math.PI) / 180;
                const q = ground(at.x + Math.cos(base) * d, at.y + Math.sin(base) * d);
                if (Math.hypot(q.x - KEEP_CENTRE.x, q.y - KEEP_CENTRE.y) < Math.hypot(at.x - KEEP_CENTRE.x, at.y - KEEP_CENTRE.y) + 100) continue;
                n++;
                if (lineOfSight(252, at, q)) mine++;
            }
            expect({ label, share: mine / n < 0.3 }).toEqual({ label, share: true });
            seen += mine;
            all += n;
        }
        expect(seen / all).toBeLessThan(0.1);
        expect(seen).toBeGreaterThan(0);
    });

    test('from the courtyard: the east and north wall casters are in sight, the west ones are not', () => {
        for (const label of ['wall-e-n', 'wall-e-s', 'wall-se', 'wall-n']) expect({ label, los: lineOfSight(252, COURTYARD, post(label)) }).toEqual({ label, los: true });
        for (const label of ['wall-sw', 'wall-nw']) expect({ label, los: lineOfSight(252, COURTYARD, post(label)) }).toEqual({ label, los: false });
    });

    test('the roof archers see nothing in the courtyard, and the raid on the roof sees them', () => {
        for (const label of ROOF_ARCHERS) {
            for (const at of [COURTYARD, ground(33300, 37800), ground(33300, 38800), ground(32850, 38200)]) {
                expect({ label, at, los: lineOfSight(252, post(label), at) }).toEqual({ label, at, los: false });
            }
            expect({ label, los: lineOfSight(252, FASTE.roof, post(label)) }).toEqual({ label, los: true });
        }
    });

    test('the client answers 0xD0 with the walls, or without them under DAOC_LOS=terrain', () => {
        const full = clientLineOfSight('full')!;
        const terrain = clientLineOfSight('terrain')!;
        expect(full(252, post('wall-e-n'), GATE_OUT)).toBe(false);
        expect(terrain(252, post('wall-e-n'), GATE_OUT)).toBe(true);
    });
});
