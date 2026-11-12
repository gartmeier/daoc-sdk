// Live check of the six melee and song kits of 2026-11-12 (Mercenary, Reaver, Minstrel, Champion, Valewalker, Savage):
// three realm groups at level 24, trained by their bots' builds and in the Thidranki gear template, fight on the rvr-roam
// lists with each kit in its member's list. Each side has a healer so the fights last. The report counts, per member, the
// damage it dealt, the styles it landed by name, its casts, and every kit behaviour's results from the board.
// Needs an account with PrivLevel 3 on a throwaway stack (it sets classes, levels and moves, and makes the gear):
//
//   bun run server:throwaway up --name=r7                     (prints the game and db ports)
//   docker exec daoc-throwaway-r7-db-1 mariadb -uroot -pdaoc-sdk opendaoc -e "INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('<gm>','<gm>pw',NOW(),3,UUID());"
//   LIVE_SERVER=127.0.0.1:<port> LIVE_DB=daoc-throwaway-r7-db-1 bun sdk/test/live/kits-r7-live.ts <gm> [seconds]

import { buildPath, getBuild, getClassBuilds } from '../../../data/builds';
import { champion } from '../../classes/champion';
import { cleric } from '../../classes/cleric';
import { druid } from '../../classes/druid';
import { healer } from '../../classes/healer';
import { mercenary } from '../../classes/mercenary';
import { minstrel } from '../../classes/minstrel';
import { reaver } from '../../classes/reaver';
import { savage } from '../../classes/savage';
import { valewalker } from '../../classes/valewalker';
import { warrior } from '../../classes/warrior';
import { Blackboard } from '../../group/blackboard';
import { withCharacter, type Character } from '../../group/character';
import { templateFor, templateSql, wearOrder, type TemplatePiece } from '../../group/gear-template';
import { MemberAgent, type Member } from '../../group/member';
import { formGroup } from '../../group/roster';
import { rvrRoaming, type RvrSettings } from '../../group/rvr';
import { Coordinator } from '../../group/strategy';
import { EquipmentSlot, ObjectType, type InventoryItem } from '../../types';
import { log, startGateway, startLiveBots, withBots, type LiveBot, type LiveBotOptions } from './harness';

const [gmAccount, secondsArg] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: kits-r7-live.ts <gmAccount> [seconds]');
const seconds = Number(secondsArg ?? 180);
const DB = process.env.LIVE_DB ?? 'daoc-throwaway-r7-db-1';
const tag = Date.now() % 100000;
const REGION = 252;

interface Seat { name: string; className: string; raceName: string; build?: string; role: Member['role']; kit: () => Character }
const sides: { realm: string; x: number; y: number; seats: Seat[] }[] = [
    { realm: 'albion', x: 35500, y: 32000, seats: [
        { name: 'am', className: 'Mercenary', raceName: 'Briton', build: 'Pure damage', role: 'melee', kit: mercenary },
        { name: 'ar', className: 'Reaver', raceName: 'Briton', build: 'Flex, shield and tap', role: 'melee', kit: reaver },
        { name: 'an', className: 'Minstrel', raceName: 'Briton', build: 'Group thrust', role: 'support', kit: minstrel },
        { name: 'ac', className: 'Cleric', raceName: 'Briton', role: 'healer', kit: cleric },
    ] },
    { realm: 'hibernia', x: 34000, y: 34500, seats: [
        { name: 'hc', className: 'Champion', raceName: 'Celt', build: 'Valor and Large Weapons', role: 'melee', kit: champion },
        { name: 'hv', className: 'Valewalker', raceName: 'Celt', build: 'Scythe first', role: 'melee', kit: valewalker },
        { name: 'hd', className: 'Druid', raceName: 'Celt', role: 'healer', kit: druid },
    ] },
    { realm: 'midgard', x: 32500, y: 32000, seats: [
        { name: 'ms', className: 'Savage', raceName: 'Norseman', build: 'Hand to Hand first', role: 'melee', kit: savage },
        { name: 'mw', className: 'Warrior', raceName: 'Norseman', role: 'tank', kit: warrior },
        { name: 'mh', className: 'Healer', raceName: 'Norseman', role: 'healer', kit: healer },
    ] },
];
const seats = sides.flatMap(s => s.seats);
const realmOf = (s: Seat) => sides.find(x => x.seats.includes(s))!.realm;
const KIT_ACTIONS = new Set(['kelgor', 'kudzu', 'surge', 'aura', 'auraStop', 'snare', 'debuff', 'stun', 'interrupt', 'buff']);

