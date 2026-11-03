// Live check of resurrection: the spell, the dead side's answer, and a group's corpses. Needs an account
// with PrivLevel 3 (it kills on command and levels the others), so run it on a throwaway stack:
//
//   bun run server:throwaway up                        (prints the game and db ports)
//   docker exec daoc-throwaway-<name>-db-1 mariadb -uroot -pdaoc-sdk opendaoc -e "INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('<gmAccount>','<gmAccount>pw',NOW(),3,UUID());"
//   LIVE_SERVER=127.0.0.1:<port> bun sdk/test/live/rez-live.ts <gmAccount>

import { Blackboard } from '../../group/blackboard';
import { defaultBehaviors, type TacticsSettings } from '../../group/behaviors';
import { MemberAgent, type Member } from '../../group/member';
import { PVE_SETTINGS } from '../../group/pve';
import { log, startGateway, startLiveBots, withBots, type LiveBot } from './harness';

const [gmAccount] = process.argv.slice(2);
if (!gmAccount) throw new Error('usage: rez-live.ts <gmAccount>');
const tag = Date.now() % 100000;
const results: Record<string, string> = {};
const check = (name: string, pass: boolean, detail = ''): void => {
    results[name] = `${pass ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}`;
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (['messages', 'target', 'spell', 'cast'].includes(k) ? undefined : v)).slice(0, 300);

const gw = startGateway();
const [gm, healer, victim, second] = await startLiveBots([
    { username: gmAccount },
    { username: `rezh${tag}`, className: 'Cleric', raceName: 'Briton' },
    { username: `rezv${tag}` },
    { username: `rezw${tag}`, className: 'Cleric', raceName: 'Briton' },
], gw) as [LiveBot, LiveBot, LiveBot, LiveBot];

const me = (b: LiveBot) => b.sdk.getPlayer()!;
/** Have the GM run a command on a bot. */
const onTarget = async (b: LiveBot, command: string): Promise<void> => {
    await gm.sdk.sendSetTarget(me(b).objectId);
    await Bun.sleep(300);
    await gm.sdk.sendCommand(command);
    await Bun.sleep(500);
};
const kill = async (b: LiveBot): Promise<void> => {
    await onTarget(b, '/player kill');
    await b.sdk.waitForCondition(s => !!s.player?.isDead, 5000);
    await healer.sdk.waitForCondition(s => !!s.nearbyPlayers.find(p => p.objectId === me(b).objectId)?.isDead, 5000).catch(() => null);
};
const refill = (b: LiveBot) => onTarget(b, '/heal');
const offer = (b: LiveBot) => b.sdk.waitForCondition(s => !!s.dialog?.isOpen && !!s.dialog.resurrection, 10_000);

