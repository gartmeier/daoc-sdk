// Live measurement of a Paladin's chants: what each gives at Chants 24, held and twisted. In the level's custom gear, a Paladin
// swings (with a style on every swing) at a training dummy, then at a Warrior who hits the Cleric, while the Cleric, a Sorcerer at
// 1200 and a Cabalist at 1700 report what is on them. Needs an account with PrivLevel 3, so run it on a throwaway stack:
//
//   LIVE_SERVER=127.0.0.1:<port> LIVE_DB_CONTAINER=<stack's db container> [CASES=a,b] bun sdk/test/live/chant-twist-live.ts <gmAccount> [caseSeconds] [messages.jsonl]

import { getBuild, getClassBuilds } from '../../../data/builds';
import { templateFor, TEMPLATE_PACKAGE, templateSql, wearOrder, type TemplatePiece } from '../../group/gear-template';
import { formGroup } from '../../group/roster';
import { Spellbook } from '../../group/spells';
import type { SongKind } from '../../group/songs';
import { twistTurn } from '../../group/twist';
import type { MemberContext } from '../../group/member';
import { log, startGateway, startLiveBots, withBots, type LiveBot } from './harness';

const [gmAccount, secondsArg, dumpPath] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: chant-twist-live.ts <gmAccount> [caseSeconds] [messages.jsonl]');
const caseMs = Number(secondsArg ?? 45) * 1000;
const tag = Date.now() % 100000;
const X = 34000, Y = 32000, Z = 4400;

const gw = startGateway();
const quiet = { showMessages: false };
const [gm, paladin, cleric, sorcerer, cabalist, warrior] = await startLiveBots([
    { username: gmAccount, ...quiet },
    { username: `tp${tag}`, realm: 'albion', className: 'Paladin', raceName: 'Briton', ...quiet },
    { username: `tc${tag}`, realm: 'albion', className: 'Cleric', raceName: 'Briton', ...quiet },
    { username: `ts${tag}`, realm: 'albion', className: 'Sorcerer', raceName: 'Briton', ...quiet },
    { username: `tb${tag}`, realm: 'albion', className: 'Cabalist', raceName: 'Briton', ...quiet },
    { username: `tw${tag}`, realm: 'midgard', className: 'Warrior', raceName: 'Troll', ...quiet },
], gw) as [LiveBot, LiveBot, LiveBot, LiveBot, LiveBot, LiveBot];
const me = (b: LiveBot) => b.sdk.getPlayer()!;
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(400);
};
const place = (b: LiveBot, x: number, y: number) => gm.sdk.sendCommand(`/jump ${me(b).name} to ${x} ${y} ${Z} 252`);

