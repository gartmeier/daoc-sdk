// Live check of bot.castSpell with a fresh caster.
//
//   bun sdk/test/live/cast-live.ts <newAccount> [Class] [Race]   (default Mage Briton)

import { log, startGateway, startLiveBot, withBots } from './harness';

const [username = `cast${Date.now() % 100000}`, className = 'Mage', raceName = 'Briton'] = process.argv.slice(2);
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (k === 'messages' || k === 'npc' || k === 'target' || k === 'spell' ? undefined : v)).slice(0, 400);

const gw = startGateway();
const a = await startLiveBot({ username, className, raceName }, gw);
const { bot, sdk } = a;

await withBots([a], gw, async () => {
    const p = sdk.getPlayer()!;
    const spells = sdk.getSkills().spells;
    log(`${p.name} L${p.level} ${p.className} mana ${p.mana}/${p.maxMana}; spells: ${spells.map(s => `${s.name}(L${s.level} ${s.lineName} ${s.lineIndex}/${s.spellIndex} id ${s.internalId})`).join(', ')}`);
    for (const s of spells) log(`  ${s.name}: ${JSON.stringify(bot.getSpellInfo(s))?.slice(0, 160)}`);
    const nuke = spells.find(s => /damage|drain|bolt/i.test(bot.getSpellInfo(s)?.type ?? '')) ?? spells[0];
    const buff = spells.find(s => /^self$/i.test(bot.getSpellInfo(s)?.target ?? ''));
    if (buff) {
        const b = await bot.castSpell(buff);
        check('castSpell self buff', b.success && b.completed, `${buff.name}: ${brief(b)}`);
    }
    if (!nuke) { check('castSpell', false, 'no spells'); return; }

    const bad = await bot.castSpell('No Such Spell');
    check('castSpell unknown', !bad.success && bad.reason === 'spell_not_found', bad.message);

    const target = bot.findKillableNpc({ radius: 5000 });
    if (!target) { check('castSpell', false, 'no target'); return; }
    log(`target ${target.name} L${target.level} at ${target.distance}`);
    const c = await bot.castSpell(nuke, target);
    check('castSpell', c.success && c.completed, `${nuke.name}: ${brief(c)} | ${c.messages.map(m => m.text).join(' / ').slice(0, 300)}`);

    // Finish it with spells (or melee once out of mana).
    const xp0 = sdk.getPlayer()!.experience;
    for (let i = 0; i < 20; i++) {
        const t = sdk.getNearbyNpc(target.objectId);
        if (!t || t.healthPercent <= 0) break;
        if (sdk.getPlayer()!.isDead) break;
        const again = await bot.castSpell(nuke, t);
        log(`  cast #${i + 2}: ${again.message} (${again.reason ?? 'ok'}) mana ${sdk.getPlayer()!.manaPercent}% target ${sdk.getNearbyNpc(target.objectId)?.healthPercent ?? 0}%`);
        if (again.retryAfterMs) await Bun.sleep(again.retryAfterMs + 200);
        if (!again.success && again.reason === 'no_power') {
            const k = await bot.killNpc(t, { timeout: 60_000 });
            log(`  melee finish: ${k.message}`);
            break;
        }
    }
    await Bun.sleep(1500);
    // A level-1 caster in melee range is interrupted every swing, so this kill often fails: informational only.
    log(`INFO spell kill: xp ${xp0} -> ${sdk.getPlayer()!.experience}, dead=${sdk.getPlayer()!.isDead}`);
    if (sdk.getPlayer()!.isDead) {
        const pos = sdk.getPosition();
        const rel = await bot.releaseAndRespawn();
        const now = sdk.getPosition();
        check('releaseAndRespawn', rel.success && !sdk.getPlayer()!.isDead, `${brief(rel)} from ${pos?.x},${pos?.y} to ${now?.x},${now?.y}`);
    } else {
        const r = await bot.rest({ healthPercent: 90, manaPercent: 80, timeout: 90_000 });
        check('rest mana', r.success || r.reason === 'in_combat', brief(r));
    }
});

console.log('\n=== castSpell live results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(18)} ${v}`);
process.exit(Object.values(results).every(v => v.startsWith('PASS')) ? 0 : 1);
