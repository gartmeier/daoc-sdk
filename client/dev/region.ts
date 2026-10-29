// Live check of server-forced moves with a GM account (PrivLevel 3, protocol test only):
// same-region '/jump' (0x04 CharacterJump → snap) and cross-region jump (0xB7 → D4 → 0x20 → BF → E8).
//
//   bun client/dev/region.ts [gmUsername]

import { DaocClient } from '../client';

const user = process.argv[2] ?? 'gmtest';
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const c = new DaocClient({ username: user, password: 'smoke123', realm: 'albion', log: m => log(`  ${m}`) });
let last = 0;
c.onStateChange(s => {
    for (const m of s.gameMessages) if (m.id > last) {
        last = m.id;
        log(`  msg[${m.type}] ${m.text.slice(0, 160)}`);
    }
});
const until = async (p: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !p()) await Bun.sleep(100);
    return p();
};
const results: string[] = [];
await c.connect();
await Bun.sleep(1500);
let s = c.collectState();
const p0 = s.player!;
log(`start region ${p0.regionId} (${p0.x}, ${p0.y}, ${p0.z}) zone ${p0.zoneId}`);

// Same region
const corr0 = s.movement.correctionCount;
await c.execute({ type: 'command', command: `/jump to ${p0.x + 500} ${p0.y + 500} ${p0.z} ${p0.regionId}` });
const snapped = await until(() => c.collectState().movement.correctionCount > corr0, 5000);
s = c.collectState();
results.push(`same-region jump: ${snapped ? 'PASS' : 'FAIL'} pos (${s.player!.x}, ${s.player!.y}) stop=${s.movement.lastStopReason}`);

// Cross region
await c.execute({ type: 'command', command: '/jump to 532950 549779 4800 51' });
const changed = await until(() => c.collectState().player?.regionId === 51 && c.inGame, 20_000);
await Bun.sleep(3000);
s = c.collectState();
results.push(`region change: ${changed ? 'PASS' : 'FAIL'} region ${s.player!.regionId} zone ${s.player!.zoneId} (${s.player!.zoneName}) pos (${s.player!.x}, ${s.player!.y}, ${s.player!.z}) phase ${c.phase} npcs ${s.nearbyNpcs.length}`);
// Still alive after 8 s (A9 accepted in the new zone)?
await Bun.sleep(8000);
s = c.collectState();
results.push(`after 8 s: phase ${c.phase}, corrections ${s.movement.correctionCount}, errors ${c.session!.model.decodeErrors}`);
// Walk a bit in the new region
await c.execute({ type: 'moveTo', x: s.player!.x + 200, y: s.player!.y });
await until(() => !c.session!.mover.moving, 5000);
results.push(`walk in new region: ${c.collectState().movement.lastStopReason}`);
// Back home
await c.execute({ type: 'command', command: `/jump to ${p0.x} ${p0.y} ${p0.z} ${p0.regionId}` });
await until(() => c.collectState().player?.regionId === p0.regionId && c.inGame, 20_000);
await Bun.sleep(1500);
results.push(`back home: region ${c.collectState().player!.regionId} phase ${c.phase}`);
await c.quit();
console.log('\n' + results.join('\n'));
process.exit(0);