const options: LiveBotOptions[] = [{ username: gmAccount }, ...seats.map(s => ({ username: `${s.name}${tag}`, realm: realmOf(s), className: s.className, raceName: s.raceName, showMessages: false }))];
const gw = startGateway();
const [gm, ...bots] = await startLiveBots(options, gw) as [LiveBot, ...LiveBot[]];
const me = (b: LiveBot) => b.sdk.getPlayer()!;
const botOf = (s: Seat) => bots[seats.indexOf(s)]!;
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(400);
};
const asMember = (b: LiveBot, s: Seat): Member => ({ bot: b.username, role: s.role, sdk: b.sdk, actions: b.bot });
const inBackpack = (i: InventoryItem) => i.slot >= EquipmentSlot.FirstBackpack && i.slot <= EquipmentSlot.LastBackpack;
const buildOf = (s: Seat) => getBuild(s.className, s.build ?? getClassBuilds(s.className)?.builds[0]?.name ?? '');

async function sql(text: string): Promise<void> {
    const proc = Bun.spawn(['docker', 'exec', '-i', DB, 'mariadb', '-uroot', '-pdaoc-sdk', 'opendaoc'], { stdin: new Blob([text]), stdout: 'pipe', stderr: 'pipe' });
    if (await proc.exited) throw new Error(`SQL failed: ${await new Response(proc.stderr).text()}`);
}

/** The GM makes the pieces, a trade window at a time, and the member puts them on: gear-template.ts's deliver and wear, on this stack. */
async function dress(b: LiveBot, pieces: readonly TemplatePiece[]): Promise<string> {
    const p = me(b);
    await gm.sdk.sendCommand(`/jump to ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)} ${p.regionId}`);
    await gm.sdk.waitForCondition(() => gm.sdk.getNearbyPlayers().some(x => x.objectId === p.objectId), 15_000).catch(() => null);
    for (let i = 0; i < pieces.length; i += 10) {
        const batch = pieces.slice(i, i + 10);
        for (const piece of batch) {
            await gm.sdk.sendCommand(`/item create ${piece.id}`);
            await gm.sdk.waitForCondition(() => gm.sdk.getInventory().some(it => inBackpack(it) && it.name === piece.name), 5000).catch(() => null);
        }
        const give = gm.sdk.getInventory().filter(it => inBackpack(it) && batch.some(x => x.name === it.name));
        const [given, taken] = await Promise.all([gm.bot.trade(p.name, { give }), b.bot.trade(/./)]);
        if (!given.success || !taken.success) return `trade failed: ${given.reason} ${given.message} / ${taken.reason} ${taken.message}`;
    }
    const refused: string[] = [];
    for (const piece of wearOrder(pieces)) {
        const item = b.sdk.getInventory().find(it => inBackpack(it) && it.name === piece.name);
        if (!item) { refused.push(`${piece.name} missing`); continue; }
        await b.bot.equipItem(item, { slot: piece.slot });
        if (b.sdk.getEquipment().find(e => e.slot === piece.slot)?.name !== piece.name) refused.push(`${piece.name} refused`);
    }
    // A song needs the instrument out: put it on again last (gear-template.ts bringOutInstrument).
    const lute = b.sdk.getEquipment().find(e => e.slot === EquipmentSlot.TwoHand && e.objectType === ObjectType.Instrument);
    if (lute) {
        await b.bot.unequipItem(EquipmentSlot.TwoHand);
        const bag = b.sdk.getInventory().find(it => inBackpack(it) && it.name === lute.name);
        if (bag) await b.bot.equipItem(bag, { slot: EquipmentSlot.TwoHand });
    }
    return `wore ${pieces.length - refused.length} of ${pieces.length}${refused.length ? `: ${refused.join(', ')}` : ''}`;
}