await withBots([gm, healer, victim, second], gw, async () => {
    // A stationary player is only announced on AddToWorld; nudge everyone so each sees the others.
    for (const [i, b] of [gm, healer, victim, second].entries()) await b.bot.walkTo(me(b).x + 60 * (i + 1), me(b).y);
    await Bun.sleep(1500);
    for (const b of [healer, second]) await onTarget(b, '/player level 15');
    await onTarget(victim, '/player level 15');
    await Bun.sleep(1500);
    for (const b of [healer, second, victim]) log(`${me(b).name} L${me(b).level} ${me(b).className} mana ${me(b).mana}/${me(b).maxMana}`);
    await healer.sdk.waitForCondition(s => s.skills.spells.length > 0, 5000).catch(() => null);
    const spell = healer.bot.resurrectSpell();
    check('resurrectSpell', !!spell, `${spell?.name} L${spell?.level} ${spell?.lineName} id ${spell?.internalId}; info ${JSON.stringify(spell && healer.bot.getSpellInfo(spell))?.slice(0, 120)}; all: ${healer.sdk.getSkills().spells.map(s => s.name).join(', ')}`);
    if (!spell) return;

    const alive = await healer.bot.resurrect(me(victim).objectId);
    check('refuses the living', alive.reason === 'not_dead', brief(alive));
    const raw = await healer.bot.castSpell(spell, me(victim).objectId);
    check('the server refuses the living: not_dead', raw.reason === 'not_dead', brief(raw));

    await kill(victim);
    const corpse = healer.sdk.getNearbyPlayer(me(victim).objectId);
    check('the corpse stays in view, dead', !!corpse?.isDead, JSON.stringify({ isDead: corpse?.isDead, hp: corpse?.healthPercent, distance: corpse?.distance }));
    await refill(healer);

    // An idle corpse: the cast finishes and nobody answers.
    const m0 = me(healer).mana;
    const unanswered = await healer.bot.resurrect(me(victim).objectId);
    check('no answer', unanswered.reason === 'no_answer' && !!unanswered.cast?.success, `${brief(unanswered)}; mana ${m0} -> ${me(healer).mana} of ${me(healer).maxMana}`);
    log(`victim's box: ${JSON.stringify(victim.sdk.getState()?.dialog)}`);
    await victim.sdk.waitForCondition(s => s.gameMessages.some(g => /resurrection spell has expired/i.test(g.text)), 5000).catch(() => null);
    check('the question expires and closes', victim.sdk.getResurrectionOffer() === null, JSON.stringify(victim.sdk.getState()?.dialog));

    // The earlier box was left unanswered: the next rez fires its stale callback (PacketLib168.cs:1511-1512).
    await refill(healer);
    const castAgain = healer.bot.resurrect(me(victim).objectId, { answerMs: 6000 });
    await offer(victim);
    const poisoned = await victim.bot.acceptResurrection({ timeout: 0 });
    const again = await castAgain;
    check('after an unanswered box the next rez fails (reading of PacketLib168)', poisoned.reason === 'expired', `accept ${brief(poisoned)}; caster ${brief(again)}; mana ${me(healer).mana}`);

    // Asked and answered yes.
    await Bun.sleep(1000);
    await refill(healer);
    const before = { ...me(victim) };
    const casting = healer.bot.resurrect(me(victim).objectId);
    const accepted = await victim.bot.acceptResurrection({ timeout: 10_000 });
    const rezzed = await casting;
    await Bun.sleep(800);
    const v = me(victim), h = me(healer);
    check('accept', accepted.success, brief(accepted));
    check('resurrect sees it', rezzed.success, brief(rezzed));
    check('alive, at the caster', !v.isDead && Math.hypot(v.x - h.x, v.y - h.y) < 100, `hp ${v.healthPercent} mana ${v.manaPercent} end ${v.endurancePercent}; ${Math.round(Math.hypot(v.x - h.x, v.y - h.y))} from the caster, ${Math.round(Math.hypot(v.x - before.x, v.y - before.y))} from the corpse; deaths ${before.deathCount} -> ${v.deathCount}`);
    check('caster\'s view flips', healer.sdk.getNearbyPlayer(v.objectId)?.isDead === false, JSON.stringify(healer.sdk.getNearbyPlayer(v.objectId)?.healthPercent));
    check('box closed after the revive', victim.sdk.getResurrectionOffer() === null);
    log(`effects: ${JSON.stringify(victim.sdk.getState()?.effects.map(e => e.name))}; con lost ${v.constitutionLost}`);
    const walk = await victim.bot.walkTo(v.x + 100, v.y);
    check('a rezzed bot walks', walk.success, walk.message);
    log(`caster's messages: ${healer.sdk.getGameMessages().slice(-6).map(g => g.text).join(' | ')}`);

    // A "no" refunds the caster.
    await kill(victim);
    await refill(healer);
    const m1 = me(healer).mana;
    const declined = healer.bot.resurrect(me(victim).objectId, { answerMs: 4000 });
    await offer(victim);
    const said = await victim.bot.respondToDialog(false);
    const seen = await declined;
    await Bun.sleep(800);
    check('decline refunds', said.success && seen.reason === 'no_answer' && me(healer).mana >= m1 - me(healer).maxMana * 0.1, `${brief(seen)}; mana ${m1} -> ${me(healer).mana}; victim dead ${me(victim).isDead}`);

    // A second rezzer while the first's question is open.
    await refill(healer);
    await refill(second);
    const first = healer.bot.resurrect(me(victim).objectId, { answerMs: 8000 });
    await offer(victim);
    const other = await second.bot.resurrect(me(victim).objectId, { answerMs: 1000 });
    check('already considering', other.reason === 'already_considering', brief(other));
    await victim.bot.acceptResurrection({ timeout: 0 });
    await first;

    // A group: real behaviour lists on a real board, phase recover. The corpse waits and is brought back by itself.
    const board = new Blackboard();
    const settings: TacticsSettings = PVE_SETTINGS;
    const lists = defaultBehaviors();
    const member = (b: LiveBot, role: 'healer' | 'melee'): Member => ({ bot: b.username, role, sdk: b.sdk, actions: b.bot });
    const anchor = { x: me(healer).x, y: me(healer).y, z: me(healer).z };
    const agents = [new MemberAgent(member(healer, 'healer'), board, lists.healer, settings), new MemberAgent(member(victim, 'melee'), board, lists.melee, settings)];
    const events: string[] = [];
    board.onEvent(e => { if (e.kind !== 'activity') events.push(`${e.member ?? ''}: ${e.text}`); });
    board.setOrders({ phase: 'recover', anchor, facing: null, reason: 'live check' });
    const stop = new AbortController();
    const loops = agents.map(a => a.run(stop.signal).catch(e => log(`agent: ${e}`)));
    await Bun.sleep(2000);
    await kill(victim);
    const deaths0 = me(victim).deathCount;
    const t0 = Date.now();
    const back = await victim.sdk.waitForCondition(s => !!s.player && !s.player.isDead, 90_000).then(() => true).catch(() => false);
    const away = Math.round(Math.hypot(me(victim).x - me(healer).x, me(victim).y - me(healer).y));
    const took = Date.now() - t0;
    await Bun.sleep(3000); // The rezzer's result comes after the corpse is back.
    check('group: rezzed without a release', back && me(victim).deathCount === deaths0 && away < 100, `${took} ms, ${away} from the healer; hp ${me(victim).healthPercent}`);
    check('group: capability on the board', board.picture().members.find(m => m.name === me(healer).name)?.capabilities.rez === true);
    check('group: the result and the note', events.some(e => /^.*: rez: ok/.test(e)) && events.some(e => /resurrected/.test(e)) && events.some(e => /accept_rez: ok/.test(e)), events.join(' / ').slice(0, 400));

    // The healer dies too: nobody is left to rez the corpse, so it releases at once.
    await kill(victim);
    await kill(healer);
    const released = await victim.sdk.waitForCondition(s => !!s.player && !s.player.isDead, 40_000).then(() => true).catch(() => false);
    check('group: no rezzer left, it releases', released, events.slice(-4).join(' / ').slice(0, 300));
    await healer.sdk.waitForCondition(s => !!s.player && !s.player.isDead, 40_000).catch(() => null);
    stop.abort(new Error('done'));
    await Promise.allSettled(loops);
    for (const a of agents) a.dispose();
});

console.log('\n=== Results ===');
for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
process.exit(0);
