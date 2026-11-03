// Live check of what the server does with repeated crowd control, against what sdk/group/cc.ts predicts: durations,
// immunity by kind, across casters, players against monsters. Needs an account with PrivLevel 3 (it levels, moves and
// refills the others), so run it on a throwaway stack:
//
//   bun run server:throwaway up                        (prints the game and db ports)
//   docker exec daoc-throwaway-<name>-db-1 mariadb -uroot -pdaoc-sdk opendaoc -e "INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('<gmAccount>','<gmAccount>pw',NOW(),3,UUID());"
//   LIVE_SERVER=127.0.0.1:<port> bun sdk/test/live/cc-live.ts <gmAccount> [player|npc]

import type { CastResult } from '../../actions';
import { CC_IMMUNE_MS, npcCcLanded, type NpcCcRun } from '../../group/cc';
import type { Spell } from '../../types';
import { log, startGateway, startLiveBots, withBots, type LiveBot } from './harness';

const [gmAccount, only] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: cc-live.ts <gmAccount> [player|npc]');
const tag = Date.now() % 100000;
const gw = startGateway();
const [gm, h1, h2, sh, victim] = await startLiveBots([
    { username: gmAccount },
    { username: `cch${tag}`, realm: 'midgard', className: 'Healer', raceName: 'Norseman', showMessages: false },
    { username: `cci${tag}`, realm: 'midgard', className: 'Healer', raceName: 'Norseman', showMessages: false },
    { username: `ccs${tag}`, realm: 'midgard', className: 'Shaman', raceName: 'Troll', showMessages: false },
    { username: `ccv${tag}`, showMessages: false },
], gw) as [LiveBot, LiveBot, LiveBot, LiveBot, LiveBot];
const everyone = [h1, h2, sh, victim];
// The middle of Thidranki: no guards, and players of any realm may attack each other (learnings/rvr.md).
const SPOT = { x: 34000, y: 32000, z: 4400, region: 252 };
// The top ranks at these levels, with their lengths from the spell data.
const MEZZ = 'Diversion', MEZZ_MS = 28_000, STUN = 'Halt Hostility', STUN_MS = 7000, ROOT = 'Webbing Creepers', ROOT_MS = 30_000;

const results: string[] = [];
let finished = false;
const check = (name: string, pass: boolean, detail = ''): void => {
    results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    log(results.at(-1)!);
};
const me = (b: LiveBot) => b.sdk.getPlayer()!;
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(500);
};
const spell = (b: LiveBot, name: string): Spell => {
    const s = b.sdk.getSkills().spells?.find(x => x.name === name);
    if (!s) throw new Error(`${me(b).name} has no ${name}: ${b.sdk.getSkills().spells?.map(x => x.name).join(', ')}`);
    return s;
};
const cast = async (b: LiveBot, s: string, targetId: number): Promise<CastResult> => {
    const r = await b.bot.castSpell(spell(b, s), targetId);
    log(`   ${s} by ${me(b).name}: ${r.success ? 'ok' : r.reason}${r.effectImmune ? ' immune' : ''}${r.alreadyOn ? ' already on' : ''}${r.resisted ? ' resisted' : ''}${r.effectLanded ? ` landed on ${r.landedOn}` : ''}`);
    return r;
};
/** Cast until it isn't resisted (a resist is the dice, not what this checks). */
const castThrough = async (b: LiveBot, s: string, targetId: number): Promise<CastResult> => {
    for (let i = 0; i < 12; i++) {
        const r = await cast(b, s, targetId);
        if (r.success && !r.resisted) return r;
        await Bun.sleep(1000);
    }
    throw new Error(`${s} never got through`);
};
/** ms until `b` reads `pattern`, from now. */
const until = async (b: LiveBot, pattern: RegExp, timeoutMs: number): Promise<number | null> => {
    const at = Date.now();
    const seen = b.sdk.getGameMessages().at(-1)?.id ?? 0;
    const r = await b.sdk.waitForCondition(s => s.gameMessages.some(m => m.id > seen && pattern.test(m.text)), timeoutMs).then(() => true, () => false);
    return r ? Date.now() - at : null;
};
const near = (ms: number | null, want: number, slack = 700) => ms !== null && Math.abs(ms - want) <= slack;
/** The server ends a player's spell early by its resists and the caster's hit chance (ImmunityEffectSpellHandler.cs:36, CCSpellHandler.cs:82). */
const within = (ms: number | null, most: number) => ms !== null && ms > 0 && ms <= most + 700;

