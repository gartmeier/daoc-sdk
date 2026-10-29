// Live regression checks for the bot.* review fixes, with a fresh Albion Fighter:
// detour progress, cleanup after an abort (walk, kill, rest), already-there-while-moving.
//
//   bun sdk/test/live/review-live.ts <newAccount>

import { executionContext } from '../../execution-context';
import { log, startGateway, startLiveBot, withBots } from './harness';

const username = process.argv[2] ?? `rev${Date.now() % 100000}`;
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (k === 'messages' || k === 'npc' || k === 'target' ? undefined : v)).slice(0, 300);

/** Run `fn` as an execution that is cancelled after `ms` (like an MCP cancel); returns the error message. */
async function cancelledAfter(ms: number, fn: () => Promise<unknown>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('cancelled')), ms);
    try {
        await executionContext.run({ signal: controller.signal }, fn);
        return 'resolved';
    } catch (e) {
        return (e as Error).message;
    } finally {
        clearTimeout(timer);
    }
}

const gw = startGateway();
const a = await startLiveBot({ username }, gw);
const { bot, sdk } = a;

await withBots([a], gw, async () => {
    const p0 = sdk.getPlayer()!;
    const home = { x: p0.x, y: p0.y, z: p0.z };
    log(`start ${p0.name} at ${home.x},${home.y},${home.z}`);

    // A path that first leads 700 units away (~4 s) from its end point, with stuckMs 2000.
    const detour = await bot.followPath([{ x: home.x + 700, y: home.y }, { x: home.x + 700, y: home.y + 150 }, { x: home.x, y: home.y + 150 }], { tolerance: 40, stuckMs: 2000 });
    check('followPath detour is not stuck', detour.success, brief(detour));

    // Already at the destination while an earlier move carries us away.
    void sdk.sendMoveTo(home.x + 1500, home.y + 150);
    await Bun.sleep(400);
    const here = sdk.getPlayer()!;
    const stay = await bot.walkTo(here.x, here.y);
    await Bun.sleep(800);
    const after = sdk.getPlayer()!;
    check('walkTo here stops an earlier move', stay.success && !sdk.getMovement()!.moving && Math.hypot(after.x - here.x, after.y - here.y) < 150, `${brief(stay)} drift ${Math.round(Math.hypot(after.x - here.x, after.y - here.y))}`);

    // Cancel a long walk: the mover must stop.
    const walkErr = await cancelledAfter(1500, () => bot.walkTo(home.x + 2500, home.y + 150));
    const atCancel = sdk.getPlayer()!;
    await Bun.sleep(1200);
    const later = sdk.getPlayer()!;
    check('walkTo cancel stops the mover', walkErr === 'cancelled' && !sdk.getMovement()!.moving && Math.hypot(later.x - atCancel.x, later.y - atCancel.y) < 60,
        `${walkErr}; moved ${Math.round(Math.hypot(later.x - atCancel.x, later.y - atCancel.y))} after cancel`);
    await bot.walkTo(home.x, home.y, { z: home.z });

    // Cancel a kill mid-fight: attack mode off, not moving. Then finish the mob.
    const target = bot.findKillableNpc({ radius: 5000 });
    if (!target) check('killNpc cancel', false, 'nothing killable');
    else {
        const engaged = await bot.walkToObject(target, { range: 300 });
        log(`near ${target.name}: ${engaged.message}`);
        const killErr = await cancelledAfter(4000, () => bot.killNpc(target));
        await Bun.sleep(1000);
        const p = sdk.getPlayer()!;
        check('killNpc cancel switches attack off', killErr === 'cancelled' && !p.attacking && !sdk.getMovement()!.moving, `${killErr}; attacking ${p.attacking} moving ${sdk.getMovement()!.moving}`);
        const finish = await bot.killNpc(target.objectId, { timeout: 60_000 });
        check('killNpc after cancel', finish.success || finish.reason === 'not_found', brief(finish));
    }

    // Rest: sit is confirmed by "You sit down."; a cancel stands us back up.
    const hp = sdk.getPlayer()!.healthPercent;
    if (hp < 100) {
        const restErr = await cancelledAfter(2500, () => bot.rest({ healthPercent: 100 }));
        await Bun.sleep(800);
        const p = sdk.getPlayer()!;
        const stood = sdk.getGameMessages().slice(-10).some(m => /you stand up/i.test(m.text));
        check('rest cancel stands up', restErr === 'cancelled' && !p.isSitting && stood, `${restErr}; sitting ${p.isSitting}; stand message ${stood}`);
        const rest = await bot.rest({ healthPercent: 100, timeout: 90_000 });
        check('rest', rest.success && !sdk.getPlayer()!.isSitting, brief(rest));
    } else log(`health ${hp}%: rest checks skipped`);
});

console.log('\n=== review live results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(36)} ${v}`);
process.exit(Object.values(results).every(v => v.startsWith('PASS')) ? 0 : 1);