await withBots([gm, ...bots], gw, async () => {
    await gm.sdk.sendCommand(`/jump to 34000 33000 4400 ${REGION}`);
    await Bun.sleep(1500);
    // Gathered near the GM while it dresses them, then sent to their side's start.
    for (const [i, s] of seats.entries()) {
        await gm.sdk.sendCommand(`/jump ${me(bots[i]!).name} to ${34000 + 40 * i} 33000 4400 ${REGION}`);
        await Bun.sleep(600);
    }
    await Bun.sleep(3000);
    // The class change resets the level (player.cs SetClass), so it comes first.
    for (const [i, s] of seats.entries()) await onTarget(bots[i]!, `/player class ${s.className}`);
    await Bun.sleep(1000);
    for (const b of bots) { await onTarget(b, '/player level 24'); await onTarget(b, '/heal'); }
    await Bun.sleep(1500);
    const plans = new Map<Seat, TemplatePiece[]>();
    for (const s of seats) {
        const b = botOf(s);
        const build = buildOf(s);
        if (build) log(`${me(b).name} ${s.className}: ${build.name}: ${(await b.bot.trainBuild(null, build)).message}`);
        const specs = build ? buildPath(build)[23]!.specs : {};
        plans.set(s, templateFor(s.className, realmOf(s) as never, 24, specs));
    }
    await sql(templateSql([...plans.values()].flat()));
    await gm.sdk.sendCommand('/item loadpackage thidranki24');
    await Bun.sleep(1500);
    log(`GM: ${gm.sdk.getGameMessages().at(-1)?.text ?? 'no answer'}`);
    for (const s of seats) log(`${me(botOf(s)).name} ${s.className}: ${await dress(botOf(s), plans.get(s)!)}`);
    for (const s of seats) {
        const hands: number[] = [EquipmentSlot.RightHand, EquipmentSlot.LeftHand, EquipmentSlot.TwoHand];
        const eq = botOf(s).sdk.getEquipment().filter(e => hands.includes(e.slot)).map(e => `${e.slot}:${e.name}`);
        log(`${s.className} hands: ${eq.join(', ')}; styles ${botOf(s).sdk.getSkills()?.styles.length ?? 0}`);
    }
    for (const side of sides) {
        for (const [j, s] of side.seats.entries()) {
            await gm.sdk.sendCommand(`/jump ${me(botOf(s)).name} to ${side.x + 60 * j} ${side.y} 4400 ${REGION}`);
            await Bun.sleep(600);
        }
        log(`group ${side.realm}: ${(await formGroup(side.seats.map(s => asMember(botOf(s), s)))).join('; ')}`);
    }
    await gm.sdk.sendCommand(`/jump to 34000 30000 4400 ${REGION}`);
    for (const b of bots) await onTarget(b, '/heal');
    await Bun.sleep(12_000); // PvP immunity after the jumps and the class change.

    const stop = new AbortController();
    const settings = rvrRoaming.settings as RvrSettings;
    const loops: Promise<unknown>[] = [];
    const agents = new Map<Seat, MemberAgent<RvrSettings>>();
    const boards: Blackboard[] = [];
    for (const side of sides) {
        const board = new Blackboard(rvrRoaming.board);
        boards.push(board);
        for (const s of side.seats) {
            const list = withCharacter(rvrRoaming.behaviors[s.role]!, s.kit());
            const agent = new MemberAgent(asMember(botOf(s), s), board, list, settings, rvrRoaming.agent);
            agents.set(s, agent);
            loops.push(agent.run(stop.signal).catch(e => log(`agent ${s.className}: ${e}`)));
        }
        loops.push(new Coordinator(board, rvrRoaming, settings).run(stop.signal).catch(e => log(`coordinator: ${e}`)));
    }
    log(`fighting for ${seconds} s`);
    const started = Date.now();
    const deaths = new Map<Seat, number>();
    const wasDead = new Map<Seat, boolean>();
    const sampler = setInterval(() => {
        for (const s of seats) {
            const dead = me(botOf(s)).isDead;
            if (dead && !wasDead.get(s)) deaths.set(s, (deaths.get(s) ?? 0) + 1);
            wasDead.set(s, dead);
        }
    }, 1000);
    await Bun.sleep(seconds * 1000);
    clearInterval(sampler);
    stop.abort(new Error('done'));
    await Promise.allSettled(loops);

    const results = new Map<string, Record<string, number>>();
    const effects = new Map<string, Set<string>>();
    for (const board of boards) {
        for (const e of board.events(started)) {
            if (e.kind !== 'result' || !e.member) continue;
            const d = e.data as { action?: string; success?: boolean; reason?: string | null } | undefined;
            if (!d?.action) continue;
            const r = results.get(e.member) ?? {};
            const key = `${d.action}:${d.success ? 'ok' : d.reason ?? 'failed'}`;
            r[key] = (r[key] ?? 0) + 1;
            results.set(e.member, r);
        }
    }
    for (const s of seats) effects.set(s.className, new Set((botOf(s).sdk.getState()?.effects ?? []).map(e => e.name)));
    console.log('\n=== Fight ===');
    console.table(seats.map(s => {
        const a = agents.get(s) as unknown as { combat: { dealt: number; styles: Record<string, number>; missedStyles?: number } };
        return {
            who: s.className, deaths: deaths.get(s) ?? 0, dealt: a.combat.dealt,
            styles: Object.entries(a.combat.styles).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', '),
            missed: a.combat.missedStyles ?? 0,
        };
    }));
    console.log('\n=== Kit behaviours (board results) ===');
    for (const s of seats) {
        const all = Object.entries(results.get(me(botOf(s)).name) ?? {});
        const kit = all.filter(([k]) => KIT_ACTIONS.has(k.split(':')[0]!));
        const rest = all.filter(([k]) => !KIT_ACTIONS.has(k.split(':')[0]!)).sort((a, b) => b[1] - a[1]).slice(0, 8);
        console.log(`${s.className} (${me(botOf(s)).name}): kit ${JSON.stringify(Object.fromEntries(kit))}; other ${JSON.stringify(Object.fromEntries(rest))}`);
    }
    console.log('\n=== Effects on each at the end ===');
    for (const [k, v] of effects) console.log(`${k}: ${[...v].join(', ')}`);
    for (const a of agents.values()) a.dispose();
});
process.exit(0);
