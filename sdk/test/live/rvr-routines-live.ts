// Live check of three routine fixes in rvr-roam: a Paladin's chants, a healer's spare nuke, and crowd-control orders only
// for a member who casts them. First a probe, with nobody else moving: does a chant stop the swing, and how many chants
// show at once when he changes chant? Then an Albion and a Midgard group of five fight in Thidranki on the real lists.
// Needs an account with PrivLevel 3 (it levels and moves the others), so run it on a throwaway stack, as in cc-group-live.ts:
//
//   LIVE_SERVER=127.0.0.1:<port> [TWIST=damage,combatHeal [TWIST_MS=6100]] bun sdk/test/live/rvr-routines-live.ts <gmAccount> [seconds]

import { getBuild, getClassBuilds } from '../../../data/builds';
import { paladin as paladinKit } from '../../classes/paladin';
import { Blackboard } from '../../group/blackboard';
import { withCharacter } from '../../group/character';
import { MemberAgent, type Member } from '../../group/member';
import { formGroup } from '../../group/roster';
import { rvrRoaming, type RvrSettings } from '../../group/rvr';
import type { SongKind } from '../../group/songs';
import { Spellbook } from '../../group/spells';
import { Coordinator } from '../../group/strategy';
import { log, startGateway, startLiveBots, withBots, type LiveBot, type LiveBotOptions } from './harness';

const [gmAccount, secondsArg] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: rvr-routines-live.ts <gmAccount> [seconds]');
const seconds = Number(secondsArg ?? 240);
const tag = Date.now() % 100000;

interface Seat { name: string; realm: string; className: string; raceName: string; role: Member['role'] }
const sides: { x: number; seats: Seat[] }[] = [
    { x: 32500, seats: [
        { name: 'mw', realm: 'midgard', className: 'Warrior', raceName: 'Troll', role: 'tank' },
        { name: 'mh', realm: 'midgard', className: 'Healer', raceName: 'Norseman', role: 'healer' },
        { name: 'ms', realm: 'midgard', className: 'Shaman', raceName: 'Troll', role: 'healer' },
        { name: 'mk', realm: 'midgard', className: 'Skald', raceName: 'Norseman', role: 'melee' },
        { name: 'mp', realm: 'midgard', className: 'Spiritmaster', raceName: 'Norseman', role: 'nuker' },
    ] },
    { x: 35500, seats: [
        { name: 'ap', realm: 'albion', className: 'Paladin', raceName: 'Briton', role: 'tank' },
        { name: 'ac', realm: 'albion', className: 'Cleric', raceName: 'Briton', role: 'healer' },
        { name: 'as', realm: 'albion', className: 'Sorcerer', raceName: 'Briton', role: 'nuker' },
        { name: 'ab', realm: 'albion', className: 'Cabalist', raceName: 'Briton', role: 'nuker' },
        { name: 'at', realm: 'albion', className: 'Theurgist', raceName: 'Briton', role: 'nuker' },
    ] },
];
const seats = sides.flatMap(s => s.seats);
const options: LiveBotOptions[] = [{ username: gmAccount }, ...seats.map(s => ({ username: `${s.name}${tag}`, realm: s.realm, className: s.className, raceName: s.raceName, showMessages: false }))];
const gw = startGateway();
const [gm, ...bots] = await startLiveBots(options, gw) as [LiveBot, ...LiveBot[]];
const me = (b: LiveBot) => b.sdk.getPlayer()!;
const seat = (name: string) => bots[seats.findIndex(s => s.name === name)]!;
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(400);
};
const asMember = (b: LiveBot, s: Seat): Member => ({ bot: b.username, role: s.role, sdk: b.sdk, actions: b.bot });

/** Counts a bot's swings that hit and its spell casts, from the server's messages. */
function tally(b: LiveBot) {
    const t = { hits: 0, casts: {} as Record<string, number> };
    // Only what comes from here on: the buffer still holds what came before.
    let last = b.sdk.getGameMessages().at(-1)?.id ?? 0;
    b.client.onStateChange(state => {
        for (const m of state.gameMessages) {
            if (m.id <= last) continue;
            last = m.id;
            if (/^You (hit|attack) /.test(m.text)) t.hits++;
            const cast = /^You cast an? (.+) spell!$/.exec(m.text);
            if (cast) t.casts[cast[1]!] = (t.casts[cast[1]!] ?? 0) + 1;
        }
    });
    return t;
}

