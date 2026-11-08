import { describe, expect, test } from 'bun:test';
import { PacketReader } from './protocol/buffer';
import { headingFromDelta, headingTo, Mover, pointFromHeading, rampedMoveMs, RUN_ACCEL, RUN_DECEL } from './movement';

// Camelot Hills (zone 0, region 1): OffsetX 67, OffsetY 59, 8×8 blocks of 8192.
const CAMELOT = { regionId: 1, x: 574797, y: 530161, z: 2896 };

function harness() {
    let now = 1_000_000;
    const sent: Array<{ at: number; x: number; y: number; speed: number; zone: number; heading: number; headingFlags: number }> = [];
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
            const raw = r.u16();
            sent.push({ at: now, x, y, speed, zone, heading: raw & 0xFFF, headingFlags: raw & 0xF000 });
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

    test('moves in 200 ms steps at full maxSpeed and arrives', () => {
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
            expect(Math.hypot(b.x - a.x, b.y - a.y) / dt).toBeLessThanOrEqual(191 + 1); // + f32 rounding of large coords
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

    test('maxSwimSpeed is the real client formula (game.dll 0x4388d9): 85 base, the 0xB6 byte on top, capped at 170, scaled by the percentage', () => {
        const { mover } = harness();
        expect(mover.maxSwimSpeed).toBe(85);
        mover.waterSpeedPercent = 15;
        expect(mover.maxSwimSpeed).toBe(97);
        mover.waterSpeedPercent = 100;
        expect(mover.maxSwimSpeed).toBe(170);
        mover.waterSpeedPercent = 200;
        expect(mover.maxSwimSpeed).toBe(170);
        mover.waterSpeedPercent = 0;
        mover.maxSpeedPercent = 130;
        expect(mover.maxSwimSpeed).toBe(110);
        mover.maxSpeedPercent = 0;
        expect(mover.maxSwimSpeed).toBe(0);
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

describe('Mover speed ramp (RUN_ACCEL, RUN_DECEL: a real client, bots/Movewatch/runs/at-191b.jsonl)', () => {
    const start = () => {
        const h = harness();
        h.mover.snap(1, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        h.mover.start();
        return h;
    };
    /** Speeds of the 0xA9 sent during the move, one per 200 ms step, the start update left out. */
    const stepSpeeds = (sent: Array<{ speed: number }>) => sent.slice(1).map(s => Math.round(s.speed));

    test('speeds up from 0 by 50 per 200 ms update to 191, like Vue (38, 88, 139, 190, 191)', () => {
        const { mover, sent, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(1400);
        expect(stepSpeeds(sent)).toEqual([50, 100, 150, 191, 191, 191, 191]);
        // 73 units to full speed (191² / 500), then 191 per second.
        expect(mover.x - CAMELOT.x).toBeCloseTo((191 * 191) / (2 * RUN_ACCEL) + 191 * (1.4 - 191 / RUN_ACCEL), 0);
    });

    test('each step covers the distance its speeds give, and the 0xA9 carries the speed at its end', () => {
        const { mover, sent, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(800);
        const moved = sent.slice(1);
        for (let i = 1; i < moved.length; i++) {
            const a = moved[i - 1]!;
            const b = moved[i]!;
            // The mean of the two speeds, a little more on the step that reaches 191 part way.
            expect(b.x - a.x).toBeGreaterThanOrEqual(((a.speed + b.speed) / 2) * 0.2 - 0.1);
            expect(b.x - a.x).toBeLessThanOrEqual(Math.max(a.speed, b.speed) * 0.2 + 0.1);
            if (b.speed < 191) expect(b.x - a.x).toBeCloseTo(((a.speed + b.speed) / 2) * 0.2, 0);
        }
    });

    test('slows down by 100 per update before the end and stops at its rest point, tolerance / 2 short', () => {
        const { mover, sent, advance } = start();
        const stops: string[] = [];
        mover.onStop(r => stops.push(r));
        mover.moveTo({ x: CAMELOT.x + 600, y: CAMELOT.y }, { tolerance: 16 });
        let closest = Infinity;
        for (let t = 0; t < 5000 && mover.moving; t += 100) {
            advance(100);
            closest = Math.min(closest, CAMELOT.x + 600 - mover.x);
        }
        expect(stops).toEqual(['arrived']);
        expect(CAMELOT.x + 600 - mover.x).toBeCloseTo(8, 1);
        expect(closest).toBeGreaterThan(7.9); // never past it
        const speeds = stepSpeeds(sent).filter(v => v > 0);
        const tail = speeds.slice(speeds.lastIndexOf(191) + 1);
        // 191 → 0 in 0.38 s: one or two updates on the way down, none dropping much more than RUN_DECEL allows.
        expect(tail.length).toBeGreaterThanOrEqual(1);
        expect(tail.length).toBeLessThanOrEqual(2);
        let prev = 191;
        for (const v of tail) {
            expect(prev - v).toBeLessThanOrEqual(RUN_DECEL * 0.2 + 15);
            prev = v;
        }
        expect(sent.at(-1)!.speed).toBe(0);
    });

    test('arrives within tolerance and never past the target, for short and long moves and any tolerance', () => {
        for (const tolerance of [1, 16, 50, 200]) {
            for (const distance of [5, 20, 40, 75, 150, 333, 1000]) {
                const { mover, advance } = start();
                mover.moveTo({ x: CAMELOT.x + distance, y: CAMELOT.y }, { tolerance });
                for (let t = 0; t < 10_000 && mover.moving; t += 100) {
                    advance(100);
                    expect(mover.x).toBeLessThanOrEqual(CAMELOT.x + distance);
                }
                expect(mover.moving).toBe(false);
                expect(mover.lastStopReason).toBe('arrived');
                expect(CAMELOT.x + distance - mover.x).toBeLessThanOrEqual(tolerance);
                expect(mover.speed).toBe(0);
            }
        }
    });

    test('a move re-issued mid-run keeps its speed, also round a corner', () => {
        const { mover, sent, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(1000);
        expect(mover.speed).toBe(191);
        mover.moveTo({ x: mover.x + 500, y: mover.y + 1500 });
        const before = sent.length;
        advance(400);
        expect(sent.slice(before).every(s => s.speed === 191)).toBe(true);
        // The same once a slow-down has begun: it picks up from the speed it had.
        mover.moveTo({ x: mover.x + 40, y: mover.y });
        advance(200);
        const slowed = mover.speed;
        expect(slowed).toBeGreaterThan(0);
        expect(slowed).toBeLessThan(191);
        mover.moveTo({ x: mover.x + 2000, y: mover.y });
        advance(200);
        expect(mover.speed).toBeCloseTo(Math.min(191, slowed + RUN_ACCEL * 0.2), 0);
    });

    test('brake() slows to rest along the route in 0.38 s and 36 units, like Vue (191, 90, 0), and ends as stopped', () => {
        const { mover, sent, advance } = start();
        const stops: string[] = [];
        mover.onStop(r => stops.push(r));
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(2000);
        const x0 = mover.x;
        const before = sent.length;
        mover.brake();
        expect(mover.moving).toBe(true);
        advance(600);
        expect(mover.moving).toBe(false);
        expect(stops).toEqual(['stopped']);
        expect(mover.x - x0).toBeGreaterThan(30);
        expect(mover.x - x0).toBeLessThanOrEqual((191 * 191) / (2 * RUN_DECEL));
        expect(sent.slice(before).map(s => Math.round(s.speed))).toEqual([91, 0, 0]);
    });

    test('brake() round a corner keeps to the route', () => {
        const { mover, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 200, y: CAMELOT.y + 2000 }, { waypoints: [{ x: CAMELOT.x + 200, y: CAMELOT.y, z: CAMELOT.z }] });
        for (let t = 0; t < 3000 && CAMELOT.x + 200 - mover.x > 10; t += 100) advance(100);
        mover.brake();
        advance(600);
        expect(mover.moving).toBe(false);
        expect(mover.x).toBeCloseTo(CAMELOT.x + 200, 0);
        expect(mover.y - CAMELOT.y).toBeGreaterThan(5);
        expect(mover.y - CAMELOT.y).toBeLessThan(36);
    });

    test('stop() and a cast still stop dead, and the next move starts from 0', () => {
        const { mover, sent, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(1000);
        mover.stop();
        expect(mover.moving).toBe(false);
        expect(sent.at(-1)!.speed).toBe(0);
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(200);
        expect(mover.speed).toBeCloseTo(50, 5);
        mover.holdPosition(300);
        const held = mover.x;
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y });
        advance(300);
        expect(mover.speed).toBe(0);
        expect(mover.x).toBe(held);
        advance(200);
        expect(mover.speed).toBeCloseTo(50, 5);
    });

    test('a lower limit takes effect at once, a higher one is ramped up to', () => {
        const { mover, advance } = start();
        mover.moveTo({ x: CAMELOT.x + 3000, y: CAMELOT.y });
        advance(1000);
        mover.maxSpeedPercent = 50;
        advance(200);
        expect(mover.speed).toBeCloseTo(95.5, 5);
        mover.maxSpeedPercent = 150;
        advance(200);
        expect(mover.speed).toBeCloseTo(145.5, 5);
    });

    test('rampedMoveMs: distance over speed plus the ramp, and short moves never reach top speed', () => {
        expect(rampedMoveMs(0, 191)).toBe(0);
        expect(rampedMoveMs(100, 0)).toBe(Infinity);
        // 1000 units: 1000 / 191 + 191 / 500 + 191 / 1000 = 5.236 + 0.573 s.
        expect(rampedMoveMs(1000, 191)).toBeCloseTo((1000 / 191 + 191 / (2 * RUN_ACCEL) + 191 / (2 * RUN_DECEL)) * 1000, 3);
        expect(rampedMoveMs(1000, 191, 191)).toBeCloseTo((1000 / 191 + 191 / (2 * RUN_DECEL)) * 1000, 3);
        // 30 units: peak sqrt(2 · 30 · 250 · 500 / 750) = 100.
        expect(rampedMoveMs(30, 191)).toBeCloseTo((100 / RUN_ACCEL + 100 / RUN_DECEL) * 1000, 3);
        // The mover takes as long, to the 200 ms step.
        for (const distance of [30, 150, 600]) {
            const { mover, advance, now } = start();
            const t0 = now();
            mover.moveTo({ x: CAMELOT.x + distance, y: CAMELOT.y }, { tolerance: 1 });
            while (mover.moving) advance(100);
            expect(Math.abs(now() - t0 - rampedMoveMs(distance - 0.5, 191))).toBeLessThanOrEqual(200);
        }
    });
});

describe('Mover with a ground source (sdk/ground.ts moverGround)', () => {
    type Ground = { z: number; swimming: boolean } | null;

    function groundHarness(ground: (regionId: number, x: number, y: number, zHint: number) => Ground) {
        let now = 1_000_000;
        const sent: Array<{ x: number; z: number; flags: number; zSpeed: number; onGround: boolean; fallFlags: number }> = [];
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
                r.f32le(); // speed
                const zSpeed = r.f32le();
                r.skip(4); // session id, object id
                r.u16(); // zone
                const flags = r.u8();
                r.u8();
                const fallFlags = r.u16();
                const onGround = (r.u16() & 0x1000) !== 0; // HEADING_ON_GROUND
                sent.push({ x, z, flags, zSpeed, onGround, fallFlags });
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
        const dip = sent.filter(s => s.x > CAMELOT.x + 300 && s.x < CAMELOT.x + 550); // the first 50 or so units fall into it
        expect(dip.length).toBeGreaterThan(0);
        expect(dip.every(s => s.z === 2870)).toBe(true);
        expect(mover.z).toBe(2900);
        expect(mover.moving).toBe(false);
    });

    describe('falls off a downhill slope like a real client (FALL_GRAVITY)', () => {
        // Flat at 3000 up to x+200, then down 1 per unit to 2400 at x+800, then flat.
        const slope = (_r: number, x: number) => ({ z: 3000 - Math.min(600, Math.max(0, x - (CAMELOT.x + 200))), swimming: false });

        test('in the air downhill with zSpeed < 0, never under the ground, landing at vz 0; short hops keep the on-ground bit', () => {
            const { mover, sent, advance } = groundHarness(slope);
            mover.snap(1, CAMELOT.x, CAMELOT.y, 3000, 0, null);
            mover.start();
            mover.moveTo({ x: CAMELOT.x + 1200, y: CAMELOT.y });
            advance(8000);
            const down = sent.filter(s => s.x > CAMELOT.x + 250 && s.x < CAMELOT.x + 800);
            const air = down.filter(s => s.z > slope(1, s.x).z + 3);
            expect(air.length).toBeGreaterThan(down.length / 3);
            expect(air.every(s => s.zSpeed < 0)).toBe(true);
            // Hops on a 1:1 slope stay within ON_GROUND_MAX_HEIGHT: a real client keeps HEADING_ON_GROUND there.
            expect(air.every(s => s.z - slope(1, s.x).z <= 30)).toBe(true);
            expect(sent.every(s => s.onGround && s.fallFlags === 0)).toBe(true);
            expect(sent.every(s => s.z >= slope(1, s.x).z - 0.2)).toBe(true); // x is an f32: 1/16 unit out here
            expect(Math.min(...sent.map(s => s.zSpeed))).toBeGreaterThan(-500); // the fall-damage threshold
            expect(mover.z).toBe(2400);
            expect(mover.vz).toBe(0);
            expect(sent.at(-1)).toMatchObject({ z: 2400, zSpeed: 0, onGround: true });
        });

        test('a real fall (over 30 up) clears the on-ground heading bit until it lands', () => {
            const cliff = (_r: number, x: number) => ({ z: x > CAMELOT.x + 100 ? 2700 : 3000, swimming: false });
            const { mover, sent, advance } = groundHarness(cliff);
            mover.snap(1, CAMELOT.x, CAMELOT.y, 3000, 0, null);
            mover.start();
            mover.moveTo({ x: CAMELOT.x + 600, y: CAMELOT.y });
            advance(4000);
            const off = sent.filter(s => !s.onGround);
            expect(off.length).toBeGreaterThan(0);
            expect(off.every(s => s.zSpeed < 0 && s.z - 2700 > 0)).toBe(true);
            expect(sent.at(-1)).toMatchObject({ z: 2700, zSpeed: 0, onGround: true });
            expect(mover.falling).toBe(false);
        });

        test('uphill and on the flat z is the ground and zSpeed 0', () => {
            const { mover, sent, advance } = groundHarness(slope);
            mover.snap(1, CAMELOT.x + 1000, CAMELOT.y, 2400, 0, null);
            mover.start();
            mover.moveTo({ x: CAMELOT.x, y: CAMELOT.y });
            advance(8000);
            expect(sent.length).toBeGreaterThan(20);
            expect(sent.every(s => Math.abs(s.z - slope(1, s.x).z) < 0.2 && s.zSpeed === 0 && s.onGround)).toBe(true);
        });

        test('a stop in the air keeps falling, with an update every step, until it lands', () => {
            const cliff = (_r: number, x: number) => ({ z: x > CAMELOT.x + 100 ? 2700 : 3000, swimming: false });
            const { mover, sent, advance } = groundHarness(cliff);
            mover.snap(1, CAMELOT.x, CAMELOT.y, 3000, 0, null);
            mover.start();
            mover.moveTo({ x: CAMELOT.x + 140, y: CAMELOT.y }, { tolerance: 1 });
            advance(1400); // 1.3 s with the speed-up and slow-down, over the edge at about 0.9 s
            expect(mover.moving).toBe(false);
            expect(mover.z).toBeGreaterThan(2700);
            expect(mover.vz).toBeLessThan(0);
            const before = sent.length;
            advance(1000);
            expect(sent.length - before).toBeGreaterThanOrEqual(2);
            expect(mover.z).toBe(2700);
            expect(mover.vz).toBe(0);
            expect(sent.at(-1)).toMatchObject({ z: 2700, zSpeed: 0, onGround: true });
        });
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

    test('swimming moves at the swim speed and is back to the run speed on land', () => {
        const { mover, advance } = groundHarness((_r, x) => (x > CAMELOT.x + 100 && x < CAMELOT.x + 400 ? { z: 1789, swimming: true } : { z: 1830, swimming: false }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 1830, 0, null);
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y, z: 1830 }, { speedFactor: 1 });
        advance(1200); // on land for the first 100 units (118 at 1 s with the speed-up), so the water starts on the way
        expect(mover.swimming).toBe(true);
        expect(mover.speed).toBe(85);
        const before = mover.x;
        advance(1000);
        expect(mover.x - before).toBeCloseTo(85, 0);
        advance(3000);
        expect(mover.swimming).toBe(false);
        expect(mover.speed).toBe(191);
    });

    test('speedFactor scales swimming like running', () => {
        const { mover, advance } = groundHarness(() => ({ z: 1789, swimming: true }));
        mover.snap(1, CAMELOT.x, CAMELOT.y, 1789, 0, null);
        mover.start();
        mover.moveTo({ x: CAMELOT.x + 2000, y: CAMELOT.y, z: 1789 }, { speedFactor: 0.9 });
        advance(1000);
        // 76.5 units/s, less the 0.31 s speed-up at RUN_ACCEL: 76.5 - 76.5² / 500.
        expect(mover.speed).toBeCloseTo(76.5, 5);
        expect(mover.x - CAMELOT.x).toBeCloseTo(76.5 - (76.5 * 76.5) / (2 * RUN_ACCEL), 0);
    });

    test('dead overrides swimming and sitting with the DEAD state alone, and ends with the death', () => {
        let dead = false;
        const flags: number[] = [];
        const mover = new Mover({
            timer: false,
            isDead: () => dead,
            ground: () => ({ z: 1789, swimming: true }),
            send: (_code, p) => flags.push(p[26]!),
        });
        mover.snap(1, CAMELOT.x, CAMELOT.y, 1830, 0, null);
        mover.start();
        expect(flags.at(-1)).toBe(0x04);
        dead = true;
        mover.sendUpdate();
        expect(flags.at(-1)).toBe(0x14);
        dead = false;
        mover.sendUpdate();
        expect(flags.at(-1)).toBe(0x04);
    });

    test('with a ground target every 0xA9 says it is in view, and without one it does not (ProcessActionFlags overwrites the flag from each)', () => {
        let hasGroundTarget = false;
        const flags: number[] = [];
        const mover = new Mover({ timer: false, hasGroundTarget: () => hasGroundTarget, send: (_code, p) => flags.push(p[32]!) });
        mover.snap(CAMELOT.regionId, CAMELOT.x, CAMELOT.y, CAMELOT.z, 0, null);
        mover.start();
        expect(flags.at(-1)).toBe(0x30);
        hasGroundTarget = true;
        mover.sendUpdate();
        expect(flags.at(-1)).toBe(0x38);
        hasGroundTarget = false;
        mover.sendUpdate();
        expect(flags.at(-1)).toBe(0x30);
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
