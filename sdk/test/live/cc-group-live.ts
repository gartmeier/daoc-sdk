// Live check of a group's crowd control: two five-bot groups with the rvr-roam strategy fight in Thidranki, and each
// bot's own client tallies what the server answered to its crowd-control casts. The tally reads only game messages, so
// it counts the same way on any version of sdk/group. Needs an account with PrivLevel 3 (it levels, moves and refills
// the others) and `bg_release_to_portal_keep` on, so run it on a throwaway stack:
//
//   bun run server:throwaway up                        (prints the game and db ports)
//   docker exec daoc-throwaway-<name>-db-1 mariadb -uroot -pdaoc-sdk opendaoc -e "INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('<gmAccount>','<gmAccount>pw',NOW(),3,UUID()); UPDATE serverproperty SET Value='True' WHERE \`Key\`='bg_release_to_portal_keep';"
//   docker restart daoc-throwaway-<name>-gameserver-1
//   LIVE_SERVER=127.0.0.1:<port> bun sdk/test/live/cc-group-live.ts <gmAccount> [seconds]

import { getBuild, getClassBuilds } from '../../../data/builds';
import { Blackboard } from '../../group/blackboard';
import { MemberAgent, type Member } from '../../group/member';
import { rvrRoaming, type RvrSettings } from '../../group/rvr';
import { spellsOf } from '../../group/spells';
import { Coordinator } from '../../group/strategy';
import { log, startGateway, startLiveBots, withBots, type LiveBot, type LiveBotOptions } from './harness';

const [gmAccount, secondsArg] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: cc-group-live.ts <gmAccount> [seconds]');
const seconds = Number(secondsArg ?? 240);
const tag = Date.now() % 100000;
const CC_TYPES = /^(Mesmerize|Stun|SpeedDecrease|UnbreakableSpeedDecrease)$/;

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
        { name: 'hh', realm: 'hibernia', className: 'Hero', raceName: 'Celt', role: 'tank' },
        { name: 'hd', realm: 'hibernia', className: 'Druid', raceName: 'Celt', role: 'healer' },
        { name: 'hb', realm: 'hibernia', className: 'Bard', raceName: 'Celt', role: 'support' },
        { name: 'hm', realm: 'hibernia', className: 'Mentalist', raceName: 'Celt', role: 'nuker' },
        { name: 'he', realm: 'hibernia', className: 'Enchanter', raceName: 'Elf', role: 'nuker' },
    ] },
];
const seats = sides.flatMap(s => s.seats);
const options: LiveBotOptions[] = [{ username: gmAccount }, ...seats.map(s => ({ username: `${s.name}${tag}`, realm: s.realm, className: s.className, raceName: s.raceName, showMessages: false }))];
const gw = startGateway();
const [gm, ...bots] = await startLiveBots(options, gw) as [LiveBot, ...LiveBot[]];
const me = (b: LiveBot) => b.sdk.getPlayer()!;
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(400);
};

interface Tally { casts: number; landed: number; immune: number; alreadyOn: number; resisted: number }
const tallies = new Map<LiveBot, Tally>();
const ccNames = new Map<LiveBot, Set<string>>();
const watch = (b: LiveBot) => {
    const t: Tally = { casts: 0, landed: 0, immune: 0, alreadyOn: 0, resisted: 0 };
    tallies.set(b, t);
    let last = 0;
    // Set while a crowd-control cast's answer is due: it is the first of these after "You cast a ...".
    let pending = false;
    b.client.onStateChange(state => {
        for (const m of state.gameMessages) {
            if (m.id <= last) continue;
            last = m.id;
            const cast = /^You cast an? (.+) spell!$/.exec(m.text);
            if (cast) {
                pending = !!ccNames.get(b)?.has(cast[1]!);
                if (pending) t.casts++;
                continue;
            }
            if (!pending) continue;
            if (/your target is immune to this effect/i.test(m.text)) { t.immune++; pending = false; }
            else if (/already has that effect/i.test(m.text)) { t.alreadyOn++; pending = false; }
            else if (/resists the|resist the effect/i.test(m.text)) { t.resisted++; pending = false; }
            else if (m.type === 'spell') { t.landed++; pending = false; }
        }
    });
};

