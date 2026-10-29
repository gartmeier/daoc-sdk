// Live death / release check: a GM bot '/harm's the player bot.
//   bun client/dev/death.ts [player] [gm]
import { DaocClient } from '../client';

const [user = 'smoke1', gmUser = 'gmtest'] = process.argv.slice(2);
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const p = new DaocClient({ username: user, password: 'smoke123', realm: 'albion', log: m => log(`  [p] ${m}`) });
const gm = new DaocClient({ username: gmUser, password: 'smoke123', realm: 'albion' });
let last = 0;
p.onStateChange(s => {
    for (const m of s.gameMessages) if (m.id > last) {
        last = m.id;
        log(`  [p] msg[${m.type}] ${m.text.slice(0, 160)}`);
    }
});
const until = async (f: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !f()) await Bun.sleep(100);
    return f();
};
const out: string[] = [];
await p.connect();
await gm.connect();
await Bun.sleep(2000);
// Make sure the GM sees the player (nudge so a relayed 0xA9 triggers 0xD5).
await p.execute({ type: 'moveTo', x: p.position!.x + 40, y: p.position!.y });
const seen = await until(() => gm.collectState().nearbyPlayers.some(x => x.name.toLowerCase() === p.charName.toLowerCase()), 8000);
const target = gm.collectState().nearbyPlayers.find(x => x.name.toLowerCase() === p.charName.toLowerCase());
out.push(`gm sees player: ${seen}`);
if (target) {
    await p.execute({ type: 'moveTo', x: p.position!.x + 2000, y: p.position!.y });
    await Bun.sleep(600);
    await gm.execute({ type: 'setTarget', objectId: target.objectId });
    await Bun.sleep(300);
    await gm.execute({ type: 'command', command: '/harm 5000' });
    const died = await until(() => p.collectState().player!.isDead, 5000);
    let s = p.collectState();
    out.push(`died: ${died} deathCount ${s.player!.deathCount} moving ${s.movement.moving} stop ${s.movement.lastStopReason} hp ${s.player!.health}`);
    const before = { x: s.player!.x, y: s.player!.y };
    await Bun.sleep(11_000); // release needs >= 10 s
    const r = await p.execute({ type: 'release' });
    out.push(`release: ${r.message}`);
    const alive = await until(() => !p.collectState().player!.isDead, 8000);
    await Bun.sleep(1500);
    s = p.collectState();
    out.push(`released: alive ${alive} hp ${s.player!.health}/${s.player!.maxHealth} moved ${Math.round(Math.hypot(s.player!.x - before.x, s.player!.y - before.y))} units, corrections ${s.movement.correctionCount}, phase ${p.phase}`);
}
await Promise.all([p.quit(), gm.quit()]);
console.log('\n' + out.join('\n'));
process.exit(0);
