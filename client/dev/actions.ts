// Live check of the BotAction executor beyond the smoke test:
// merchant (interact/buy/sell), trainer (interact, keywords, whisper, openTrainer),
// inventory (moveItem, dropItem, pickup), sit/stand, useSkill, jump, command,
// and player visibility between two bots (0xD5 request path).
//
//   bun client/dev/actions.ts [userA] [userB]

import type { ActionResult, BotAction, BotWorldState } from '../../sdk/types';
import { DaocClient } from '../client';

const [userA = 'smoke1', userB = 'probe1'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const t0 = Date.now();
const log = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

function mk(username: string): DaocClient {
    return new DaocClient({ username, password: 'smoke123', realm: 'albion', className: 'Fighter', raceName: 'Briton', log: m => log(`  [${username}] ${m}`) });
}

const a = mk(userA);
const b = mk(userB);
let lastMsg = 0;
a.onStateChange(s => {
    for (const m of s.gameMessages) if (m.id > lastMsg) {
        lastMsg = m.id;
        log(`  [${userA}] msg[${m.type}${m.popup ? ',popup' : ''}] ${m.text.replace(/\n/g, ' | ').slice(0, 200)}`);
    }
});

const st = (): BotWorldState => a.collectState();
async function run(action: BotAction): Promise<ActionResult> {
    const r = await a.execute(action);
    log(`${action.type}: ${r.success ? 'ok' : 'FAILED'} ${r.message}`);
    return r;
}
async function until(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return true;
        await Bun.sleep(100);
    }
    return pred();
}
async function walkTo(x: number, y: number, z?: number, tolerance = 40): Promise<void> {
    await run({ type: 'moveTo', x, y, z, tolerance });
    await until(() => !a.session!.mover.moving, 30_000);
}

