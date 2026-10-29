// Live end-to-end check of the gateway path with runScript: move, target, say, read state.
//   bun client/runner.ts run1 &      (client attached to the gateway)
//   bun client/dev/e2e-script.ts run1

import { runScript, type ScriptContext } from '../../sdk/runner';

export default async function main({ sdk }: ScriptContext) {
    const checks: Record<string, boolean | string> = {};
    await sdk.waitForReady(30_000);
    const start = sdk.getPlayer()!;
    console.log(`start ${start.name} L${start.level} at (${start.x}, ${start.y}) region ${start.regionId}, maxConc ${start.maxConcentration}`);
    checks.maxConcentrationSane = start.maxConcentration < 10_000;

    // Move 200 units east and observe the position change.
    const target = { x: start.x + 200, y: start.y };
    const moved = await sdk.sendMoveTo(target.x, target.y);
    checks.moveDispatched = moved.success;
    // The actionResult arrives before the next state frame, so wait on the position, not on `moving`.
    const near = (p: { x: number; y: number }) => (s: { player: { x: number; y: number } | null; movement: { moving: boolean } }) =>
        !!s.player && !s.movement.moving && Math.hypot(s.player.x - p.x, s.player.y - p.y) < 40;
    await sdk.waitForCondition(near(target), 15_000).catch(() => {});
    const after = sdk.getPlayer()!;
    const err = Math.hypot(after.x - target.x, after.y - target.y);
    console.log(`after move at (${after.x}, ${after.y}), ${Math.round(err)} from target, stop ${sdk.getMovement()?.lastStopReason}, corrections ${sdk.getMovement()?.correctionCount}`);
    checks.arrived = err < 40;

    // Target the nearest NPC and see it reflected in state.
    const npc = sdk.getNearbyNpcs()[0];
    if (npc) {
        const t = await sdk.sendSetTarget(npc.objectId);
        await sdk.waitForCondition(s => s.player?.targetObjectId === npc.objectId, 5000).catch(() => {});
        checks.targeted = t.success && sdk.getPlayer()?.targetObjectId === npc.objectId;
        console.log(`targeted ${npc.name} (${npc.objectId}) at ${Math.round(npc.distance)}u`);
    } else {
        checks.targeted = 'no npc nearby';
    }

    // Say something and wait for the server's echo.
    const text = `e2e check ${Date.now() % 100000}`;
    const said = await sdk.sendSay(text);
    const echo = await sdk.waitForCondition(s => s.gameMessages.some(m => m.text.includes(text)), 5000).then(() => true).catch(() => false);
    checks.sayEchoed = said.success && echo;

    // Walk back, clear the target.
    await sdk.sendMoveTo(start.x, start.y);
    await sdk.waitForCondition(near(start), 15_000).catch(() => {});
    await sdk.sendSetTarget(null);
    await sdk.waitForCondition(s => s.player?.targetObjectId === null, 5000).catch(() => {});
    const state = sdk.getState()!;
    checks.backHome = Math.hypot(state.player!.x - start.x, state.player!.y - start.y) < 40;
    checks.inGame = state.inGame;
    console.log(JSON.stringify(checks));
    const ok = Object.values(checks).every(v => v === true);
    if (!ok) throw new Error(`e2e checks failed: ${JSON.stringify(checks)}`);
    return checks;
}

if (import.meta.main) runScript(main, { timeout: 90_000 });
