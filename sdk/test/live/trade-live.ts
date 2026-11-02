// Live check of trading between two bots whose clients already run (clients restarted on the trade code,
// no group run active, same realm, PrivLevel 1). They need loot in their packs and A a stack; every check
// that moves something moves it back where that is cheap, so the packs end up about as they were. `full` is the
// exception: it leaves A's spares and the split stack on B, and needs enough of them to fill B's pack.
//
//   bun sdk/test/live/trade-live.ts <botA> <botB> [check ...]      (no checks: all; names below)

import { readFileSync } from 'fs';
import { BotSDK, deriveGatewayUrl, findBotEnv, parseEnvFile } from '../../index';
import { BotActions } from '../../actions';
import type { InventoryItem } from '../../types';

interface Side { sdk: BotSDK; bot: BotActions; name: string; user: string }

const [userA, userB, ...only] = process.argv.slice(2);
if (!userA || !userB) throw new Error('usage: bun sdk/test/live/trade-live.ts <botA> <botB> [check ...]');

const t0 = Date.now();
const log = (s: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const results: string[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
    results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    log(results[results.length - 1]!);
};
const brief = (r: object): string => JSON.stringify(r, (k, v) => (k === 'messages' || k === 'partner' ? undefined : v)).slice(0, 400);
const T = 20_000;

async function connect(user: string): Promise<Side> {
    const path = findBotEnv(user);
    if (!path) throw new Error(`no bots/${user}/bot.env`);
    const env = parseEnvFile(readFileSync(path, 'utf-8'));
    const sdk = new BotSDK({ botUsername: env.BOT_USERNAME || user, password: env.PASSWORD, gatewayUrl: deriveGatewayUrl(env.GATEWAY_URL), connectionMode: 'control', autoLaunchClient: false, showChat: false });
    await sdk.connect();
    const cached = sdk.getState();
    await sdk.waitForCondition(s => s.inGame && s.player !== null && (!cached || s.tick !== cached.tick), 15_000);
    return { sdk, bot: new BotActions(sdk), name: sdk.getPlayer()!.name, user };
}

let a = await connect(userA);
const b = await connect(userB);
log(`${a.name} and ${b.name}, ${Math.round(Math.hypot(a.sdk.getPlayer()!.x - b.sdk.getPlayer()!.x, a.sdk.getPlayer()!.y - b.sdk.getPlayer()!.y))} apart`);

const pack = (s: Side): InventoryItem[] => s.sdk.getInventory().filter(i => i.slot >= 40 && i.slot < 80);
const spare = (s: Side): InventoryItem[] => pack(s).filter(i => !/recall stone|^training /i.test(i.name) && i.count <= 1);
const has = (s: Side, item: { name: string }): boolean => pack(s).some(i => i.name === item.name);
const closed = async (...sides: Side[]): Promise<boolean> => {
    await Promise.all(sides.map(s => s.sdk.waitForCondition(st => !st.trade, 3000).catch(() => null)));
    return sides.every(s => !s.sdk.getTrade());
};
const clean = async (): Promise<void> => { for (const s of [a, b]) if (s.sdk.getTrade()) await s.bot.cancelTrade(); };

const checks: Record<string, () => Promise<void>> = {
    // Before anything has moved: does a player standing still since login count as in view?
    standstill: async () => {
        const seen = a.sdk.getNearbyPlayers().some(p => p.name === b.name), seenBack = b.sdk.getNearbyPlayers().some(p => p.name === a.name);
        check('standing still from login, each in view of the other', seen && seenBack, `${a.name} sees: ${seen}, ${b.name} sees: ${seenBack}`);
        if (!seen || !seenBack) {
            for (const s of [a, b]) { const p = s.sdk.getPlayer()!; await s.bot.walkTo(p.x + 30, p.y); }
            await a.sdk.waitForCondition(st => st.nearbyPlayers.some(p => p.name === b.name), 8000).catch(() => null);
            check('a step brings them into view', a.sdk.getNearbyPlayers().some(p => p.name === b.name));
        }
    },

    // 1, 2: the window on both sides, the commit, and the 40-byte close.
    one: async () => {
        const item = spare(a)[0]!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('one: offer', offer.success, brief(offer));
        const mine = a.sdk.getTrade(), seen = await b.sdk.waitForCondition(s => !!s.trade?.partnerItems.length, 5000).catch(() => null);
        const theirs = seen?.trade ?? b.sdk.getTrade();
        check('one: our side shows the slot', !!mine && mine.mySlots.includes(item.slot) && mine.partnerName === b.name, JSON.stringify(mine));
        check('one: their side shows name, count, partner', !!theirs && theirs.partnerName === a.name && theirs.partnerItems[0]?.name === item.name && theirs.partnerItems[0]?.count === 1, JSON.stringify(theirs));
        const [ra, rb] = await Promise.all([a.bot.acceptTrade({ timeout: T }), b.bot.acceptTrade({ from: a.name, timeout: T })]);
        check('one: both complete', ra.success && rb.success, `${brief(ra)} | ${brief(rb)}`);
        const got = rb.success ? rb.received[0] : undefined;
        check('one: received at a real slot, gone from the giver', !!got && got.slot >= 40 && pack(b).some(i => i.slot === got.slot && i.name === item.name) && !pack(a).some(i => i.slot === item.slot && i.name === item.name), JSON.stringify(got));
        check('one: both windows closed (40-byte close)', await closed(a, b));
        check('one: server line', [...ra.messages, ...rb.messages].some(m => /Trade Completed/.test(m.text)), ra.messages.slice(-3).map(m => m.text).join(' / '));
        const [back, take] = await Promise.all([b.bot.trade(a.name, { give: [got!], timeout: T }), a.bot.trade(b.name, { timeout: T })]);
        check('one: and back, one call each', back.success && take.success, `${brief(back)} | ${brief(take)}`);
    },

    stack: async () => {
        const stack = pack(a).find(i => i.count > 1);
        if (!stack) return check('stack: needs a stack on A', false, 'none');
        const before = pack(b).filter(i => i.name === stack.name).reduce((n, i) => n + i.count, 0);
        const offer = await a.bot.offerTrade(b.name, { give: [stack], timeout: T });
        const seen = await b.sdk.waitForCondition(s => !!s.trade?.partnerItems.length, 5000).catch(() => null);
        check('stack: count shown', seen?.trade?.partnerItems[0]?.count === stack.count && seen?.trade?.partnerItems[0]?.name === stack.name, `${brief(offer)} ${JSON.stringify(seen?.trade?.partnerItems)}`);
        const [ra, rb] = await Promise.all([a.bot.acceptTrade({ timeout: T }), b.bot.acceptTrade({ from: a.name, timeout: T })]);
        const after = pack(b).filter(i => i.name === stack.name).reduce((n, i) => n + i.count, 0);
        check('stack: whole stack moves', ra.success && rb.success && after === before + stack.count && !pack(a).some(i => i.name === stack.name), `${before} -> ${after}; ${brief(ra)} | ${brief(rb)}`);
        const pieces = pack(b).filter(i => i.name === stack.name && i.count > 1).slice(0, 1);
        if (pieces[0]) {
            const [x, y] = await Promise.all([b.bot.trade(a.name, { give: pieces, timeout: T }), a.bot.trade(b.name, { timeout: T })]);
            check('stack: back', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        }
    },

    three: async () => {
        const items = spare(a).slice(0, 3);
        const waiting = b.bot.trade(a.name, { timeout: T });      // accepts each new revision before A does
        await Bun.sleep(300);
        const offer = await a.bot.offerTrade(b.name, { give: items, timeout: T });
        check('three: offer', offer.success, brief(offer));
        await Bun.sleep(1500);
        check('three: no commit on the receiver\'s accepts alone', !!a.sdk.getTrade() && a.sdk.getTrade()!.mySlots.length === 3, JSON.stringify(a.sdk.getTrade()));
        const [ra, rb] = await Promise.all([a.bot.acceptTrade({ timeout: T }), waiting]);
        check('three: all arrive', ra.success && rb.success && rb.received.length === 3 && items.every(i => has(b, i)), `${brief(ra)} | ${brief(rb)}`);
        if (rb.success) {
            const [x, y] = await Promise.all([b.bot.trade(a.name, { give: rb.received, timeout: T }), a.bot.trade(b.name, { timeout: T })]);
            check('three: back', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        }
    },

    money: async () => {
        const copper = (s: Side) => s.sdk.getPlayer()!.money.totalCopper;
        const [ca, cb] = [copper(a), copper(b)];
        const offer = await a.bot.offerTrade(b.name, { money: 10203, timeout: T });
        const seen = await b.sdk.waitForCondition(s => s.trade?.partnerMoney === 10203, 5000).catch(() => null);
        check('money: both windows read 10203', offer.success && a.sdk.getTrade()?.myMoney === 10203 && !!seen, `${brief(offer)} ${JSON.stringify(b.sdk.getTrade())}`);
        const [ra, rb] = await Promise.all([a.bot.acceptTrade({ timeout: T }), b.bot.acceptTrade({ from: a.name, timeout: T })]);
        await Bun.sleep(600);
        check('money: purses move by it', ra.success && rb.success && copper(a) === ca - 10203 && copper(b) === cb + 10203, `${ca}->${copper(a)}, ${cb}->${copper(b)}; ${brief(ra)} | ${brief(rb)}`);
        check('money: reported', ra.success && rb.success && ra.moneyGiven === 10203 && rb.moneyReceived === 10203, `${ra.moneyGiven} ${rb.moneyReceived}`);
        check('money: server line', ra.messages.some(m => /Trade Completed\. 0 items for 0 items/.test(m.text)), ra.messages.slice(-2).map(m => m.text).join(' / '));
        const [x, y] = await Promise.all([b.bot.trade(a.name, { money: 10203, timeout: T }), a.bot.trade(b.name, { timeout: T })]);
        await Bun.sleep(600);
        check('money: back', x.success && y.success && copper(a) === ca && copper(b) === cb, `${copper(a)} ${copper(b)}`);
    },

    swap: async () => {
        const fromA = spare(a)[0]!, fromB = spare(b)[0]!;
        const [ra, rb] = await Promise.all([a.bot.trade(b.name, { give: [fromA], timeout: T }), b.bot.trade(a.name, { give: [fromB], timeout: T })]);
        check('swap: simultaneous calls, no busy', ra.success && rb.success && has(a, fromB) && has(b, fromA), `${brief(ra)} | ${brief(rb)}`);
        if (ra.success && rb.success) {
            const [x, y] = await Promise.all([a.bot.trade(b.name, { give: ra.received, timeout: T }), b.bot.trade(a.name, { give: rb.received, timeout: T })]);
            check('swap: and back', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        }
    },

    ten: async () => {
        const items = spare(a).slice(0, 11);
        if (items.length < 11) return check('ten: needs 11 single items on A', false, String(items.length));
        const over = await a.bot.offerTrade(b.name, { give: items, timeout: T });
        check('ten: an 11th is refused up front', !over.success && over.reason === 'too_many_items' && !a.sdk.getTrade(), brief(over));
        const offer = await a.bot.offerTrade(b.name, { give: items.slice(0, 10), timeout: T });
        check('ten: 10 go in', offer.success && a.sdk.getTrade()?.mySlots.length === 10, brief(offer));
        const rev = a.sdk.getTrade()?.revision ?? 0;
        await a.sdk.sendTradeOfferItem(offer.success ? offer.partner!.objectId : 0, items[10]!.slot);
        await Bun.sleep(1200);
        const t = a.sdk.getTrade();
        check('ten: a raw 11th stays out, the server resends the window', t?.mySlots.length === 10, `${rev} -> ${t?.revision}; ${a.sdk.getGameMessages().slice(-2).map(m => m.text).join(' / ')}`);
        const c = await a.bot.cancelTrade();
        check('ten: closed', c.success && await closed(a, b), brief(c));
    },

    // B's pack filled with A's stack split into single pieces and A's spares, then one item more than it has room for.
    full: async () => {
        const free = (): number[] => { const used = new Set(pack(b).map(i => i.slot)); return Array.from({ length: 40 }, (_, i) => 40 + i).filter(s => !used.has(s)); };
        const stack = pack(a).find(i => i.count > 1);
        if (stack) {
            const [x, y] = await Promise.all([a.bot.trade(b.name, { give: [stack], timeout: T }), b.bot.trade(a.name, { timeout: T })]);
            check('full: setup, the stack from A to B', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        }
        for (let guard = 0; free().length && guard < 40; guard++) {
            const from = pack(b).find(i => i.count > 1);
            if (!from) break;
            await b.sdk.sendMoveItem(from.slot, free()[0]!, 1);
            await Bun.sleep(350);
        }
        const take = spare(a).slice(0, Math.min(free().length, spare(a).length - 1, 10));
        if (take.length) {
            const [x, y] = await Promise.all([a.bot.trade(b.name, { give: take, timeout: T }), b.bot.trade(a.name, { timeout: T })]);
            check('full: setup, the spares from A to B', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        }
        log(`B has ${free().length} free slots`);
        if (free().length) return check('full: pack not full', false, `${free().length} free`);
        const item = spare(a)[0]!;
        const before = pack(a).length;
        const [ra, rb] = await Promise.all([a.bot.trade(b.name, { give: [item], timeout: T }), b.bot.trade(a.name, { timeout: T })]);
        check('full: the giver reads partner_inventory_full', !ra.success && ra.reason === 'partner_inventory_full', brief(ra));
        check('full: the receiver reads inventory_full', !rb.success && rb.reason === 'inventory_full', brief(rb));
        check('full: nothing moved, windows closed', pack(a).length === before && has(a, item) && await closed(a, b), `${before} -> ${pack(a).length}`);
    },

    walkaway: async () => {
        const item = spare(a)[0]!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('walkaway: offer', offer.success, brief(offer));
        const waitA = a.bot.acceptTrade({ timeout: T });
        const waitB = b.bot.acceptTrade({ from: a.name, accept: () => false, timeout: T });
        await Bun.sleep(500);
        const start = b.sdk.getPlayer()!, ap = a.sdk.getPlayer()!;
        const ux = (start.x - ap.x) || 1, uy = start.y - ap.y, n = Math.hypot(ux, uy);
        const t = Date.now();
        void b.sdk.sendMoveTo(Math.round(ap.x + ux / n * 250), Math.round(ap.y + uy / n * 250));
        const [ra, rb] = await Promise.all([waitA, waitB]);
        const closedAfter = Date.now() - t, where = b.sdk.getPlayer()!, away = Math.hypot(where.x - ap.x, where.y - ap.y, where.z - ap.z);
        await b.sdk.sendStop();
        check('walkaway: both cancelled', !ra.success && ra.reason === 'cancelled' && !rb.success && rb.reason === 'cancelled', `${brief(ra)} | ${brief(rb)}`);
        check('walkaway: closed soon after passing 128', away < 128 + 191 * 1.5, `closed after ${closedAfter} ms, ${Math.round(away)} away`);
        check('walkaway: nothing moved', has(a, item) && await closed(a, b));
        await b.bot.walkTo(ap.x + 30, ap.y, { z: ap.z });
    },

    cancel: async () => {
        const item = spare(a)[0]!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        const waitB = b.bot.acceptTrade({ from: a.name, accept: () => false, timeout: T });
        await Bun.sleep(800);
        const c = await a.bot.cancelTrade();
        const rb = await waitB;
        check('cancel: A succeeds, B reads cancelled', offer.success && c.success && !rb.success && rb.reason === 'cancelled', `${brief(c)} | ${brief(rb)}`);
        check('cancel: no window left', await closed(a, b));
        const again = await a.bot.cancelTrade();
        check('cancel: with no window is a success too', again.success, brief(again));
    },

    // Does anything refuse? The recall stone is the likeliest; if it goes, it comes straight back.
    refused: async () => {
        const stone = pack(a).find(i => /recall stone/i.test(i.name)) ?? pack(a).find(i => /^training /i.test(i.name));
        if (!stone) return check('refused: nothing to try', false);
        const r = await a.bot.offerTrade(b.name, { give: [stone], timeout: T });
        log(`offered ${stone.name}: ${brief(r)}`);
        if (r.success) {
            log('it went into the window: not refused, closing');
            await a.bot.cancelTrade();
            return check(`refused: ${stone.name} is tradable, no refusal seen`, true);
        }
        check(`refused: ${stone.name}`, r.reason === 'refused', brief(r));
        const item = spare(a)[0]!;
        const [x, y] = await Promise.all([a.bot.trade(b.name, { give: [item], timeout: T }), b.bot.trade(a.name, { timeout: T })]);
        check('refused: a fresh trade works after it', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        if (y.success) { const [p, q] = await Promise.all([b.bot.trade(a.name, { give: y.received, timeout: T }), a.bot.trade(b.name, { timeout: T })]); check('refused: and back', p.success && q.success); }
    },

    // An unrelated move after the partner accepted: a new revision on both, and the commit needs both accepts again.
    reset: async () => {
        const item = spare(a)[0]!;
        const other = pack(a).find(i => i.slot !== item.slot && !/recall stone/i.test(i.name))!;
        const used = new Set(pack(a).map(i => i.slot));
        const empty = Array.from({ length: 40 }, (_, i) => 40 + i).find(s => !used.has(s))!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('reset: offer', offer.success, brief(offer));
        const rb = b.bot.acceptTrade({ from: a.name, timeout: T });
        await a.sdk.waitForCondition(s => s.gameMessages.some(m => /has accepted the trade/i.test(m.text)), 5000).catch(() => null);
        const revA = a.sdk.getTrade()?.revision, revB = b.sdk.getTrade()?.revision;
        const accepted = a.sdk.getGameMessages().slice(-5).map(m => m.text).filter(t => /accepted/i.test(t));
        check('reset: partner\'s accept is announced', accepted.length > 0, accepted.join(' / '));
        const moved = await a.sdk.sendMoveItem(other.slot, empty);
        await Bun.sleep(1200);
        const tA = a.sdk.getTrade(), tB = b.sdk.getTrade();
        check('reset: a new revision on both, no commit', !!tA && !!tB && tA.revision > revA! && tB.revision > revB!, `${JSON.stringify(moved)} A ${revA}->${tA?.revision}, B ${revB}->${tB?.revision}`);
        check('reset: the offer is still the item', !!tA?.mySlots.includes(item.slot), JSON.stringify(tA?.mySlots));
        const ra = await a.bot.acceptTrade({ timeout: T });
        const rB = await rb;
        check('reset: commit after both accept again', ra.success && rB.success, `${brief(ra)} | ${brief(rB)}`);
        if (rB.success) { const [p, q] = await Promise.all([b.bot.trade(a.name, { give: rB.received, timeout: T }), a.bot.trade(b.name, { timeout: T })]); check('reset: and back', p.success && q.success); }
    },

    // Two-way swaps with the later name starting early by every offset around a second: the case the clock slots are for.
    offsets: async () => {
        for (let offset = 0; offset < 1000; offset += 100) {
            const fromA = spare(a)[0]!, fromB = spare(b)[0]!;
            const later = a.name > b.name ? a : b, earlier = later === a ? b : a;
            const give = (s: Side) => s === a ? fromA : fromB;
            const first = later.bot.trade(earlier.name, { give: [give(later)], timeout: T });
            await Bun.sleep(offset);
            const [rl, re] = await Promise.all([first, earlier.bot.trade(later.name, { give: [give(earlier)], timeout: T })]);
            check(`offsets: swap at +${offset} ms`, rl.success && re.success, rl.success && re.success ? '' : `${brief(rl)} | ${brief(re)}`);
            if (!rl.success || !re.success) return;
        }
    },

    // With our accept standing, the client refuses what would change it; a cancel clears that.
    guard: async () => {
        const item = spare(a)[0]!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('guard: offer', offer.success, brief(offer));
        const accept = await a.sdk.sendTradeAccept();
        await Bun.sleep(300);
        const add = await a.sdk.sendTradeOfferMoney(offer.partner!.objectId, 1);
        const drop = await a.sdk.sendDropItem(spare(a)[1]!.slot);
        check('guard: an add and a drop are refused', accept.success && add.reason === 'trade_accepted' && drop.reason === 'trade_accepted', `${JSON.stringify(add)} ${JSON.stringify(drop)}`);
        check('guard: nothing changed', a.sdk.getTrade()?.myMoney === 0 && !!b.sdk.getTrade());
        const c = await a.bot.cancelTrade();
        check('guard: a cancel closes it', c.success && await closed(a, b), brief(c));
        const again = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('guard: and the next offer goes through', again.success, brief(again));
        await a.bot.cancelTrade();
    },

    // A window left by a script that ended without closing it, and one cut off by a new controller.
    leftover: async () => {
        const item = spare(a)[0]!;
        const offer = await a.bot.offerTrade(b.name, { give: [item], timeout: T });
        check('leftover: offer', offer.success, brief(offer));
        await a.sdk.disconnect();     // what a killed script does to the gateway: the socket goes, no cancel
        await Bun.sleep(800);
        check('leftover: the window outlives the script', !!b.sdk.getTrade(), JSON.stringify(b.sdk.getTrade()));
        a = await connect(userA);
        const [x, y] = await Promise.all([a.bot.trade(b.name, { give: [item], timeout: T }), b.bot.trade(a.name, { timeout: T })]);
        check('leftover: the next trade from that bot works', x.success && y.success, `${brief(x)} | ${brief(y)}`);
        if (y.success) { const [p, q] = await Promise.all([b.bot.trade(a.name, { give: y.received, timeout: T }), a.bot.trade(b.name, { timeout: T })]); check('leftover: and back', p.success && q.success); }

        const again = await a.bot.offerTrade(b.name, { give: [spare(a)[0]!], timeout: T });
        const old = a;
        a = await connect(userA);     // a new control connection pre-empts the old one
        await Bun.sleep(1000);
        check('leftover: a takeover closes the old script\'s window', again.success && !a.sdk.getTrade() && !b.sdk.getTrade(), `${JSON.stringify(a.sdk.getTrade())}`);
        await old.sdk.disconnect().catch(() => {});
    },
};

const order = Object.keys(checks);
const run = only.length ? only : order;
try {
    for (const name of run) {
        if (!checks[name]) throw new Error(`no check ${name}: ${order.join(', ')}`);
        log(`--- ${name}`);
        await clean();
        try { await checks[name]!(); }
        catch (e) { check(`${name}: threw`, false, String(e).slice(0, 300)); }
    }
} finally {
    await clean().catch(() => {});
    for (const s of [a, b]) await s.sdk.sendStop().catch(() => null);
    console.log(`\n${results.join('\n')}\n\n${results.filter(r => r.startsWith('PASS')).length} pass, ${results.filter(r => r.startsWith('FAIL')).length} fail`);
    for (const s of [a, b]) await s.sdk.disconnect().catch(() => {});
}
process.exit(0);
