// Live check of the social, item, ability and movement helpers with two fresh Fighters.
//
//   bun sdk/test/live/misc-live.ts <newAccountA> <newAccountB>

import { log, startGateway, startLiveBots, withBots } from './harness';
import { EquipmentSlot } from '../../types';
import type { LiveBot } from './harness';

const [userA = `misca${Date.now() % 10000}`, userB = `miscb${Date.now() % 10000}`] = process.argv.slice(2);
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (k === 'messages' || k === 'target' || k === 'npc' ? undefined : v)).slice(0, 300);

const gw = startGateway();
const [a, b] = await startLiveBots([{ username: userA }, { username: userB, showMessages: false }], gw) as [LiveBot, LiveBot];

await withBots([a, b], gw, async () => {
    const nameA = a.sdk.getPlayer()!.name;
    const nameB = b.sdk.getPlayer()!.name;
    // A stationary player is only announced on AddToWorld; nudge both so each sees the other.
    await a.bot.walkTo(a.sdk.getPlayer()!.x + 40, a.sdk.getPlayer()!.y);
    await b.bot.walkTo(b.sdk.getPlayer()!.x - 40, b.sdk.getPlayer()!.y);
    await a.sdk.waitForCondition(s => s.nearbyPlayers.some(p => p.name === nameB), 10_000).catch(() => null);

    // Chat
    const say = await a.bot.say('hello from the bot layer');
    check('say', say.success && say.echoed, brief(say));
    const heard = b.sdk.waitForChat({ from: nameA, matching: /psst/, types: 'all', timeout: 5000 });
    const send = await a.bot.send(nameB, 'psst private');
    const got = await heard;
    check('send', send.success && !!got, `${brief(send)} | B got: ${got?.text}`);
    const sendBad = await a.bot.send('Nosuchplayerxyz', 'hi');
    check('send unknown player', !sendBad.success, brief(sendBad));

    // Group
    const accept = b.bot.acceptGroupInvite({ timeout: 10_000 });
    const inv = await a.bot.invite(nameB);
    const acc = await accept;
    check('invite', inv.success, brief(inv));
    check('acceptGroupInvite', acc.success && acc.group.length > 0, brief(acc));
    const gs = await a.bot.groupSay('group check');
    check('groupSay', gs.success, brief(gs));

    // Follow: B follows A while A walks away.
    const start = a.sdk.getPlayer()!;
    const follow = b.bot.follow(nameA, { distance: 120, durationMs: 15_000, until: s => {
        const me = s.player!;
        return Math.hypot(me.x - (start.x + 500), me.y - start.y) < 200 && !a.sdk.getMovement()?.moving;
    } });
    await a.bot.walkTo(start.x + 500, start.y);
    const f = await follow;
    const pb = b.sdk.getPlayer()!;
    check('follow', f.success && Math.hypot(pb.x - (start.x + 500), pb.y - start.y) < 300, `${brief(f)} B at ${pb.x},${pb.y}`);

    // Movement helpers
    const face = await a.bot.face(1024);
    check('face heading', face.success && Math.abs(face.heading - 1024) <= 64, brief(face));
    const facePlayer = await a.bot.face(nameB);
    check('face player', facePlayer.success, brief(facePlayer));
    void a.sdk.sendMoveTo(start.x + 1500, start.y);
    await Bun.sleep(600);
    const stop = await a.bot.stop();
    check('stop', stop.success && !a.sdk.getMovement()!.moving, brief(stop));
    const path = await a.bot.followPath([{ x: start.x + 300, y: start.y + 200 }, { x: start.x, y: start.y + 200 }, { x: start.x, y: start.y }], { tolerance: 30 });
    const pa = a.sdk.getPlayer()!;
    check('followPath', path.success && Math.hypot(pa.x - start.x, pa.y - start.y) <= 40, brief(path));

    // Abilities
    const sprint = await a.bot.useAbility('Sprint');
    check('useAbility', sprint.success, brief(sprint));
    await a.bot.useAbility('Sprint');
    const noStyle = await a.bot.useStyle('Nonexistent Style');
    check('useStyle unknown', !noStyle.success && noStyle.reason === 'not_found', noStyle.message);

    // Items
    const shield = a.sdk.getEquipmentItem(EquipmentSlot.LeftHand);
    if (shield) {
        const un = await a.bot.unequipItem(EquipmentSlot.LeftHand);
        check('unequipItem', un.success && !!a.sdk.findInventoryItem(shield.name), brief(un));
        const eq = await a.bot.equipItem(shield.name);
        check('equipItem', eq.success && a.sdk.getEquipmentItem(EquipmentSlot.LeftHand)?.name === shield.name, brief(eq));
    }
    const trainer = a.sdk.findNearbyNpcs(/./).find(n => n.role === 'trainer' && /fighter/i.test(n.guildName));
    if (trainer) {
        await a.bot.whisper(trainer, 'training shield');
        const extra = a.sdk.findInventoryItem(/training shield/);
        if (extra) {
            const drop = await a.bot.dropItem(extra);
            check('dropItem', drop.success && !a.sdk.getInventory().some(i => i.slot === extra.slot), brief(drop));
            await Bun.sleep(1500);
            const loot = await a.bot.lootNearby({ radius: 300, settleMs: 200 });
            log(`pick the dropped shield back up: ${loot.message} picked [${loot.picked.join(', ')}] skipped ${JSON.stringify(loot.skipped)}`);
            check('lootNearby (pickup)', loot.success && loot.picked.length > 0, brief(loot));
            const again = a.sdk.findInventoryItem(/training shield/);
            if (again) {
                const destroy = await a.bot.destroyItem(again);
                check('destroyItem', destroy.success && !a.sdk.findInventoryItem(/training shield/), brief(destroy));
            }
        } else log('trainer gave no extra shield');
    }
    const stone = a.sdk.findInventoryItem(/recall stone/i);
    if (stone) {
        const use = await a.bot.useItem(stone);
        check('useItem', use.success || use.reason === 'refused', `${brief(use)} | ${use.messages.map(m => m.text).join(' / ')}`);
        await a.bot.stop();
    }
    log(`free backpack slots: ${a.bot.freeBackpackSlots()}`);

    // Static data travel
    const spawn = a.bot.findNpcSpawn(/spirit hound/);
    check('findNpcSpawn', !!spawn, spawn ? `${spawn.name} at ${spawn.x},${spawn.y},${spawn.z} (${Math.round(spawn.distance ?? 0)} away)` : 'none');
});

console.log('\n=== misc live results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(20)} ${v}`);
process.exit(Object.values(results).every(v => v.startsWith('PASS')) ? 0 : 1);
