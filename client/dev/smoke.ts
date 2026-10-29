// Live smoke test against the local OpenDAoC server.
//
//   bun client/dev/smoke.ts [username] [--no-combat] [--trace]
//
// Connects (auto-creating the account and an Albion character if missing),
// prints a state summary, walks ~300 units and back, targets the nearest NPC,
// says something, idles 15 s checking for link-death / teleport-back, tries to
// kill a low-level mob, then quits cleanly.
//
// New accounts are subject to time_between_account_creation_sameip (default 15 min).
// Pre-create one if needed:
//   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc \
//     -e "INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('smoke1','smoke123',NOW(),1,UUID());"

import type { BotWorldState, NearbyNpc } from '../../sdk/types';
import { DaocClient } from '../client';

const args = process.argv.slice(2);
const username = args.find(a => !a.startsWith('--')) ?? 'smoke1';
const doCombat = !args.includes('--no-combat');
const trace = args.includes('--trace');

const t0 = Date.now();
const log = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

const client = new DaocClient({
    host: 'localhost',
    port: 10300,
    username,
    password: 'smoke123',
    realm: 'albion',
    className: 'Fighter',
    raceName: 'Briton',
    log: m => log(`  ${m}`),
    trace,
});

let state: BotWorldState = client.collectState();
let publishes = 0;
client.onStateChange(s => {
    state = s;
    publishes++;
});
let lastMsgId = 0;
const printNewMessages = (): void => {
    for (const m of state.gameMessages) {
        if (m.id <= lastMsgId) continue;
        lastMsgId = m.id;
        log(`  msg[${m.type}${m.popup ? ',popup' : ''}] ${m.text}`);
    }
};
client.onStateChange(printNewMessages);
client.onDisconnect((reason, message) => log(`DISCONNECTED: ${reason} (${message})`));

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (pred()) return true;
        await Bun.sleep(stepMs);
    }
    return pred();
}