try {
    await a.connect();
    await b.connect();
    await Bun.sleep(2500);

    // Player visibility (both bots stand at the same spawn).
    const seesB = await until(() => st().nearbyPlayers.some(p => p.name.toLowerCase() === b.charName.toLowerCase()), 8000);
    if (!seesB) {
        // A stationary player is only pushed on AddToWorld; nudge B so a relayed 0xA9 makes A request it with 0xD5.
        await b.execute({ type: 'moveTo', x: b.position!.x + 30, y: b.position!.y });
    }
    const seen = await until(() => st().nearbyPlayers.some(p => p.name.toLowerCase() === b.charName.toLowerCase()), 8000);
    check('sees other bot', seen, st().nearbyPlayers.map(p => `${p.name}(${p.distance})`).join(', '));

    let s = st();
    const me = s.player!;
    const home = { x: me.x, y: me.y, z: me.z };

    // Merchant
    const merchant = s.nearbyNpcs.find(n => n.role === 'merchant' && n.distance < 1500);
    if (merchant) {
        await walkTo(merchant.x, merchant.y, merchant.z, 80);
        await run({ type: 'interact', objectId: merchant.objectId });
        const open = await until(() => st().merchant.isOpen && st().merchant.items.length > 0, 4000);
        s = st();
        check('merchant window', open, `${merchant.name}: ${s.merchant.items.length} items, e.g. ${s.merchant.items.slice(0, 4).map(i => `${i.name} ${i.price}c`).join(', ')}`);
        const cheap = s.merchant.items.filter(i => i.price <= s.player!.money.totalCopper).sort((x, y) => x.price - y.price)[0];
        if (cheap) {
            const before = s.inventory.length;
            await run({ type: 'buy', page: cheap.page, slot: cheap.slot, count: 1 });
            const bought = await until(() => st().inventory.length > before || st().gameMessages.some(m => /you (just )?(bought|buy)/i.test(m.text)), 4000);
            check('buy', bought, `${cheap.name} for ${cheap.price}c, money now ${st().player!.money.totalCopper}c`);
        } else {
            log(`nothing affordable (money ${s.player!.money.totalCopper}c)`);
        }
        s = st();
        const sellable = s.inventory.find(i => !/practice|training|recall stone/i.test(i.name));
        if (sellable) {
            const money0 = s.player!.money.totalCopper;
            await run({ type: 'sell', slot: sellable.slot });
            const sold = await until(() => !st().inventory.some(i => i.slot === sellable.slot) || st().player!.money.totalCopper !== money0, 4000);
            check('sell', sold, `${sellable.name}, money ${money0} → ${st().player!.money.totalCopper}c`);
        }
        await run({ type: 'closeMerchant' });
    } else check('merchant window', false, 'no merchant nearby');

    // Inventory: move, drop, pickup
    s = st();
    const item = [...s.inventory].reverse().find(i => !/recall stone/i.test(i.name));
    if (item) {
        const free = [...Array(40).keys()].map(i => i + 40).find(slot => !s.inventory.some(i => i.slot === slot))!;
        await run({ type: 'moveItem', fromSlot: item.slot, toSlot: free });
        const moved = await until(() => st().inventory.some(i => i.slot === free && i.name === item.name), 3000);
        check('moveItem', moved, `${item.name} ${item.slot} → ${free}`);
        const objs0 = new Set(st().nearbyObjects.map(o => o.objectId));
        await run({ type: 'dropItem', slot: free });
        const dropped = await until(() => st().nearbyObjects.some(o => !objs0.has(o.objectId)), 4000);
        const obj = st().nearbyObjects.find(o => !objs0.has(o.objectId));
        check('dropItem', dropped && !st().inventory.some(i => i.slot === free), obj ? `${obj.name} oid ${obj.objectId} at ${obj.distance} loot=${obj.isLoot} ours=${obj.ownedByUs}` : 'no ground object seen');
        if (obj) {
            await Bun.sleep(1200);
            await run({ type: 'pickup', objectId: obj.objectId });
            const picked = await until(() => st().inventory.some(i => i.name === item.name), 4000);
            check('pickup', picked, `inventory has ${item.name}: ${picked}`);
        }
    }

    // Trainer: interact → dialog keywords → whisper; openTrainer
    s = st();
    const trainer = s.nearbyNpcs.find(n => n.role === 'trainer' && n.distance < 2000);
    if (trainer) {
        await walkTo(trainer.x, trainer.y, trainer.z, 80);
        await run({ type: 'interact', objectId: trainer.objectId });
        const talked = await until(() => st().npcDialog?.npcObjectId === trainer.objectId, 4000);
        const dlg = st().npcDialog;
        check('npc dialog', talked, dlg ? `${dlg.npcName}: "${dlg.text.slice(0, 100)}" keywords [${dlg.keywords.join(', ')}]` : 'none');
        if (dlg && dlg.keywords.length > 0) {
            const t = dlg.receivedAt;
            await run({ type: 'whisper', objectId: trainer.objectId, text: dlg.keywords[0]! });
            const replied = await until(() => (st().npcDialog?.receivedAt ?? 0) > t || st().gameMessages.some(m => m.receivedAt > t && /receive|says/i.test(m.text)), 4000);
            check('whisper keyword', replied, st().gameMessages.filter(m => m.receivedAt > t).map(m => m.text).join(' | ').slice(0, 160));
        }
    }
    await run({ type: 'openTrainer' });
    const trained = await until(() => st().trainer.isOpen, 4000);
    s = st();
    check('openTrainer', trained, `${s.trainer.specPoints} points: ${s.trainer.specs.map(x => `${x.index}:${x.name} ${x.level}`).join(', ')}`);
    if (s.trainer.specPoints > 0 && s.trainer.specs[0]) {
        const spec = s.trainer.specs[0];
        await run({ type: 'trainSpec', specIndex: spec.index, levels: 1 });
        const ok = await until(() => (st().skills.specializations.find(x => x.name === spec.name)?.level ?? 0) > spec.level, 4000);
        check('trainSpec', ok, `${spec.name} ${spec.level} → ${st().skills.specializations.find(x => x.name === spec.name)?.level}`);
    }

    // Sit / stand / jump / command / useSkill
    await walkTo(home.x, home.y, home.z, 20);
    await run({ type: 'sit', sit: true });
    check('sit', await until(() => st().player!.isSitting && st().gameMessages.some(m => /you sit/i.test(m.text)), 3000));
    await run({ type: 'sit', sit: false });
    check('stand', await until(() => !a.session!.model.self.isSitting, 3000));
    await run({ type: 'jump' });
    const n0 = st().gameMessages.length;
    await run({ type: 'command', command: '/played' });
    check('command', await until(() => st().gameMessages.length > n0, 3000), st().gameMessages.at(-1)?.text.slice(0, 100));
    s = st();
    const ab = s.skills.abilities.find(x => /sprint/i.test(x.name));
    if (ab) {
        const m0 = st().gameMessages.length;
        await run({ type: 'useSkill', skillIndex: ab.skillIndex });
        check('useSkill', await until(() => st().gameMessages.slice(m0).some(m => /sprint/i.test(m.text)) || st().effects.some(e => /sprint/i.test(e.name)), 3000),
            `${ab.name}: ${st().gameMessages.slice(m0).map(m => m.text).join(' | ')} effects [${st().effects.map(e => e.name).join(', ')}]`);
        await run({ type: 'useSkill', skillIndex: ab.skillIndex });
    }
    // Validation paths
    const bad = await a.execute({ type: 'interact', objectId: 65000 });
    check('validation', !bad.success && bad.reason === 'unknown_object' && bad.phase === 'validation', bad.message);
    log(`unknown opcodes: ${[...a.session!.model.unknownOpcodes].map(([c, n]) => `0x${c.toString(16)}:${n}`).join(' ') || 'none'}; decode errors ${a.session!.model.decodeErrors}`);
} catch (e) {
    log(`ERROR ${(e as Error).stack}`);
    results.error = (e as Error).message;
}
await Promise.all([a.quit(), b.quit()]);
console.log('\n=== action results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(18)} ${v}`);
process.exit(0);
