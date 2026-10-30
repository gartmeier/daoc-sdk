import { describe, expect, test } from 'bun:test';
import { PacketReader } from './protocol/buffer';
import { headingFromDelta, headingTo, Mover, pointFromHeading } from './movement';

// Camelot Hills (zone 0, region 1): OffsetX 67, OffsetY 59, 8×8 blocks of 8192.
const CAMELOT = { regionId: 1, x: 574797, y: 530161, z: 2896 };

function harness() {
    let now = 1_000_000;
    const sent: Array<{ at: number; x: number; y: number; speed: number; zone: number; heading: number }> = [];
    const mover = new Mover({
        now: () => now,
        timer: false,
        send: (code, p) => {
            expect(code).toBe(0xA9);
            const r = new PacketReader(p);
            const x = r.f32le();
            const y = r.f32le();
            r.f32le();
            const speed = r.f32le();
            r.skip(8);
            const zone = r.u16();
            r.skip(4);
            const heading = r.u16();
            sent.push({ at: now, x, y, speed, zone, heading });
        },
    });
    const advance = (ms: number, step = 100) => {
        for (let t = 0; t < ms; t += step) {
            now += step;
            mover.pump();
        }
    };
    return { mover, sent, advance, now: () => now };
}

describe('heading math (world/Point2D.cs:95-140)', () => {
    test('0 = +Y, clockwise, 4096 per turn', () => {
        expect(headingFromDelta(0, 100)).toBe(0);
        expect(headingFromDelta(-100, 0)).toBe(1024);
        expect(headingFromDelta(0, -100)).toBe(2048);
        expect(headingFromDelta(100, 0)).toBe(3072);
    });

    test('pointFromHeading inverts headingTo', () => {
        for (const h of [0, 100, 1024, 2000, 3500, 4095]) {
            const p = pointFromHeading(1000, 1000, h, 500);
            expect(Math.abs(headingTo({ x: 1000, y: 1000 }, p) - h)).toBeLessThanOrEqual(1);
        }
    });
});

describe('Mover', () => {
    test('first update is immediate, idle cadence is <= 1 s', () => {
        const { mover, sent, advance } = harness();
        mover.snap(CAMELOT.regionId, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.zone).toBe(0);
        expect(sent[0]!.speed).toBe(0);
        advance(5000);
        const gaps = sent.slice(1).map((s, i) => s.at - sent[i]!.at);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(1000);
        expect(sent.length).toBeGreaterThanOrEqual(5);
    });

    test('moves in 200 ms steps at <= 0.9 × maxSpeed and arrives', () => {
        const { mover, sent, advance } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        const stops: string[] = [];
        mover.onStop(r => stops.push(r));
        mover.moveTo({ x: CAMELOT.x + 300, y: CAMELOT.y });
        advance(3000);
        expect(stops).toEqual(['arrived']);
        expect(Math.hypot(mover.x - (CAMELOT.x + 300), mover.y - CAMELOT.y)).toBeLessThanOrEqual(16);
        const moving = sent.filter(s => s.speed > 0);
        expect(moving.length).toBeGreaterThan(5);
        for (let i = 1; i < sent.length; i++) {
            const a = sent[i - 1]!;
            const b = sent[i]!;
            const dt = (b.at - a.at) / 1000;
            if (dt <= 0) continue;
            expect(Math.hypot(b.x - a.x, b.y - a.y) / dt).toBeLessThanOrEqual(191 * 0.9 + 1); // + f32 rounding of large coords
        }
        for (let i = 1; i < moving.length; i++) expect(moving[i]!.at - moving[i - 1]!.at).toBeGreaterThanOrEqual(190);
        expect(moving[0]!.heading).toBe(3072); // +X
        expect(sent.at(-1)!.speed).toBe(0);
    });

    test('follows waypoints in order', () => {
        const { mover, advance } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 100, y: CAMELOT.y + 100 }, { waypoints: [{ x: CAMELOT.x, y: CAMELOT.y + 100, z: CAMELOT.z + 50 }] });
        advance(500); // 86 units: still on the first (+Y) leg
        expect(mover.x).toBeCloseTo(CAMELOT.x, 0);
        expect(mover.z).toBeGreaterThan(CAMELOT.z);
        advance(2000);
        expect(mover.state().lastStopReason).toBe('arrived');
        expect(mover.z).toBeCloseTo(CAMELOT.z + 50, 0);
    });

    test('maxSpeed follows the 0xB6 percentage', () => {
        const { mover } = harness();
        mover.maxSpeedPercent = 150;
        expect(mover.maxSpeed).toBeCloseTo(286.5);
    });

    test('maxSpeed 0 (rooted) keeps the move pending in place with speed 0, then resumes', () => {
        const { mover, sent, advance } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        mover.maxSpeedPercent = 0;
        mover.moveTo({ x: CAMELOT.x + 300, y: CAMELOT.y });
        advance(1000);
        expect(mover.x).toBe(CAMELOT.x);
        expect(mover.moving).toBe(true);
        expect(sent.slice(1).every(s => s.speed === 0 && s.x === CAMELOT.x)).toBe(true);
        mover.maxSpeedPercent = 100;
        advance(3000);
        expect(mover.state().lastStopReason).toBe('arrived');
    });

    test('moveTo our own position keeps the current heading', () => {
        const { mover } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 1500, null);
        mover.moveTo({ x: CAMELOT.x, y: CAMELOT.y });
        expect(mover.heading).toBe(1500);
    });

    test('snap from a server correction stops the move and counts it', () => {
        const { mover, advance } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 1000, y: CAMELOT.y });
        advance(400);
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, 'teleported');
        expect(mover.moving).toBe(false);
        expect(mover.state().lastStopReason).toBe('teleported');
        expect(mover.state().correctionCount).toBe(1);
        expect(mover.x).toBe(CAMELOT.x);
    });

    test('never sends an unknown zone id', () => {
        const { mover, sent } = harness();
        mover.snap(9999, 1, 1, 0, 0, null);
        mover.start();
        expect(sent).toHaveLength(0);
    });

    test('holdPosition freezes XY (casting)', () => {
        const { mover, advance } = harness();
        mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        mover.holdPosition(1000);
        mover.moveTo({ x: CAMELOT.x + 500, y: CAMELOT.y });
        advance(800);
        expect(mover.x).toBe(CAMELOT.x);
        advance(1000);
        expect(mover.x).toBeGreaterThan(CAMELOT.x);
    });
});