const results: Record<string, string> = {};
function check(name: string, pass: boolean, detail = ''): void {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function summary(): void {
    const p = state.player!;
    log(`player ${p.name} L${p.level} ${p.raceName} ${p.className} oid=${p.objectId} sess=${p.sessionId}`);
    log(`  region ${p.regionId} zone ${p.zoneId} (${p.zoneName}) pos (${p.x}, ${p.y}, ${p.z}) heading ${p.heading} maxSpeed ${p.maxSpeed}`);
    log(`  HP ${p.health}/${p.maxHealth} mana ${p.mana}/${p.maxMana} endu ${p.endurance}/${p.maxEndurance} money ${p.money.totalCopper}c`);
    log(`  inventory ${state.inventory.length} items, equipment ${state.equipment.length}: ${state.equipment.map(i => `${i.slot}:${i.name}`).join(', ')}`);
    log(`  skills: ${state.skills.specializations.map(s => `${s.name} ${s.level}`).join(', ')} | styles ${state.skills.styles.map(s => s.name).join(', ')} | abilities ${state.skills.abilities.length}`);
    log(`  nearby: ${state.nearbyNpcs.length} npcs, ${state.nearbyPlayers.length} players, ${state.nearbyObjects.length} objects`);
    log(`  npcs: ${state.nearbyNpcs.slice(0, 12).map(n => `${n.name}(L${n.level},${n.distance}${n.role ? ',' + n.role : ''})`).join(', ')}`);
}

const session = () => client.session!;

try {
    await client.connect();
    check('enter world', client.inGame, `phase ${client.phase}`);
    await waitUntil(() => !!session().model.self.statusReceived, 5000);
    await Bun.sleep(1500);
    state = client.collectState();
    summary();
    check('status received', !!state.player && state.player.maxHealth > 0, `HP ${state.player?.health}/${state.player?.maxHealth}`);
    check('npcs populated', state.nearbyNpcs.length > 0, `${state.nearbyNpcs.length} npcs`);

    // Walk ~300 units and back.
    const start = { x: state.player!.x, y: state.player!.y, z: state.player!.z };
    const h = (state.player!.heading * 2 * Math.PI) / 4096;
    const away = { x: start.x - Math.sin(h) * 300, y: start.y + Math.cos(h) * 300 };
    const corrections0 = state.movement.correctionCount;
    let r = await client.execute({ type: 'moveTo', x: away.x, y: away.y, tolerance: 10 });
    log(`moveTo away: ${r.message}`);
    await waitUntil(() => !session().mover.moving && session().mover.lastStopReason !== null, 8000);
    state = client.collectState();
    const p1 = client.collectState().player!;
    const d1 = Math.hypot(p1.x - away.x, p1.y - away.y);
    check('walk away', state.movement.lastStopReason === 'arrived' && d1 < 20, `stop=${state.movement.lastStopReason} pos (${p1.x}, ${p1.y}) err ${d1.toFixed(1)}`);
    r = await client.execute({ type: 'moveTo', x: start.x, y: start.y, z: start.z, tolerance: 10 });
    log(`moveTo back: ${r.message}`);
    await waitUntil(() => !session().mover.moving && session().mover.lastStopReason !== null, 8000);
    state = client.collectState();
    const p2 = state.player!;
    check('walk back', Math.hypot(p2.x - start.x, p2.y - start.y) < 20, `pos (${p2.x}, ${p2.y}) corrections ${state.movement.correctionCount - corrections0}`);

    // Target the nearest NPC and say something.
    state = client.collectState();
    const nearest = state.nearbyNpcs.find(n => n.isTargetable);
    if (nearest) {
        r = await client.execute({ type: 'setTarget', objectId: nearest.objectId });
        log(`setTarget ${nearest.name}: ${r.message}`);
        await Bun.sleep(500);
    }
    r = await client.execute({ type: 'say', text: 'hello from daoc-sdk' });
    log(`say: ${r.message}`);
    const heard = await waitUntil(() => state.gameMessages.some(m => /hello from daoc-sdk/.test(m.text)), 3000);
    check('say echoed', heard);

    // Idle 15 s: no link-death, no teleport back.
    const idleStart = client.collectState().player!;
    const corr1 = state.movement.correctionCount;
    log('idling 15 s...');
    await Bun.sleep(15_000);
    state = client.collectState();
    const idleEnd = state.player!;
    const linkdead = state.gameMessages.some(m => /link ?dead|linkdead/i.test(m.text));
    check('idle 15 s', client.inGame && state.movement.correctionCount === corr1 && !linkdead && idleEnd.x === idleStart.x && idleEnd.y === idleStart.y,
        `phase ${client.phase}, corrections +${state.movement.correctionCount - corr1}, linkdeadMsg ${linkdead}, A9 sent ${session().mover.sentCount}, LoS replies ${session().losReplies}, npcs still tracked ${state.nearbyNpcs.length}`);

    if (doCombat) await combat();

    log(`model: decodeErrors=${session().model.decodeErrors} last=${session().model.lastDecodeError} unknown=${[...session().model.unknownOpcodes].map(([c, n]) => `0x${c.toString(16)}:${n}`).join(' ')}`);
    log(`publishes ${publishes}, tick ${state.tick}`);
    log('quitting...');
    await client.quit();
    check('clean quit', session().endReason === 'quit', `endReason ${session().endReason}`);
} catch (e) {
    log(`ERROR: ${(e as Error).stack ?? e}`);
    results.error = String((e as Error).message);
    client.disconnect();
}

console.log('\n=== smoke results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(18)} ${v}`);
process.exit(Object.values(results).some(v => v.startsWith('FAIL')) || results.error ? 1 : 0);

async function combat(): Promise<void> {
    state = client.collectState();
    const me = state.player!;
    const candidates = state.nearbyNpcs
        .filter(n => n.isTargetable && !n.isPeaceful && n.realm === 'none' && !n.guildName && n.level <= Math.max(2, me.level + 1) && n.healthPercent > 0)
        .sort((a, b) => a.distance - b.distance);
    log(`combat candidates: ${candidates.slice(0, 8).map(n => `${n.name}(L${n.level},${n.distance})`).join(', ') || 'none'}`);
    const mob = candidates.find(n => n.distance < 3000);
    if (!mob) {
        check('combat', false, 'no low-level mob within 3000 units');
        return;
    }
    log(`engaging ${mob.name} L${mob.level} oid ${mob.objectId} at ${mob.distance}`);
    const origin = { x: me.x, y: me.y, z: me.z };
    const deadline = Date.now() + 120_000;
    let attacking = false;
    let swings = 0;
    let lastMove = 0;
    const firstEvent = state.combatEvents.at(-1)?.id ?? 0;
    let killed = false;
    while (Date.now() < deadline) {
        state = client.collectState();
        if (!client.inGame) break;
        if (state.player!.isDead) {
            log('we died');
            break;
        }
        const target: NearbyNpc | undefined = state.nearbyNpcs.find(n => n.objectId === mob.objectId);
        const deathEvt = state.combatEvents.find(e => e.id > firstEvent && e.kind === 'death' && e.targetObjectId === mob.objectId);
        if (!target || target.healthPercent === 0 || deathEvt) {
            killed = !!deathEvt || (target?.healthPercent === 0) || state.gameMessages.some(m => /you (have )?kill|dies|you gain/i.test(m.text));
            break;
        }
        if (target.distance > 110 && Date.now() - lastMove > 600) {
            await client.execute({ type: 'moveTo', x: target.x, y: target.y, z: target.z, tolerance: 60 });
            lastMove = Date.now();
        }
        if (!attacking && target.distance < 400) {
            await client.execute({ type: 'setTarget', objectId: mob.objectId });
            const r = await client.execute({ type: 'attack', on: true });
            log(`attack: ${r.message}`);
            attacking = true;
        }
        if (attacking && target.distance <= 110 && !state.movement.moving) await client.execute({ type: 'faceObject', objectId: mob.objectId });
        const melee = state.combatEvents.filter(e => e.id > firstEvent && e.kind === 'melee');
        if (melee.length !== swings) {
            swings = melee.length;
            const e = melee.at(-1)!;
            log(`  swing ${e.attackerObjectId === me.objectId ? 'we' : 'mob'} → ${e.result} (target ${e.targetHealthPercent}%)`);
        }
        await Bun.sleep(250);
    }
    state = client.collectState();
    const ours = state.combatEvents.filter(e => e.id > firstEvent && e.kind === 'melee' && e.attackerObjectId === me.objectId);
    const hits = ours.filter(e => e.result === 'hit' || e.result === 'styledHit').length;
    check('combat', killed, `${mob.name}: our swings ${ours.length}, hits ${hits}, HP ${state.player!.health}/${state.player!.maxHealth}, xp ${state.player!.experience}`);
    await client.execute({ type: 'attack', on: false });
    await Bun.sleep(1500);
    state = client.collectState();
    const loot = state.nearbyObjects.filter(o => o.isLoot && o.distance < 400);
    log(`loot nearby: ${loot.map(o => `${o.name}(${o.distance}${o.ownedByUs ? ',ours' : ''})`).join(', ') || 'none'} (autoloot is on by default)`);
    if (!state.player!.isDead) {
        await client.execute({ type: 'moveTo', x: origin.x, y: origin.y, z: origin.z, tolerance: 20 });
        await waitUntil(() => !session().mover.moving, 20_000);
    }
}