let label = 'setup';
const dump: { t: number; c: string; b: string; m: string }[] = [];
const inbox = new Map<LiveBot, string[]>();
for (const b of [paladin, cleric, sorcerer, cabalist]) {
    inbox.set(b, []);
    let last = 0;
    b.client.onStateChange(state => {
        for (const m of state.gameMessages) {
            if (m.id <= last) continue;
            last = m.id;
            inbox.get(b)!.push(m.text);
            if (dumpPath) dump.push({ t: Date.now(), c: label, b: b.username.slice(0, 2), m: m.text });
        }
    });
}
const count = (lines: string[], re: RegExp) => lines.filter(l => re.test(l)).length;
const sum = (lines: string[], re: RegExp) => lines.reduce((n, l) => n + Number(re.exec(l)?.[1] ?? 0), 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The level's custom set for each, as in learnings/gear-template.md: rows in, the GM makes the pieces and hands them over, they wear them. */
async function gearUp(specsOf: Map<LiveBot, Record<string, number>>) {
    const pieces = new Map<LiveBot, TemplatePiece[]>([...specsOf].map(([b, specs]) => [b, templateFor(me(b).className, me(b).realm, 24, specs)]));
    const db = process.env.LIVE_DB_CONTAINER;
    if (!db) throw new Error('LIVE_DB_CONTAINER names the db container of the throwaway stack');
    const proc = Bun.spawn(['docker', 'exec', '-i', db, 'mariadb', '-uroot', '-pdaoc-sdk', 'opendaoc'], { stdin: new TextEncoder().encode(templateSql([...pieces.values()].flat())), stderr: 'pipe' });
    if (await proc.exited) throw new Error(await new Response(proc.stderr).text());
    await gm.sdk.sendCommand(`/item loadpackage ${TEMPLATE_PACKAGE}`);
    await Bun.sleep(1000);
    for (const [b, list] of pieces) {
        const at = me(b);
        await gm.sdk.sendCommand(`/jump to ${at.x} ${at.y} ${at.z} ${at.regionId}`);
        await Bun.sleep(1500);
        for (let i = 0; i < list.length; i += 10) {
            const batch = list.slice(i, i + 10);
            for (const p of batch) { await gm.sdk.sendCommand(`/item create ${p.id}`); await Bun.sleep(250); }
            await Bun.sleep(800);
            const give = gm.sdk.getInventory().filter(it => it.slot >= 40 && batch.some(p => p.name === it.name));
            const [given, taken] = await Promise.all([gm.bot.trade(at.name, { give }), b.bot.trade(/./)]);
            if (!given.success || !taken.success) throw new Error(`trade: ${given.message} / ${taken.message}`);
        }
        for (const p of wearOrder(list)) {
            const item = b.sdk.getInventory().find(i => i.slot >= 40 && i.name === p.name);
            if (item) await b.bot.equipItem(item, { slot: p.slot });
        }
        log(`${at.name} wears ${b.sdk.getEquipment().filter(e => /^Thidranki/.test(e.name)).length} of ${list.length}; hp ${me(b).maxHealth}`);
    }
}

interface Case { name: string; order: SongKind[]; everyMs?: number; foe: 'dummy' | 'warrior'; barrier?: boolean; noStyle?: boolean; kit?: boolean }

await withBots([gm, paladin, cleric, sorcerer, cabalist, warrior], gw, async () => {
    await gm.sdk.sendCommand(`/jump to ${X} ${Y} ${Z} 252`);
    await Bun.sleep(1500);
    for (const [b, x, y] of [[paladin, X, Y], [cleric, X + 100, Y + 100], [sorcerer, X + 100, Y], [cabalist, X, Y + 100], [warrior, X + 2500, Y]] as const) { await place(b, x, y); await Bun.sleep(800); }
    await Bun.sleep(3000);
    for (const [b, c] of [[paladin, 'Paladin'], [cleric, 'Cleric'], [sorcerer, 'Sorcerer'], [cabalist, 'Cabalist'], [warrior, 'Warrior']] as const) await onTarget(b, `/player class ${c}`);
    await Bun.sleep(1000);
    for (const b of [paladin, cleric, sorcerer, cabalist, warrior]) { await onTarget(b, '/player level 24'); await onTarget(b, '/heal'); }
    await Bun.sleep(1500);
    const specsOf = new Map<LiveBot, Record<string, number>>();
    const buffer = getBuild('Cleric', getClassBuilds('Cleric')!.builds[0]!.name)!.targets.find(t => t.level >= 24)!.specs;
    for (const [b, specs] of [[paladin, getBuild('Paladin', 'Chants and sword')!.targets.find(t => t.level >= 24)!.specs], [cleric, buffer], [warrior, { Axe: 24, Shields: 15, Parry: 8 }]] as const) {
        // By /train, line by line: trainBuild stops at a line whose level the snapshot does not show yet, though the server took it.
        for (const [line, level] of Object.entries(specs)) { await b.sdk.sendCommand(`/train ${line.replace(/s$/, '')} ${level}`); await Bun.sleep(1500); }
        log(`${me(b).name} ${JSON.stringify(specs)}: ${me(b).specPoints} points left`);
        specsOf.set(b, specs);
    }
    await gearUp(specsOf);
    await gm.sdk.sendCommand(`/jump to ${X} ${Y} ${Z} 252`);
    await Bun.sleep(1500);
    const asMember = (b: LiveBot, role: 'tank' | 'healer' | 'nuker') => ({ bot: b.username, role, sdk: b.sdk, actions: b.bot });
    log(`group: ${(await formGroup([asMember(paladin, 'tank'), asMember(cleric, 'healer'), asMember(sorcerer, 'nuker'), asMember(cabalist, 'nuker')])).join('; ')}`);
    await place(sorcerer, X, Y + 1200); await place(cabalist, X, Y - 1700);
    await Bun.sleep(1500);

    await gm.sdk.sendCommand(`/jump to ${X + 70} ${Y} ${Z} 252`);
    await Bun.sleep(1000);
    const oldMobs = new Set(paladin.sdk.getNearbyNpcs().map(n => n.objectId));
    await gm.sdk.sendCommand('/mob create DOL.GS.GameTrainingDummy');
    await Bun.sleep(1500);
    const dummy = paladin.sdk.getNearbyNpcs().find(n => /New Mob/i.test(n.name) && !oldMobs.has(n.objectId));
    if (!dummy) throw new Error(`no new dummy near: ${paladin.sdk.getNearbyNpcs().map(n => n.name).join(', ')}`);
    await gm.sdk.sendSetTarget(dummy.objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand('/mob peace');
    await gm.sdk.sendCommand(`/jump to ${X + 2500} ${Y + 500} ${Z} 252`);
    await Bun.sleep(1000);
    await paladin.sdk.sendCommand('/combatstats on');
    await cleric.sdk.sendCommand('/combatstats on');

    const book = new Spellbook(paladin.sdk, paladin.bot);
    const chants = () => book.songs();
    const of = (k: SongKind) => chants().find(c => c.kind === k)!;
    log(`chants: ${chants().map(c => `${c.kind}=${c.spell.name} cast ${c.castTime} freq ${c.frequency} level ${c.spell.level}`).join(', ')}`);
    const names = () => chants().filter(c => c.kind !== 'speed').map(c => c.spell.name);
    const send = (k: SongKind) => { const c = of(k); return c.spell.skillIndex !== undefined ? paladin.sdk.sendUseSkill(c.spell.skillIndex) : paladin.sdk.sendCastSpell(c.spell.lineIndex, c.spell.spellIndex); };
    const style = paladin.sdk.findStyle(/^Uppercut$/i);
    const barrier = cleric.sdk.findSpell(/^Blessed Barrier$/);
    log(`style: ${style?.name}; barrier: ${barrier?.name ?? 'none'}; power ${me(paladin).maxMana}; endurance ${me(paladin).maxEndurance}`);

    const rows: Record<string, unknown>[] = [];
    async function run(c: Case) {
        label = c.name;
        await paladin.sdk.sendAttack(false);
        await Bun.sleep(7000); // Whatever the last case left runs out.
        for (const b of [paladin, cleric, warrior]) await onTarget(b, '/heal');
        // The Cleric's Blessed Barrier is a spec AF too, of the chant's effect group.
        const barrierOn = () => (cleric.sdk.getState()?.effects ?? []).some(e => e.name === 'Blessed Barrier');
        if (!!c.barrier !== barrierOn() && barrier) { const r = await cleric.bot.castSpell(barrier, me(cleric).objectId); log(`  barrier ${c.barrier ? 'on' : 'off'}: ${r.message}`); await Bun.sleep(500); }
        if (c.foe === 'warrior') {
            await place(warrior, X + 100, Y + 160);
            await Bun.sleep(12_000); // PvP immunity after the jump.
            log(`  warrior on cleric: ${(await warrior.bot.attack(me(cleric).objectId, { timeout: 8000 })).message}`);
            log(`  paladin on warrior: ${(await paladin.bot.attack(me(warrior).objectId, { timeout: 8000 })).message}`);
        } else {
            await place(warrior, X + 2500, Y);
            log(`  paladin on dummy: ${(await paladin.bot.attack(dummy!.objectId, { timeout: 8000 })).message}`);
        }
        const keepUp = c.foe === 'warrior' ? setInterval(() => { void onTarget(cleric, '/heal').then(() => onTarget(warrior, '/heal')); }, 12_000) : null;
        for (const b of inbox.values()) b.length = 0;
        const start = { end: me(paladin).endurancePercent, mana: me(paladin).manaPercent };
        const on = new Map<LiveBot, Record<string, number>>(), multi = new Map<LiveBot, number[]>();
        for (const b of [paladin, cleric, sorcerer, cabalist]) { on.set(b, {}); multi.set(b, []); }
        let samples = 0, dropped = 0;
        const trace: number[] = [];
        const tracing = setInterval(() => trace.push(me(paladin).endurancePercent), 5000);
        const list = names();
        const watch = setInterval(() => {
            samples++;
            if (!me(paladin).attacking) dropped++;
            for (const b of on.keys()) {
                const now = (b.sdk.getState()?.effects ?? []).map(e => e.name).filter(n => list.includes(n));
                for (const n of now) on.get(b)![n] = (on.get(b)![n] ?? 0) + 1;
                multi.get(b)!.push(now.length);
            }
        }, 250);
        const styling = setInterval(() => { if (style && !c.noStyle) void paladin.sdk.sendUseSkill(style.skillIndex); }, 1000);
        // The kit's clock: the code a fight runs, on the real spellbook and client.
        const ctx = { memory: new Map(), spells: book, bot: paladin.bot, sdk: paladin.sdk, orders: () => ({ phase: 'engage' }), me: () => me(paladin), settings: {} } as unknown as MemberContext<any>;
        const clock = c.kit ? setInterval(() => twistTurn(ctx, { order: c.order, everyMs: c.everyMs! }), 250) : null;
        const until = Date.now() + caseMs;
        let i = 0, sent = 0;
        while (Date.now() < until) {
            if (!c.kit && c.order.length && (c.everyMs || i === 0)) { await send(c.order[i % c.order.length]!); sent++; i++; }
            await Bun.sleep(c.kit ? 500 : c.everyMs ?? 500);
        }
        clearInterval(watch); clearInterval(styling); clearInterval(tracing);
        if (clock) clearInterval(clock);
        if (keepUp) clearInterval(keepUp);
        const pal = inbox.get(paladin)!, cle = inbox.get(cleric)!;
        const per = (b: LiveBot) => list.map(n => Math.round(100 * (on.get(b)![n] ?? 0) / samples)).join('/');
        const af = cle.flatMap(l => { const m = /AF: ([\d.]+) \| ABS/.exec(l); return m ? [Number(m[1])] : []; });
        rows.push({
            case: c.name,
            sent,
            hits: count(pal, /and hit for \d+/),
            miss: count(pal, /^You miss/),
            dmg: sum(pal, /and hit for (\d+)/),
            extra: sum(pal, /for (\d+) extra damage/),
            styles: count(pal, /You perform your/),
            drop: dropped,
            wait: count(pal, /must wait/i),
            cancel: count(pal, /cancel your effect/i),
            end: `${start.end}>${me(paladin).endurancePercent}`,
            mana: `${start.mana}>${me(paladin).manaPercent}`,
            onPal: per(paladin), onCle: per(cleric), on1200: per(sorcerer), on1700: per(cabalist),
            mPal: mean(multi.get(paladin)!).toFixed(2), mCle: mean(multi.get(cleric)!).toFixed(2),
            hitsCle: count(cle, /hits your .* for \d+/),
            taken: sum(cle, /hits your .*? for (\d+)/),
            afCle: mean(af).toFixed(1),
            swings: count(pal, /^Attack Speed/),
            heals: count(pal, /^You heal /),
            healed: count(cle, /^You are healed by/),
            trace: trace.join(','),
        });
        log(`${c.name}: ${JSON.stringify(rows.at(-1))}`);
        await paladin.sdk.sendAttack(false);
        await warrior.sdk.sendAttack(false);
        // Sending the running one again stops it.
        if (i > 0) await send(c.order[(i - 1) % c.order.length]!);
        const running = (ctx.memory.get('songCast') as { name: string } | undefined)?.name;
        const left = running && chants().find(x => x.spell.name === running);
        if (left) await send(left.kind);
    }

    log(`order of the on-columns: ${names().join(' / ')}`);
    const all: Case[] = [
        { name: 'E 3@6.1', order: ['armor', 'combatHeal', 'damage'], everyMs: 6100, foe: 'dummy' },
        { name: 'E end+dmg@6.1', order: ['endurance', 'damage'], everyMs: 6100, foe: 'dummy' },
        { name: 'E end+dmg+heal@6.1', order: ['endurance', 'damage', 'combatHeal'], everyMs: 6100, foe: 'dummy' },
        { name: 'kit dmg+heal', order: ['damage', 'combatHeal'], everyMs: 6100, foe: 'dummy', kit: true },
        { name: 'W kit dmg+heal', order: ['damage', 'combatHeal'], everyMs: 6100, foe: 'warrior', kit: true },
        { name: 'W kit dmg+armor', order: ['damage', 'armor'], everyMs: 6100, foe: 'warrior', kit: true },
        { name: 'kit 3 fast', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'dummy', kit: true },
        { name: 'W kit 3 fast', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'warrior', kit: true },
        { name: 'W kit 3', order: ['armor', 'combatHeal', 'damage'], everyMs: 6100, foe: 'warrior', kit: true },
        { name: 'W hold damage', order: ['damage'], foe: 'warrior' },
        { name: 'plain none', order: [], foe: 'dummy', noStyle: true },
        { name: 'plain twist', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'dummy', noStyle: true },
        { name: 'none', order: [], foe: 'dummy' },
        { name: 'hold damage', order: ['damage'], foe: 'dummy' },
        { name: 'hold endurance', order: ['endurance'], foe: 'dummy' },
        { name: 'twist 4 @2.0', order: ['armor', 'combatHeal', 'damage', 'endurance'], everyMs: 2000, foe: 'dummy' },
        { name: 'twist 3 @2.7', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'dummy' },
        { name: 'twist 3 @1.0', order: ['armor', 'combatHeal', 'damage'], everyMs: 1000, foe: 'dummy' },
        { name: 'twist 2 @6.1', order: ['armor', 'damage'], everyMs: 6100, foe: 'dummy' },
        { name: 'none 2', order: [], foe: 'dummy' },
        { name: 'W none', order: [], foe: 'warrior' },
        { name: 'W armor', order: ['armor'], foe: 'warrior' },
        { name: 'W heal', order: ['combatHeal'], foe: 'warrior' },
        { name: 'W twist 3 @2.7', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'warrior' },
        { name: 'W barrier', order: [], foe: 'warrior', barrier: true },
        { name: 'W barrier armor', order: ['armor'], foe: 'warrior', barrier: true },
        { name: 'W barrier twist', order: ['armor', 'combatHeal', 'damage'], everyMs: 2700, foe: 'warrior', barrier: true },
    ];
    const wanted = process.env.CASES?.split(',');
    for (const c of all) if (!wanted || wanted.includes(c.name)) await run(c);
    console.table(rows);
    await gm.sdk.sendCommand(`/jump to ${X + 70} ${Y} ${Z} 252`);
    await Bun.sleep(800);
    await gm.sdk.sendSetTarget(dummy.objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand('/mob remove');
    if (dumpPath) await Bun.write(dumpPath, dump.map(d => JSON.stringify(d)).join('\n'));
});
process.exit(0);
