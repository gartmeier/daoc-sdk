// Live repro of the server hang from two trade adds in one server tick (learnings/trading.md
// "Trades can hang the whole server"). Two characters stand together and drop 1 copper on each
// other at the same instant, several times per window, then cancel, round after round.
//
//   bun client/dev/trade-race.ts --port=<port> [--rounds=40] [--adds=4] [--stall=30] [--user=tracea,traceb]
//
// Run it only against a throwaway stack (`bun run server:throwaway up`): a hang stops the whole
// server. Set disable_quit_timer there, or each run waits out the quit. Both characters need
// copper: they are made on the first run, so run once, give them money by SQL on the throwaway DB
// (the script prints the UPDATE), and run again.
//
// Each round: both clients send their add in the same event-loop turn, so the two 0xDD packets
// reach the server together and often land in one tick. After each pair the script waits 3 s for
// both windows to show both drops, then probes with a /say:
// - echo, so the server is alive: "unanswered", one add refused ("X is still trading with Y") or
//   the windows crossed, and the next pair goes into that state;
// - no echo: a stall. It probes until the echo comes (the watchdog cures the first stall in
//   9-12 s) or --stall seconds pass, which is the hang for good: exit 2.
// "crossed" counts pairs both sides answered with windows that disagree.
// Last, a window opened by a simultaneous pair is committed and the purses checked.
// Server without the fix (2026-11-11): unanswered in most rounds, hung for good within 15-74
// rounds. With it: 480 pairs, none unanswered, no stall, the commit right.

import { DaocClient } from '../client';
import type { BotWorldState } from '../../sdk/types';

const flag = (name: string, def: string): string =>
    process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const port = Number(flag('port', '10310'));
const rounds = Number(flag('rounds', '40'));
const addsPerWindow = Number(flag('adds', '4'));
const stallLimitMs = Number(flag('stall', '30')) * 1000;
const [userA, userB] = flag('user', 'tracea,traceb').split(',') as [string, string];

const t0 = Date.now();
const log = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

function makeClient(username: string): { c: DaocClient; state: () => BotWorldState } {
    const c = new DaocClient({ host: '127.0.0.1', port, username, password: 'trade123', realm: 'albion', className: 'Fighter', raceName: 'Briton' });
    let s = c.collectState();
    c.onStateChange(x => { s = x; });
    c.onDisconnect((reason, message) => log(`${username} DISCONNECTED: ${reason} (${message})`));
    return { c, state: () => s };
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (pred()) return true;
        await Bun.sleep(20);
    }
    return pred();
}

const A = makeClient(userA);
const B = makeClient(userB);
/** Through the ~60 s lockout a client that dropped without quitting leaves (AccountIsInLogoutProcedure). */
async function connect(c: DaocClient): Promise<void> {
    for (let i = 0; ; i++) {
        try { return await c.connect(); } catch (e) {
            if ((e as { reason?: string }).reason !== 'accountInLogout' || i >= 12) throw e;
            log(`${c.opts.username}: still logging out on the server, retry in 10 s`);
            await Bun.sleep(10_000);
        }
    }
}
await Promise.all([connect(A.c), connect(B.c)]);
await waitUntil(() => !!A.state().player && !!B.state().player, 10_000);
const pa = A.state().player!, pb = B.state().player!;
log(`${pa.name} oid ${pa.objectId} at (${pa.x}, ${pa.y}) ${pa.money.totalCopper}c; ${pb.name} oid ${pb.objectId} at (${pb.x}, ${pb.y}) ${pb.money.totalCopper}c`);

const quit = async (): Promise<void> => {
    await Promise.all([A.c.execute({ type: 'tradeCancel' }), B.c.execute({ type: 'tradeCancel' })]);
    await Promise.all([A.c.execute({ type: 'quit' }), B.c.execute({ type: 'quit' })]);
    // A stock server keeps the quit timer: wait for both to be out, or the next run's login is refused.
    await waitUntil(() => !A.c.inGame && !B.c.inGame, 30_000);
    log(A.c.inGame || B.c.inGame ? 'still in game after 30 s' : 'both quit');
    process.exit(0);
};

if (pa.money.totalCopper < 1000 || pb.money.totalCopper < 1000) {
    log('not enough copper. Give them some on the throwaway DB, then run again:');
    log(`  UPDATE DOLCharacters SET Copper=99, Silver=99, Gold=99 WHERE Name IN ('${pa.name}', '${pb.name}');`);
    await quit();
}

// Stand together: B walks onto A, then both step so each announces itself to the other.
await B.c.execute({ type: 'moveTo', x: pa.x + 30, y: pa.y, z: pa.z });
await waitUntil(() => Math.hypot(B.state().player!.x - pa.x - 30, B.state().player!.y - pa.y) < 20, 20_000);
await A.c.execute({ type: 'moveTo', x: pa.x - 10, y: pa.y, z: pa.z });
await Bun.sleep(1500);
const seen = await waitUntil(() => A.state().nearbyPlayers.some(p => p.objectId === pb.objectId)
    && B.state().nearbyPlayers.some(p => p.objectId === pa.objectId), 10_000);
if (!seen) { log('the two never saw each other'); await quit(); }