await withBots([gm, ...everyone], gw, async () => {
    // The monster comes up here: out of its reach (it can't walk), within the 512 its end lines carry, and on the same z (no walk, which would adopt the terrain).
    await gm.sdk.sendCommand(`/jump to ${SPOT.x} ${SPOT.y + 350} ${SPOT.z} ${SPOT.region}`);
    await Bun.sleep(1000);
    for (const b of everyone) {
        await gm.sdk.sendCommand(`/jump ${me(b).name} to ${SPOT.x + 80 * everyone.indexOf(b)} ${SPOT.y} ${SPOT.z} ${SPOT.region}`);
        await Bun.sleep(1200);
    }
    await Bun.sleep(3000);
    for (const b of [h1, h2]) await onTarget(b, '/player class Healer');
    await onTarget(sh, '/player class Shaman');
    // The class change resets the level (player.cs SetClass).
    for (const b of everyone) { await onTarget(b, '/player level 12'); await onTarget(b, '/heal'); }
    await Bun.sleep(1500);
    for (const b of [h1, h2]) await b.bot.trainSpec(null, 'Pacification', 4);
    await sh.bot.trainSpec(null, 'Subterranean', 4);
    await Bun.sleep(1500);
    log('waiting out PvP immunity');
    await Bun.sleep(11_000);

    if (only !== 'npc') {
        const v = me(victim).objectId;
        log('=== a player');
        const first = await castThrough(h1, MEZZ, v);
        check('a landed mezz names the player by its real name', first.effectLanded === true && first.landedOn === me(victim).name, `${first.landedOn}`);
        const mezz = await until(victim, /no longer entranced/i, MEZZ_MS + 10_000);
        const end = Date.now();
        check('a mezz lasts at most its spell', within(mezz, MEZZ_MS), `${mezz} ms after the cast returned, spell ${MEZZ_MS}`);
        const r2 = await cast(h2, MEZZ, v);
        check('immune right after, for another caster', !!r2.effectImmune);
        const r3 = await cast(h1, STUN, v);
        check('a stun lands during mezz immunity: a separate kind', r3.effectLanded === true);
        const stun = await until(victim, /recover from the stun/i, 20_000);
        check('a stun lasts at most its spell', within(stun, STUN_MS), `${stun} ms, spell ${STUN_MS}`);
        const r4 = await cast(h2, STUN, v);
        check('a second stun: immune, from another caster', !!r4.effectImmune);
        const r5 = await cast(sh, ROOT, v);
        check('a root lands during both', r5.effectLanded === true, `${me(victim).maxSpeed} max speed`);
        const rootAt = Date.now();
        const r6 = await cast(sh, ROOT, v);
        check('a second root while it holds: "already has that effect", not immune', !!r6.alreadyOn && !r6.effectImmune && r6.effectLanded === false);
        let holds = 0;
        while (Date.now() - rootAt < ROOT_MS + 5000 && me(victim).maxSpeed < 191) {
            if (me(victim).maxSpeed <= 5) holds = Date.now() - rootAt;
            await Bun.sleep(250);
        }
        const rootEnd = Date.now() - rootAt;
        check('a root holds about half its time, then wears off', holds > 0 && holds < rootEnd * 0.75, `held ${holds} ms of ${rootEnd} ms, spell ${ROOT_MS}`);
        const r7 = await castThrough(sh, ROOT, v);
        check('a root right after one: immune', !!r7.effectImmune);
        // Mezz immunity, from the end of the mezz: the answer comes at the end of a cast of about 2.8 s.
        while (Date.now() - end < CC_IMMUNE_MS - 3000 - 2800) await Bun.sleep(100);
        const r8 = await cast(h1, MEZZ, v);
        check('mezz immunity still on just before 60 s', !!r8.effectImmune, `answered ${Date.now() - end} ms after the end`);
        while (Date.now() - end < CC_IMMUNE_MS + 1000 - 2800) await Bun.sleep(100);
        const r9 = await castThrough(h1, MEZZ, v);
        check('a mezz lands again once 60 s are up', r9.effectLanded === true, `landed ${Date.now() - end} ms after the end`);
        const r10 = await cast(h2, MEZZ, v);
        check('another mezz during a mezz: immune', !!r10.effectImmune);
        const hit = await h2.bot.attack(v);
        const broke = await until(victim, /no longer entranced/i, 8000);
        await h2.sdk.sendAttack(false);
        check('a melee swing breaks the mezz', hit.success && broke !== null, `${broke} ms later`);
        await Bun.sleep(3000);
        const r11 = await cast(h1, MEZZ, v);
        check('immune after a broken mezz too', !!r11.effectImmune);
    }
    if (only !== 'player') {
        log('=== a monster');
        await gm.sdk.sendCommand('/mob create DOL.GS.GameNPC');
        await Bun.sleep(1200);
        const made = gm.sdk.getNearbyNpcs().find(n => n.name === 'New Mob');
        if (!made) throw new Error('no mob');
        await gm.sdk.sendSetTarget(made.objectId);
        await Bun.sleep(300);
        // It can't walk: it is here to be mezzed, not to kill the testers.
        for (const c of ['/mob level 12', '/mob realm 0', '/mob flags 0', '/mob speed 0', '/mob name ccdummy', '/heal']) { await gm.sdk.sendCommand(c); await Bun.sleep(300); }
        await Bun.sleep(1500);
        const dummy = h1.sdk.getNearbyNpcs().find(n => /ccdummy/.test(n.name));
        if (!dummy) throw new Error(`no dummy: ${h1.sdk.getNearbyNpcs().map(n => n.name).join(', ')}`);
        for (const b of [h1, h2, sh]) await onTarget(b, '/heal');

        const m1 = await castThrough(h1, MEZZ, dummy.objectId);
        check('a landed mezz names the monster', m1.effectLanded === true && /ccdummy/.test(m1.landedOn ?? ''), `${m1.landedOn}`);
        await Bun.sleep(3000);
        const atSecond = Date.now();
        const m2 = await castThrough(h1, MEZZ, dummy.objectId);
        check('a second mezz during one: no line from the server', m2.effectLanded === false && !m2.effectImmune);
        const replaced = await until(h1, /no longer entranced/i, MEZZ_MS);
        const total = replaced === null ? null : Date.now() - atSecond;
        check('... and it replaced the first at half length', near(total, MEZZ_MS / 2 + 2800, 1500), `${total} ms from its cast start`);

        let run: NpcCcRun | undefined;
        for (let i = 1; i <= 4; i++) {
            const want = npcCcLanded(run, STUN_MS, Date.now());
            run = want.run;
            const s = await castThrough(h2, STUN, dummy.objectId);
            const lasted = s.effectLanded ? await until(h2, /recovers from the stun/i, STUN_MS + 2000) : null;
            // The cast returns about 250 ms after it landed.
            check(`stun ${i} on a monster lasts as predicted`, near(lasted, want.durationMs - 250), `${lasted} ms, predicted ${Math.round(want.durationMs)}`);
            if (i === 4) check('... and the fourth says the fifth will find it immune', want.immuneUntil !== null);
        }
        const s5 = await cast(h2, STUN, dummy.objectId);
        check('the fifth stun: immune', !!s5.effectImmune);
        const roots = [await castThrough(sh, ROOT, dummy.objectId), await castThrough(sh, ROOT, dummy.objectId)];
        check('a monster takes a root on a root: neither immune nor refused', roots.every(r => !r.effectImmune && !r.alreadyOn), roots.map(r => r.message).join(' / '));
    }
    finished = true;
});
console.log('\n=== Results ===');
for (const r of results) console.log(r);
process.exit(finished && !results.some(r => r.startsWith('FAIL')) ? 0 : 1);