await withBots([gm, ...bots], gw, async () => {
    await gm.sdk.sendCommand('/jump to 34000 32000 4400 252');
    await Bun.sleep(1500);
    for (const [i, s] of seats.entries()) {
        const side = sides.find(x => x.seats.includes(s))!;
        await gm.sdk.sendCommand(`/jump ${me(bots[i]!).name} to ${side.x} ${32000 + 60 * side.seats.indexOf(s)} 4400 252`);
        await Bun.sleep(800);
    }
    await Bun.sleep(3000);
    // The class change resets the level (player.cs SetClass), so it comes first.
    for (const [i, s] of seats.entries()) await onTarget(bots[i]!, `/player class ${s.className}`);
    await Bun.sleep(1000);
    for (const b of bots) { await onTarget(b, '/player level 24'); await onTarget(b, '/heal'); }
    await Bun.sleep(1500);
    for (const [i, s] of seats.entries()) {
        const catalogue = getClassBuilds(s.className)?.builds[0];
        const build = s.className === 'Paladin' ? getBuild('Paladin', 'Chants and sword') : catalogue && getBuild(s.className, catalogue.name);
        if (build) log(`${me(bots[i]!).name} ${s.className}: ${build.name}: ${(await bots[i]!.bot.trainBuild(null, build)).message}`);
    }
    await Bun.sleep(2000);
    for (const side of sides) log(`group: ${(await formGroup(side.seats.map(s => asMember(seat(s.name), s)))).join('; ')}`);

    // ── Probe: the Paladin swings at a Warrior who stands still ──
    const paladin = seat('ap'), cleric = seat('ac'), warrior = seat('mw');
    const chants = new Spellbook(paladin.sdk, paladin.bot).songs();
    log(`chants: ${chants.map(c => `${c.kind}=${c.spell.name} (cast ${c.castTime}, freq ${c.frequency}, skill ${c.spell.skillIndex ?? '-'})`).join(', ')}`);
    const names = new Set(chants.map(c => c.spell.name));
    const onHim = (b: LiveBot) => (b.sdk.getState()?.effects ?? []).map(e => e.name).filter(n => names.has(n));
    const send = (c: (typeof chants)[number]) => (c.spell.skillIndex !== undefined ? paladin.sdk.sendUseSkill(c.spell.skillIndex) : paladin.sdk.sendCastSpell(c.spell.lineIndex, c.spell.spellIndex));
    await gm.sdk.sendCommand(`/jump ${me(warrior).name} to ${Math.round(me(paladin).x) + 60} ${Math.round(me(paladin).y)} 4400 252`);
    await Bun.sleep(12_000); // PvP immunity after the jumps and the class change.
    const swings = tally(paladin);
    const attack = await paladin.bot.attack(me(warrior).objectId, { timeout: 8000 });
    log(`attack: ${attack.success} ${attack.message}`);
    const keepUp = setInterval(() => { void onTarget(warrior, '/heal'); }, 8000);
    let dropped = 0;
    const watching = setInterval(() => { if (!me(paladin).attacking) dropped++; }, 250);
    await Bun.sleep(16_000);
    const before = swings.hits;
    log(`16 s of swings, no chant: ${before} hits`);
    await send(chants.find(c => c.kind === 'endurance')!);
    await Bun.sleep(16_000);
    log(`16 s of swings, a chant sent raw at the start: ${swings.hits - before} hits; samples not attacking so far: ${dropped}; on him: ${onHim(paladin).join(', ')}`);
    clearInterval(watching);
    // Changing chant every 2 s: the new one ends the running pulse, and what the old one already put on the group runs out by itself.
    const round = chants.filter(c => c.kind !== 'speed');
    let most = 0, mostOnCleric = 0;
    for (let i = 0; i < 12; i++) {
        await send(round[i % round.length]!);
        await Bun.sleep(2000);
        const mine = onHim(paladin), hers = onHim(cleric);
        most = Math.max(most, mine.length);
        mostOnCleric = Math.max(mostOnCleric, hers.length);
        log(`  twist ${i}: sent ${round[i % round.length]!.spell.name}; on him [${mine.join(', ')}], on the Cleric [${hers.join(', ')}]`);
    }
    log(`most chants at once while changing every 2 s: ${most} on him, ${mostOnCleric} on the Cleric (of ${round.length})`);
    // Left alone with the last one: only that one stays.
    for (let i = 0; i < 5; i++) { await Bun.sleep(3000); log(`  after ${(i + 1) * 3} s: on him [${onHim(paladin).join(', ')}]`); }
    clearInterval(keepUp);
    await paladin.sdk.sendAttack(false);
    await paladin.sdk.sendStop();
    await send(round[11 % round.length]!); // Sending the running chant again stops it.

    // ── The fight, on the real lists ──
    await gm.sdk.sendCommand(`/jump ${me(warrior).name} to 32500 32000 4400 252`);
    for (const b of bots) await onTarget(b, '/heal');
    await Bun.sleep(12_000);
    log(`lists: tank ${rvrRoaming.behaviors.tank!.map(b => b.name).join(',')}; healer ${rvrRoaming.behaviors.healer!.map(b => b.name).join(',')}`);
    const tallies = new Map(seats.map((s, i) => [s.name, tally(bots[i]!)]));
    const stop = new AbortController();
    const settings = rvrRoaming.settings as RvrSettings;
    const loops: Promise<unknown>[] = [];
    const agents = new Map<string, MemberAgent<RvrSettings>>();
    const ordersBy: Record<string, number> = {};
    let orderLines = 0;
    const boards: Blackboard[] = [];
    for (const side of sides) {
        const board = new Blackboard(rvrRoaming.board);
        boards.push(board);
        board.onOrders(next => { orderLines++; for (const a of next.cc) ordersBy[a.by] = (ordersBy[a.by] ?? 0) + 1; });
        for (const s of side.seats) {
            // TWIST names the kinds his kit twists; without it he plays his list's song().
            const list = s.name === 'ap' && process.env.TWIST ? withCharacter(rvrRoaming.behaviors.tank!, paladinKit({ twist: { order: process.env.TWIST.split(',') as SongKind[], everyMs: Number(process.env.TWIST_MS ?? 6100) } })) : rvrRoaming.behaviors[s.role]!;
            const agent = new MemberAgent(asMember(seat(s.name), s), board, list, settings, rvrRoaming.agent);
            agents.set(s.name, agent);
            loops.push(agent.run(stop.signal).catch(e => log(`agent ${s.name}: ${e}`)));
        }
        loops.push(new Coordinator(board, rvrRoaming, settings).run(stop.signal).catch(e => log(`coordinator: ${e}`)));
    }
    log(`capabilities: ${seats.map(s => `${s.className} cc=${(agents.get(s.name) as unknown as { capabilities: { cc: boolean } }).capabilities.cc}`).join(', ')}`);
    const chantTime: Record<string, number> = {};
    let lowestPower = 100, engaged = 0, enduranceSum = 0, enduranceMin = 100, samples = 0, clericAlive = 0;
    const clericSkips: Record<string, number> = {};
    const sampler = setInterval(() => {
        samples++;
        for (const n of onHim(paladin)) chantTime[n] = (chantTime[n] ?? 0) + 1;
        const e = me(paladin).endurancePercent;
        enduranceSum += e; enduranceMin = Math.min(enduranceMin, e);
        if (boards[1]!.picture(Date.now()).orders.phase === 'engage') { engaged++; if (!me(cleric).isDead) { clericAlive++; lowestPower = Math.min(lowestPower, me(cleric).manaPercent); const skip = agents.get('ac')!.lastSkip; if (skip) clericSkips[skip] = (clericSkips[skip] ?? 0) + 1; } }
    }, 1000);
    log(`fighting for ${seconds} s`);
    await Bun.sleep(seconds * 1000);
    clearInterval(sampler);
    stop.abort(new Error('done'));
    await Promise.allSettled(loops);
    console.log('\n=== Fight ===');
    console.table(seats.map(s => {
        const a = agents.get(s.name) as unknown as { combat: { dealt: number; styles: Record<string, number> } };
        const t = tallies.get(s.name)!;
        return { who: s.className, dealt: a.combat.dealt, styles: Object.values(a.combat.styles).reduce((n, v) => n + v, 0), casts: Object.entries(t.casts).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ') };
    }));
    console.log(`order lines ${orderLines}; crowd-control orders by member: ${JSON.stringify(Object.fromEntries(Object.entries(ordersBy).map(([k, v]) => [k, v])))} (the Skald is ${me(seat('mk')).name})`);
    console.log(`names: ${seats.map(s => `${s.className}=${me(seat(s.name)).name}`).join(', ')}`);
    console.log(`Paladin: seconds with each chant on him ${JSON.stringify(chantTime)} of ${samples}; endurance mean ${Math.round(enduranceSum / Math.max(1, samples))} %, lowest ${enduranceMin} %`);
    console.log(`Cleric: lowest power in a fight ${lowestPower} %, ${engaged} s in engage, ${clericAlive} of them alive; last skip by second ${JSON.stringify(clericSkips)}`);
    for (const a of agents.values()) a.dispose();
});
process.exit(0);