let sayN = 0;
/** Round trip through the game loop: a /say from A and its echo in A's chat. */
async function probe(timeoutMs: number): Promise<number | null> {
    const text = `probe ${++sayN}`;
    const start = Date.now();
    await A.c.execute({ type: 'say', text });
    const ok = await waitUntil(() => A.state().gameMessages.some(m => m.text.includes(text)), timeoutMs);
    return ok ? Date.now() - start : null;
}

const win = (s: BotWorldState): string => s.trade ? `#${s.trade.id} r${s.trade.revision} mine ${s.trade.myMoney} partner ${s.trade.partnerMoney}` : 'no window';
const stats = { rounds: 0, pairs: 0, crossed: 0, unanswered: 0, stalls: [] as { round: number; pair: number; ms: number | null }[] };

for (let round = 1; round <= rounds; round++) {
    stats.rounds = round;
    for (let pair = 1; pair <= addsPerWindow; pair++) {
        const before = { a: A.state().trade?.myMoney ?? 0, b: B.state().trade?.myMoney ?? 0 };
        // Same event-loop turn: both 0xDD leave back to back on two sockets.
        const sent = Date.now();
        await Promise.all([
            A.c.execute({ type: 'tradeOfferMoney', partnerObjectId: pb.objectId, copper: 1 }),
            B.c.execute({ type: 'tradeOfferMoney', partnerObjectId: pa.objectId, copper: 1 }),
        ]);
        stats.pairs++;
        const answered = await waitUntil(() => (A.state().trade?.myMoney ?? 0) > before.a && (B.state().trade?.myMoney ?? 0) > before.b, 3000);
        if (!answered) {
            // Alive or stalled? A live server echoes the /say at once.
            const alive = await probe(3000);
            if (alive !== null) {
                stats.unanswered++;
                const msgs = (s: BotWorldState): string => s.gameMessages.slice(-3).map(m => m.text).join(' | ');
                log(`round ${round} pair ${pair}: server alive, but not both adds shown: A ${win(A.state())}, B ${win(B.state())}`);
                log(`  A said: ${msgs(A.state())}`);
                log(`  B said: ${msgs(B.state())}`);
                continue;
            }
            log(`round ${round} pair ${pair}: no answer and no /say echo, probing the server...`);
            const end = Date.now() + stallLimitMs;
            let back: number | null = null;
            while (Date.now() < end && back === null) back = await probe(Math.min(5000, end - Date.now()));
            const ms = back === null ? null : Date.now() - sent;
            stats.stalls.push({ round, pair, ms });
            log(ms === null ? `  HUNG: no /say echo for ${stallLimitMs / 1000} s after the stall` : `  the server came back after ${(ms / 1000).toFixed(1)} s`);
            if (ms === null) {
                console.log(JSON.stringify(stats));
                log('the server is hung; leaving the clients as they are (restart the throwaway gameserver)');
                process.exit(2);
            }
            break;
        }
        await Bun.sleep(150);
        const ta = A.state().trade, tb = B.state().trade;
        if (!ta || !tb || ta.myMoney !== tb.partnerMoney || tb.myMoney !== ta.partnerMoney) {
            stats.crossed++;
            log(`round ${round} pair ${pair}: crossed windows: A mine ${ta?.myMoney} partner ${ta?.partnerMoney}, B mine ${tb?.myMoney} partner ${tb?.partnerMoney}`);
        }
    }
    await Promise.all([A.c.execute({ type: 'tradeCancel' }), B.c.execute({ type: 'tradeCancel' })]);
    await waitUntil(() => !A.state().trade && !B.state().trade, 5000);
    await Bun.sleep(100 + Math.random() * 100);
}

// Last, the window a simultaneous pair opened must still commit: both drop 1, A adds 2 more, both accept.
// A should end 2 copper poorer and B 2 richer.
const purse = (s: BotWorldState): number => s.player!.money.totalCopper;
const start = { a: purse(A.state()), b: purse(B.state()) };
await Promise.all([
    A.c.execute({ type: 'tradeOfferMoney', partnerObjectId: pb.objectId, copper: 1 }),
    B.c.execute({ type: 'tradeOfferMoney', partnerObjectId: pa.objectId, copper: 1 }),
]);
await waitUntil(() => A.state().trade?.myMoney === 1 && B.state().trade?.myMoney === 1, 3000);
await A.c.execute({ type: 'tradeOfferMoney', partnerObjectId: pb.objectId, copper: 2 });
await waitUntil(() => B.state().trade?.partnerMoney === 3, 3000);
await Bun.sleep(300);
await A.c.execute({ type: 'tradeAccept' });
await Bun.sleep(300);
await B.c.execute({ type: 'tradeAccept' });
const committed = await waitUntil(() => purse(A.state()) === start.a - 2 && purse(B.state()) === start.b + 2 && !A.state().trade && !B.state().trade, 5000);
const completed = A.state().gameMessages.some(m => m.text.startsWith('Trade Completed'));
log(`commit after a simultaneous open: ${committed ? 'A -2, B +2' : `purses A ${purse(A.state()) - start.a}, B ${purse(B.state()) - start.b}`}, ${completed ? '"Trade Completed" seen' : 'no "Trade Completed"'}`);
(stats as Record<string, unknown>).commit = committed && completed;

console.log(JSON.stringify(stats));
log(`done: ${stats.rounds} rounds, ${stats.pairs} pairs, ${stats.crossed} crossed, ${stats.unanswered} unanswered, ${stats.stalls.length} stalls`);
await quit();