describe('Mover with a ground source (sdk/ground.ts moverGround)', () => {
    type Ground = { z: number; swimming: boolean } | null;

    function groundHarness(ground: (regionId: number, x: number, y: number, zHint: number) => Ground) {
        let now = 1_000_000;
        const sent: Array<{ x: number; z: number; flags: number }> = [];
        const hints: number[] = [];
        const mover = new Mover({
            now: () => now,
            timer: false,
            ground: (r, x, y, zHint) => {
                hints.push(zHint);
                return ground(r, x, y, zHint);
            },
            send: (_code, p) => {
                const r = new PacketReader(p);
                const x = r.f32le();
                r.f32le();
                const z = r.f32le();
                r.skip(12); // speed, zSpeed, session id, object id
                r.u16(); // zone
                sent.push({ x, z, flags: r.u8() });
            },
        });
        const advance = (ms: number) => {
            for (let t = 0; t < ms; t += 100) {
                now += 100;
                mover.pump();
            }
        };
        return { mover, sent, hints, advance };
    }

    test('z follows the ground every step instead of the waypoint interpolation', () => {
        // A dip the waypoints don't know about: ground 30 lower between x+200 and x+600.
        const { mover, sent, advance } = groundHarness((_r, x) => ({ z: x > CAMELOT.x + 200 && x < CAMELOT.x + 600 ? 2870 : 2900, swimming: false }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 2950, 0, null);
        expect(mover.z).toBe(2900); // the server's z is re-grounded too
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 800, y: CAMELOT.y, z: 2950 });
        advance(5000);
        const dip = sent.filter(s => s.x > CAMELOT.x + 250 && s.x < CAMELOT.x + 550);
        expect(dip.length).toBeGreaterThan(0);
        expect(dip.every(s => s.z === 2870)).toBe(true);
        expect(mover.z).toBe(2900);
        expect(mover.moving).toBe(false);
    });

    test('a null ground keeps the interpolated z', () => {
        const { mover, advance } = groundHarness(() => null);
        mover.snap(1, CAMELOT.x, CAMELOT.y, 2900, 0, null);
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 400, y: CAMELOT.y, z: 3000 });
        advance(1100);
        expect(mover.z).toBeGreaterThan(2900);
        expect(mover.z).toBeLessThan(3000);
    });

    test('swimming sets the SWIMMING state flag alone and clears sitting', () => {
        const { mover, sent, advance } = groundHarness((_r, x) => (x > CAMELOT.x + 100 ? { z: 1789, swimming: true } : { z: 1830, swimming: false }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 1830, 0, null);
        mover.sitting = true;
        mover.start();
        expect(sent.at(-1)!.flags).toBe(0x10);
        mover.moveTo({ x: CAMELOT.x + 400, y: CAMELOT.y, z: 1814 });
        advance(3000);
        expect(mover.swimming).toBe(true);
        expect(mover.sitting).toBe(false);
        expect(mover.state().swimming).toBe(true);
        expect(sent.at(-1)!).toMatchObject({ z: 1789, flags: 0x04 });
        mover.sitting = true; // a sit request while swimming must not combine into DEAD (0x14)
        mover.sendUpdate();
        expect(sent.at(-1)!.flags).toBe(0x04);
    });

    test('a ladder hop keeps its interpolated z', () => {
        const { mover, advance } = groundHarness(() => ({ z: 2900, swimming: false }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 2900, 0, null);
        mover.start();
        // 20 units across, 300 up: a climb, not a walk.
        mover.moveTo({ x: CAMELOT.x + 20, y: CAMELOT.y, z: 3200 }, { tolerance: 1, speedFactor: 0.05 });
        advance(200);
        expect(mover.z).toBeGreaterThan(2900);
    });

    test('the current z is the layer hint', () => {
        const { mover, hints } = groundHarness(() => ({ z: 3500, swimming: false }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 3510, 0, null);
        expect(hints.at(-1)).toBe(3510);
        expect(mover.z).toBe(3500);
    });
});