await withBots([gm, ...bots], gw, async () => {
    await gm.sdk.sendCommand('/jump to 34000 32000 4400 252');
    await Bun.sleep(1500);
    for (const [i, s] of seats.entries()) {
        const b = bots[i]!;
        const side = sides.find(x => x.seats.includes(s))!;
        await gm.sdk.sendCommand(`/jump ${me(b).name} to ${side.x} ${32000 + 60 * side.seats.indexOf(s)} 4400 252`);
        await Bun.sleep(800);
    }
    await Bun.sleep(3000);
    // The class change resets the level (player.cs SetClass), so it comes first.
    for (const [i, s] of seats.entries()) await onTarget(bots[i]!, `/player class ${s.className}`);
    await Bun.sleep(1000);
    for (const b of bots) { await onTarget(b, '/player level 24'); await onTarget(b, '/heal'); }
    await Bun.sleep(1500);
    for (const [i, s] of seats.entries()) {
        const b = bots[i]!;
        const catalogue = getClassBuilds(s.className)?.builds[0];
        const build = catalogue && getBuild(s.className, catalogue.name);
        if (build) {
            const r = await b.bot.trainBuild(null, build);
            log(`${me(b).name} ${s.className}: ${build.name}: ${r.message}`);
        }
    }
    await Bun.sleep(2000);
    for (const [i, s] of seats.entries()) {
        const b = bots[i]!;
        ccNames.set(b, new Set(spellsOf(b.sdk, b.bot).filter(p => p.target === 'Enemy' && CC_TYPES.test(p.type) && p.radius === 0 && (p.type !== 'SpeedDecrease' || p.value >= 99)).map(p => p.spell.name)));
        log(`${me(b).name} ${s.className}, ${s.role}: crowd control ${[...ccNames.get(b)!].join(', ') || 'none'}`);
        watch(b);
    }
    await Bun.sleep(9000); // PvP immunity after the port.

    const stop = new AbortController();
    const events: string[] = [];
    const settings = rvrRoaming.settings as RvrSettings;
    const loops: Promise<unknown>[] = [];
    const agents: MemberAgent<RvrSettings>[] = [];
    for (const side of sides) {
        const board = new Blackboard(rvrRoaming.board);
        board.onEvent(e => { if (e.kind === 'note' || (e.kind === 'result' && /^cc:/.test(e.text))) events.push(`${e.member ?? ''}: ${e.text}`); });
        for (const s of side.seats) {
            const b = bots[seats.indexOf(s)]!;
            const agent = new MemberAgent({ bot: b.username, role: s.role, sdk: b.sdk, actions: b.bot }, board, rvrRoaming.behaviors[s.role]!, settings, rvrRoaming.agent);
            agents.push(agent);
            loops.push(agent.run(stop.signal).catch(e => log(`agent ${b.username}: ${e}`)));
        }
        loops.push(new Coordinator(board, rvrRoaming, settings).run(stop.signal).catch(e => log(`coordinator: ${e}`)));
    }
    log(`fighting for ${seconds} s`);
    for (let left = seconds; left > 0; left -= 30) {
        await Bun.sleep(Math.min(30, left) * 1000);
        log(`${left - Math.min(30, left)} s left: ${[...tallies.values()].reduce((n, t) => n + t.casts, 0)} crowd-control casts so far`);
    }
    stop.abort(new Error('done'));
    await Promise.allSettled(loops);
    for (const a of agents) a.dispose();

    const rows = seats.map((s, i) => ({ who: s.className, ...tallies.get(bots[i]!)! }));
    const sum = (k: keyof Tally) => rows.reduce((n, r) => n + r[k], 0);
    console.log('\n=== Crowd control, by the server\'s answers ===');
    console.table(rows);
    console.log(`TOTAL casts ${sum('casts')}, landed ${sum('landed')}, immune ${sum('immune')}, already on ${sum('alreadyOn')}, resisted ${sum('resisted')}; wasted ${sum('immune') + sum('alreadyOn')} (${Math.round(100 * (sum('immune') + sum('alreadyOn')) / Math.max(1, sum('casts')))} %)`);
    const notes = events.reduce((m, e) => { const k = e.replace(/^[^:]*: /, '').replace(/[A-Z][a-z]+#?\d*/g, 'X').replace(/\d+/g, 'N').slice(0, 60); m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map<string, number>());
    console.log([...notes].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${n} ${k}`).join('\n'));
});
process.exit(0);
