#!/usr/bin/env bun
// Group CLI: the group's shared picture, without taking control of anyone.
//
//   bun sdk/group/cli.ts <group>              members, the enemies they see, group membership
//   bun sdk/group/cli.ts <group> --watch=60   observe 60 s, then print (and save) the observer's report
//
// Uses observe-mode connections, so running scripts, MCP calls and group runs
// keep control. A watch scores whatever drives the bots, coordinated or not;
// without a coordinator it infers the phase (fighting when something attacks).

import { join } from 'path';
import { BotActions } from '../actions';
import { REPO_ROOT } from '../index';
import { Blackboard, observeState } from './blackboard';
import { formatReport, GroupObserver, saveReport } from './observer';
import { connectBot, loadGroup } from './roster';
import { Spellbook } from './spells';
import { roleForClass } from './strategy';
import { groupArgs } from './runner';
import type { Activity } from './types';

const { positional, flags } = groupArgs();
const name = positional[0];
if (!name) {
    console.error('Usage: bun sdk/group/cli.ts <group> [--watch=<seconds>]');
    process.exit(2);
}
const dir = join(REPO_ROOT, 'groups', name);
const def = loadGroup(dir);
const board = new Blackboard();
const conns: Awaited<ReturnType<typeof connectBot>>[] = [];
for (const m of def.members) {
    try {
        const c = await connectBot(m.bot, 'observe');
        conns.push(c);
        const caps = new Spellbook(c.sdk, new BotActions(c.sdk)).capabilities();
        const role = m.role ?? roleForClass(c.sdk.getPlayer()?.className ?? '');
        const publish = () => {
            const s = c.sdk.getState();
            if (!s?.player) return;
            const activity: Activity = { kind: s.player.isSitting ? 'rest' : s.player.attacking ? 'melee' : 'unknown', targetId: s.player.targetObjectId, detail: '', since: 0 };
            const obs = observeState(s, { bot: m.bot, role, activity, capabilities: caps });
            if (obs) board.publish(obs);
        };
        c.sdk.onStateUpdate(publish);
        publish();
    } catch (e) {
        console.error(`${m.bot}: ${(e as Error).message}`);
    }
}

const watch = Number(flags.watch ?? 0);
if (watch > 0) {
    const observer = new GroupObserver(board, { group: def.name, strategy: 'observed' }).start();
    console.error(`observing ${def.name} for ${watch} s...`);
    await Bun.sleep(watch * 1000);
    const report = observer.stop();
    console.log(formatReport(report));
    console.log(`saved: ${saveReport(dir, report)}`);
} else {
    await Bun.sleep(600);
    const p = board.picture();
    const leader = p.members[0];
    console.log(`Group ${def.name} (${p.members.length}/${def.members.length} members reporting)`);
    for (const m of p.members) {
        const d = leader ? Math.round(Math.hypot(m.x - leader.x, m.y - leader.y)) : 0;
        const grouped = conns.find(c => c.sdk.getPlayer()?.name === m.name)?.sdk.getGroup().map(g => g.name) ?? [];
        console.log(`  ${m.name.padEnd(12)} ${m.className.padEnd(10)} L${String(m.level).padEnd(3)} ${m.role.padEnd(7)} hp ${String(m.hp).padStart(3)}% mana ${String(m.mana).padStart(3)}% load ${String(m.load).padStart(3)}%`
            + `${m.isDead ? ' DEAD' : ''}${m.isSitting ? ' sitting' : ''}${m.inCombat ? ' in combat' : ''}  region ${m.regionId} (${m.x}, ${m.y}) ${d ? `${d} from ${leader!.name}` : ''}`
            + `  group: ${grouped.length ? grouped.join(',') : 'none'}  can: ${['heal', 'cc', 'nuke'].filter(k => (m.capabilities as any)[k]).join('/') || '-'}`);
    }
    console.log(`Enemies the group knows (${p.contacts.length}):`);
    for (const c of p.contacts.sort((a, b) => (b.target ? 1 : 0) - (a.target ? 1 : 0) || a.level - b.level).slice(0, 25)) {
        console.log(`  ${c.name.padEnd(22)} L${String(c.level).padEnd(3)} hp ${String(c.hp).padStart(3)}% (${c.x}, ${c.y})${c.target ? ` attacking ${c.target}` : ''}${c.stale ? ' stale' : ''}  seen by ${c.seenBy.join(', ') || 'nobody now'}`);
    }
}
for (const c of conns) await c.sdk.disconnect();
process.exit(0);
