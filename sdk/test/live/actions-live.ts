// Live check of bot.* against the local OpenDAoC server with a fresh Albion Fighter.
//
//   bun sdk/test/live/actions-live.ts <newAccount> [steps...]
//   steps: walk talk kill loot rest grind sell train styles (default: walk..sell; sell runs after grind so there is loot)
//   GRIND_MS=180000 to change the grind length.

import { log, startGateway, startLiveBot, withBots } from './harness';

const args = process.argv.slice(2);
const username = args[0] ?? `act${Date.now() % 100000}`;
const steps = new Set(args.slice(1).length ? args.slice(1) : ['walk', 'talk', 'kill', 'loot', 'rest', 'sell', 'grind']);
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (k === 'messages' || k === 'items' ? undefined : v)).slice(0, 400);

const gw = startGateway();
const a = await startLiveBot({ username, className: process.env.CLASS ?? 'Fighter', raceName: process.env.RACE ?? 'Briton' }, gw);
const { bot, sdk } = a;

await withBots([a], gw, async () => {
    const p0 = sdk.getPlayer()!;
    const home = { x: p0.x, y: p0.y, z: p0.z };
    log(`start ${p0.name} L${p0.level} at ${home.x},${home.y},${home.z} xp ${p0.experience}`);

    if (steps.has('walk')) {
        const r = await bot.walkTo(home.x + 300, home.y + 200);
        const p = sdk.getPlayer()!;
        check('walkTo', r.success && Math.hypot(p.x - home.x - 300, p.y - home.y - 200) <= 70, brief(r));
        const back = await bot.walkTo(home.x, home.y, { z: home.z, tolerance: 30 });
        check('walkTo back', back.success, brief(back));
        const bad = await bot.walkTo(NaN, 5);
        check('walkTo bad args', !bad.success && bad.reason === 'bad_args', bad.message);
    }

    if (steps.has('talk')) {
        const trainer = sdk.findNearbyNpcs(/./).find(n => n.role === 'trainer' && /fighter/i.test(n.guildName)) ?? sdk.findNearbyNpcs(/./).find(n => n.role === 'trainer');
        if (!trainer) check('talkTo', false, 'no trainer nearby');
        else {
            const t = await bot.talkTo(trainer);
            check('talkTo', t.success && t.keywords.length > 0, `${trainer.name}: keywords [${t.keywords.join(', ')}] text "${t.text.slice(0, 150)}"`);
            if (t.keywords[0]) {
                const w = await bot.whisper(trainer, t.keywords[0]);
                check('whisper', w.success, `${w.message}: keywords [${w.keywords.join(', ')}] "${w.text.slice(0, 200)}"`);
            }
        }
    }

    if (steps.has('kill')) {
        const target = bot.findKillableNpc({ radius: 4000 });
        log(`killable: ${bot.findKillableNpcs({ radius: 4000 }).slice(0, 5).map(n => `${n.name} L${n.level} d${n.distance}`).join(', ')}`);
        if (!target) check('killNpc', false, 'nothing killable');
        else {
            const xp0 = sdk.getPlayer()!.experience;
            const k = await bot.killNpc(target);
            check('killNpc', k.success && k.killed && k.xpGained > 0 && sdk.getPlayer()!.experience > xp0, brief(k));
        }
    }

    if (steps.has('loot')) {
        const l = await bot.lootNearby();
        check('lootNearby', l.success, brief(l));
    }

    if (steps.has('rest')) {
        const hp = sdk.getPlayer()!.healthPercent;
        const r = await bot.rest({ healthPercent: 100, timeout: 90_000 });
        check('rest', r.success && !sdk.getPlayer()!.isSitting, `${hp}% -> ${brief(r)}`);
    }

    if (steps.has('grind')) {
        const ms = Number(process.env.GRIND_MS ?? 180_000);
        const anchorNpc = bot.findKillableNpc({ radius: 5000 });
        const anchor = anchorNpc ? { x: anchorNpc.x, y: anchorNpc.y, z: anchorNpc.z } : undefined;
        const xp0 = sdk.getPlayer()!.experience;
        const g = await bot.grind({
            durationMs: ms, anchor, radius: 1500, restBelowHealth: 55,
            onKill: (k, st) => { log(`  kill #${st.kills}: ${k.message} hp ${sdk.getPlayer()!.healthPercent}%`); },
        });
        const p = sdk.getPlayer()!;
        check('grind', g.success && g.deaths === 0 && p.experience > xp0 && !p.isDead, `${g.message}; level ${p.level} xp ${xp0} -> ${p.experience}; failures ${g.failures}`);
    }

    if (steps.has('sell')) {
        const merchant = sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant' && /weapon/i.test(n.guildName)) ?? sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant');
        if (!merchant) check('sellItem', false, 'no merchant');
        else {
            const m = await bot.openMerchant(merchant);
            check('openMerchant', m.success && m.items.length > 0, `${merchant.name}: ${m.message}`);
            let item = sdk.getInventory().find(i => !/recall stone|practice|training/i.test(i.name));
            if (!item) {
                const cheapest = [...(sdk.getMerchant()?.items ?? [])].sort((x, y) => x.price - y.price)[0];
                if (cheapest && cheapest.price <= sdk.getPlayer()!.money.totalCopper) {
                    const b = await bot.buyItem(merchant, { page: cheapest.page, slot: cheapest.slot });
                    check('buyItem', b.success, brief(b));
                    item = sdk.getInventory().find(i => !/recall stone/i.test(i.name));
                } else log(`cannot afford anything (cheapest ${cheapest?.price}c, have ${sdk.getPlayer()!.money.totalCopper}c)`);
            }
            if (item) {
                const s = await bot.sellItem(merchant, item);
                check('sellItem', s.success && s.earned >= 0, brief(s));
            } else check('sellItem', false, 'nothing to sell');
            await bot.closeMerchant();
        }
    }

    if (steps.has('shop')) {
        const merchant = sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant' && /weapon/i.test(n.guildName));
        if (merchant) {
            const m = await bot.openMerchant(merchant);
            const money = sdk.getPlayer()!.money.totalCopper;
            // Find any nearby merchant with something we can afford.
            let bought = false;
            for (const shop of sdk.findNearbyNpcs(/./).filter(n => n.role === 'merchant').slice(0, 6)) {
                const open = await bot.openMerchant(shop);
                const cheapest = [...open.items].sort((x, y) => x.price - y.price)[0];
                log(`  ${shop.name} <${shop.guildName}>: cheapest ${cheapest?.name} ${cheapest?.price}c (have ${money}c)`);
                if (cheapest && cheapest.price <= money) {
                    const b = await bot.buyItem(shop, cheapest.name);
                    check('buyItem', b.success && b.count > 0 && b.spent > 0, brief(b));
                    bought = true;
                    break;
                }
            }
            if (!bought) log('nothing affordable at nearby merchants');
            const tooPoor = await bot.buyItem(merchant, [...m.items].sort((x, y) => y.price - x.price)[0]!.name);
            check('buyItem refused', !tooPoor.success && tooPoor.reason === 'insufficient_funds', tooPoor.message);
            const sold = await bot.sellItems(merchant, i => !/recall stone|practice|training/i.test(i.name));
            check('sellItems', sold.success, `${sold.message} failed: ${sold.failed.map(f => `${f.item.name}: ${f.reason}`).join('; ')}`);
        } else check('buyItem', false, 'no weapon merchant');
    }

    if (steps.has('travel')) {
        const t = await bot.travelTo(/spirit hound/);
        check('travelTo spawn', t.success, `${t.message} spawn ${t.spawn?.name} at ${t.spawn?.x},${t.spawn?.y},${t.spawn?.z}; we are at ${JSON.stringify(t.position)}`);
        const h = await bot.waitForHealth(50, 2000);
        check('waitForHealth', h.success, h.message);
    }

    if (steps.has('train')) {
        const trainer = sdk.findNearbyNpcs(/./).find(n => n.role === 'trainer' && /fighter/i.test(n.guildName));
        const spec = sdk.getSkills().specializations[0];
        if (trainer && spec) {
            const t = await bot.trainSpec(trainer, spec.name, 1);
            check('trainSpec', t.success, brief(t));
        }
    }

    if (steps.has('styles')) {
        const styles = sdk.getSkills().styles;
        log(`styles: ${styles.map(s => `${s.name}(${s.skillIndex})`).join(', ') || 'none'}`);
        const target = bot.findKillableNpc({ radius: 5000 });
        if (styles[0] && target) {
            const k = await bot.killNpc(target, { styles: styles.map(s => s.name) });
            check('killNpc styles', k.success && k.stylesUsed > 0, brief(k));
            const watchStyle = await bot.useStyle(styles[0].name);
            log(`useStyle out of combat: ${watchStyle.message} (${watchStyle.reason ?? 'ok'})`);
        } else log('no styles or no target');
    }

});

console.log('\n=== bot.* live results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(16)} ${v}`);
process.exit(Object.values(results).every(v => v.startsWith('PASS')) ? 0 : 1);
