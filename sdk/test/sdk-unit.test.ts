// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
import { describe, expect, test } from 'bun:test';
import { BotSDK, bestNameMatch, deriveGatewayUrl, headingBetween, isAttackable, parseEnvFile } from '../index';
import { executionContext } from '../execution-context';
import { ChatHistory } from '../chat-history';
import type { ActionResult, BotActionType, BotWorldState } from '../types';
import { makeMessage, makeNpc, makePlayer, makeState } from './fixtures';

/** An SDK that looks connected but whose socket swallows everything. */
function stubSdk(actionTimeout: number, mode: 'control' | 'observe' = 'control') {
    const sdk = Object.create(BotSDK.prototype) as BotSDK;
    const sent: any[] = [];
    (sdk as any).config = { actionTimeout, botUsername: 'tester', connectionMode: mode, showChat: true };
    (sdk as any).connectionState = 'connected';
    (sdk as any).pendingActions = new Map();
    (sdk as any).stateListeners = new Set();
    (sdk as any).chatHistory = new ChatHistory();
    (sdk as any).chatReadCursor = 0;
    (sdk as any).ws = { readyState: WebSocket.OPEN };
    (sdk as any).transmit = (msg: any) => sent.push(msg);
    return { sdk, sent, pending: (sdk as any).pendingActions as Map<string, any> };
}

function feed(sdk: BotSDK, state: BotWorldState) {
    (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_state', state, stateReceivedAt: Date.now() }));
}

function dispatch(sdk: BotSDK): Promise<ActionResult> {
    return sdk.sendMoveTo(1, 2, 3);
}

describe('BotSDK.sendAction dispatch failures', () => {
    test('cleans up when the socket write throws synchronously', async () => {
        const { sdk, pending } = stubSdk(5000);
        (sdk as any).transmit = () => { throw new Error('Socket write failed'); };
        expect(await dispatch(sdk)).toMatchObject({ success: false, reason: 'error', message: 'Socket write failed', phase: 'dispatch' });
        expect(pending.size).toBe(0);
    });

    test('reports a timeout instead of throwing', async () => {
        const { sdk, sent, pending } = stubSdk(20);
        const result = await dispatch(sdk);
        expect(sent).toHaveLength(1);
        expect(sent[0].action).toMatchObject({ type: 'moveTo', x: 1, y: 2, z: 3 });
        expect(result).toMatchObject({ success: false, reason: 'timeout', phase: 'dispatch' });
        expect(result.message).toContain('moveTo');
        expect(pending.size).toBe(0);
    });

    test('reports a mid-flight disconnect instead of throwing', async () => {
        const { sdk, pending } = stubSdk(5000);
        const promise = dispatch(sdk);
        const entry = [...pending.values()][0]!;
        clearTimeout(entry.timeout);
        entry.reject(new Error('Connection closed'));
        expect(await promise).toMatchObject({ success: false, message: 'Connection closed' });
    });

    test('reports a gateway error instead of throwing', async () => {
        const { sdk, sent } = stubSdk(5000);
        const promise = dispatch(sdk);
        (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_error', actionId: sent[0].actionId, error: 'Bot not connected' }));
        expect(await promise).toMatchObject({ success: false, reason: 'error', message: 'Bot not connected' });
    });

    test('resolves normally when a result arrives', async () => {
        const { sdk, sent, pending } = stubSdk(5000);
        const promise = dispatch(sdk);
        (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_action_result', actionId: sent[0].actionId, result: { success: true, message: 'Moving' } }));
        expect(await promise).toEqual({ success: true, message: 'Moving' });
        expect(pending.size).toBe(0);
    });

    test('throws when not connected', async () => {
        const { sdk } = stubSdk(5000);
        (sdk as any).ws = null;
        (sdk as any).connectionState = 'disconnected';
        await expect(dispatch(sdk)).rejects.toThrow(/Not connected/);
    });

    test('observe mode rejects non-chat actions locally', async () => {
        const { sdk, sent } = stubSdk(5000, 'observe');
        expect(await sdk.sendAttack()).toMatchObject({ success: false, reason: 'observe_mode', phase: 'validation' });
        expect(sent).toHaveLength(0);
    });

    test("'Bot disconnected' fails every action in flight as disconnected", async () => {
        const { sdk, sent, pending } = stubSdk(60_000);
        const a = sdk.sendStop();
        const b = sdk.sendSit(true);
        expect(pending.size).toBe(2);
        (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_error', error: 'Bot disconnected' }));
        expect(await a).toMatchObject({ success: false, reason: 'disconnected', phase: 'dispatch' });
        expect(await b).toMatchObject({ success: false, reason: 'disconnected' });
        expect(pending.size).toBe(0);
        // The gateway's per-action notice maps to the same reason.
        const c = sdk.sendStop();
        (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_error', actionId: sent.at(-1).actionId, error: 'Bot client disconnected before answering' }));
        expect(await c).toMatchObject({ success: false, reason: 'disconnected' });
    });

    test('every BotAction variant has a send* wrapper that dispatches it', async () => {
        // Adding a variant to sdk/types.ts without a wrapper fails typecheck here.
        const calls: Record<BotActionType, (sdk: BotSDK) => Promise<ActionResult>> = {
            none: s => s.sendNone(),
            wait: s => s.sendWait(10),
            moveTo: s => s.sendMoveTo(1, 2, 3, { tolerance: 5, speedFactor: 0.5, waypoints: [{ x: 0, y: 0, z: 0 }] }),
            stop: s => s.sendStop(),
            face: s => s.sendFace(1024),
            faceObject: s => s.sendFaceObject(7),
            jump: s => s.sendJump(),
            setTarget: s => s.sendSetTarget(null),
            interact: s => s.sendInteract(7),
            whisper: s => s.sendWhisper(7, 'kw'),
            pickup: s => s.sendPickup(7),
            attack: s => s.sendAttack(false),
            useSkill: s => s.sendUseSkill(3),
            castSpell: s => s.sendCastSpell(1, 2),
            setGroundTarget: s => s.sendSetGroundTarget(1, 2, 3),
            petCommand: s => s.sendPetCommand('attack', 7),
            useItem: s => s.sendUseItem(40, 1),
            moveItem: s => s.sendMoveItem(40, 41, 2),
            dropItem: s => s.sendDropItem(40),
            destroyItem: s => s.sendDestroyItem(40),
            delve: s => s.sendDelve(40),
            delveMerchantItem: s => s.sendDelveMerchantItem(0, 3),
            buy: s => s.sendBuy(0, 1, 2),
            sell: s => s.sendSell(40),
            tradeOfferItem: s => s.sendTradeOfferItem(7, 40),
            tradeOfferMoney: s => s.sendTradeOfferMoney(7, 5),
            tradeAccept: s => s.sendTradeAccept(3),
            tradeCancel: s => s.sendTradeCancel(),
            openTrainer: s => s.sendOpenTrainer(),
            trainSpec: s => s.sendTrainSpec(0, 2),
            respondDialog: s => s.sendRespondDialog(true),
            closeMerchant: s => s.sendCloseMerchant(),
            say: s => s.sendSay('hi'),
            send: s => s.sendSend('Ann', 'hi'),
            groupSay: s => s.sendGroupSay('hi'),
            command: s => s.sendCommand('&stick'),
            sit: s => s.sendSit(true),
            removeConcentration: s => s.sendRemoveConcentrationEffect(0),
            regionChangeRequest: s => s.sendRegionChangeRequest(63),
            release: s => s.sendRelease(),
            quit: s => s.sendQuit(),
        };
        const expected: Partial<Record<BotActionType, object>> = {
            wait: { ms: 10 },
            moveTo: { x: 1, y: 2, z: 3, tolerance: 5, speedFactor: 0.5, waypoints: [{ x: 0, y: 0, z: 0 }] },
            face: { heading: 1024 }, faceObject: { objectId: 7 }, setTarget: { objectId: null }, interact: { objectId: 7 },
            whisper: { objectId: 7, text: 'kw' }, pickup: { objectId: 7 }, attack: { on: false }, useSkill: { skillIndex: 3 },
            castSpell: { lineIndex: 1, spellIndex: 2 }, setGroundTarget: { x: 1, y: 2, z: 3 }, petCommand: { command: 'attack', targetObjectId: 7 }, useItem: { slot: 40, useType: 1 },
            moveItem: { fromSlot: 40, toSlot: 41, count: 2 }, dropItem: { slot: 40 }, destroyItem: { slot: 40 }, delve: { slot: 40 }, delveMerchantItem: { page: 0, slot: 3 },
            tradeOfferItem: { partnerObjectId: 7, slot: 40 }, tradeOfferMoney: { partnerObjectId: 7, copper: 5 }, tradeAccept: { revision: 3 },
            buy: { page: 0, slot: 1, count: 2 }, sell: { slot: 40 }, trainSpec: { specIndex: 0, levels: 2 },
            respondDialog: { accept: true }, say: { text: 'hi' }, send: { to: 'Ann', text: 'hi' }, groupSay: { text: 'hi' },
            command: { command: '&stick' }, sit: { sit: true }, regionChangeRequest: { zonePointId: 63 },
        };
        for (const [type, call] of Object.entries(calls) as [BotActionType, (sdk: BotSDK) => Promise<ActionResult>][]) {
            const { sdk, sent } = stubSdk(5000);
            const promise = call(sdk);
            expect(sent).toHaveLength(1);
            expect(sent[0].action).toMatchObject({ type, ...(expected[type] ?? {}) });
            (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_action_result', actionId: sent[0].actionId, result: { success: true, message: type } }));
            expect(await promise).toMatchObject({ success: true, message: type });
        }
    });

    test('an aborted execution rejects instead of returning a failed result', async () => {
        const { sdk } = stubSdk(5000);
        const controller = new AbortController();
        const promise = executionContext.run({ signal: controller.signal }, () => dispatch(sdk));
        controller.abort(new Error('cancelled'));
        await expect(promise).rejects.toThrow('cancelled');
    });
});

describe('BotSDK state reads', () => {
    test('find* helpers and filters', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        expect(sdk.findNearbyNpc('rat')?.objectId).toBe(200);
        expect(sdk.findNearbyNpc('rat', { minLevel: 2 })?.name).toBe('sewer rat');
        expect(sdk.findNearbyNpc(/rat/, { maxDistance: 50 })).toBeNull();
        expect(sdk.findNearbyNpc(/./, { attackable: true, minLevel: 10 })).toBeNull(); // guard is own realm, merchant peaceful
        expect(sdk.findNearbyNpcs(/./, { attackable: true }).map(n => n.objectId)).toEqual([200, 201]);
        expect(sdk.findInventoryItem('tail')?.slot).toBe(41);
        expect(sdk.countInventoryItems('rat tail')).toBe(3);
        expect(sdk.getFreeInventorySlots()).toBe(37);
        expect(sdk.findEquipmentItem(/sword/)?.slot).toBe(10);
        expect(sdk.findNearbyPlayer('other')?.objectId).toBe(300);
        expect(sdk.findNearbyObject('coins', { loot: true })?.objectId).toBe(400);
        expect(sdk.getNearbyLoot().map(o => o.objectId)).toEqual([400]);
        expect(sdk.findStyle('back')?.skillIndex).toBe(7);
        expect(sdk.findAbility('sprint')?.skillIndex).toBe(4);
        expect(sdk.findEffect('strength')?.remainingSeconds).toBe(60);
        expect(sdk.getPosition()).toEqual({ regionId: 1, x: 560000, y: 511000, z: 2500 });
        expect(sdk.getMerchant()).toBeNull();
        expect(sdk.getDialog()).toBeNull();
        expect(sdk.getTrade()).toBeNull();
    });

    describe('findSpecialization', () => {
        const knowing = (...names: string[]) => {
            const { sdk } = stubSdk(5000);
            const specializations = names.map((name, internalId) => ({ name, level: 1, internalId, bonus: 0 }));
            feed(sdk, makeState({ skills: { specializations, abilities: [], styles: [], spells: [] } }));
            return sdk;
        };
        const armsman = () => knowing('Crush', 'Slash', 'Thrust', 'Polearm', 'Shield', 'Parry', 'Two Handed', 'Crossbows');
        const mentalist = () => knowing('Light Magic', 'Mentalism', 'Mana Magic');

        test.each(['Shield', 'shield', 'Shields', 'shields'])('%s finds Shield, the name in the list', name => {
            expect(armsman().findSpecialization(name)?.name).toBe('Shield');
        });

        test('a regex matches the name in the list, then the key', () => {
            expect(armsman().findSpecialization(/^Shield$/)?.name).toBe('Shield');
            expect(armsman().findSpecialization(/^Shields$/)?.name).toBe('Shield');
            expect(mentalist().findSpecialization(/^Light$/)?.name).toBe('Light Magic');
            expect(armsman().findSpecialization(/^Light$/)).toBeNull();
        });

        test.each([['Light', 'Light Magic'], ['Light Magic', 'Light Magic'], ['Mana', 'Mana Magic'], ['mana magic', 'Mana Magic']])('%s finds %s', (name, line) => {
            expect(mentalist().findSpecialization(name)?.name).toBe(line);
        });

        test('an item bonus name finds its line', () => {
            expect(knowing('Mending', 'Subterranean', 'Augmentation').findSpecialization('Cave Magic')?.name).toBe('Subterranean');
            expect(knowing('Rejuvenation', 'Enhancement', 'Smite').findSpecialization('Smiting')?.name).toBe('Smite');
            expect(knowing('Shield', 'Thrown Weapons').findSpecialization('Throwing')?.name).toBe('Thrown Weapons');
        });

        test('a name the class has no line for stays null', () => {
            expect(mentalist().findSpecialization('Shields')).toBeNull();
            expect(armsman().findSpecialization('Cave Magic')).toBeNull();
            expect(knowing('Darkness', 'Suppression', 'Runecarving').findSpecialization('Runes of Darkness')).toBeNull();
            expect(armsman().findSpecialization('constructor')).toBeNull();
            expect(armsman().findSpecialization('__proto__')).toBeNull();
        });

        test('an empty name finds nothing: it would otherwise match every line', () => {
            expect(armsman().findSpecialization('')).toBeNull();
        });

        test('a part of a name still matches, and the shortest wins', () => {
            expect(armsman().findSpecialization('two')?.name).toBe('Two Handed');
            expect(knowing('Left Axe', 'Axe').findSpecialization('Axe')?.name).toBe('Axe');
            expect(armsman().findSpecialization(/^P/)?.name).toBe('Parry');
        });

        test('a part of a name means the listed name, not the key', () => {
            expect(armsman().findSpecialization('ields')).toBeNull();
        });
    });

    test('getTrade returns the open window; a client without the field reads as closed', () => {
        const { sdk } = stubSdk(5000);
        const trade = { id: 1, revision: 2, partnerName: 'Aine', mySlots: [40], myMoney: 5, partnerItems: [], partnerMoney: 0 };
        feed(sdk, makeState({ trade }));
        expect(sdk.getTrade()).toEqual(trade);
        feed(sdk, makeState({ trade: null }));
        expect(sdk.getTrade()).toBeNull();
    });

    test('getPetState holds the window, getPet its entry in view; a client without the field reads as no pet', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        expect(sdk.getPetState()).toBeNull();
        expect(sdk.getPet()).toBeNull();
        const pet = { objectId: 600, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } as const;
        const copy = { ...pet, icons: [] };
        feed(sdk, makeState({ pet: copy, nearbyNpcs: [makeNpc({ objectId: 600, name: 'wolf', isPet: true })] }));
        expect(sdk.getPetState()).toEqual(copy);
        expect(sdk.getPet()?.name).toBe('wolf');
        feed(sdk, makeState({ pet: copy, nearbyNpcs: [] })); // out of view: the window stays
        expect(sdk.getPetState()).toEqual(copy);
        expect(sdk.getPet()).toBeNull();
        feed(sdk, makeState({ pet: null }));
        expect(sdk.getPetState()).toBeNull();
    });

    test('getSummons: the entries in view, nearest first; a client without the field reads as none', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        expect(sdk.getSummons()).toEqual([]);
        const near = makeNpc({ objectId: 610, name: 'air spirit', isPet: true, distance: 50 });
        const far = makeNpc({ objectId: 611, name: 'ice spirit', isPet: true, distance: 300 });
        feed(sdk, makeState({ summons: [611, 610, 612], nearbyNpcs: [near, far, makeNpc()] }));
        expect(sdk.getSummons().map(n => n.objectId)).toEqual([610, 611]);
        feed(sdk, makeState({ summons: [611, 610], nearbyNpcs: [makeNpc()] }));
        expect(sdk.getSummons()).toEqual([]);
        expect(sdk.getPetState()).toBeNull();
    });

    test('getTarget resolves the target object', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState({ player: makePlayer({ targetObjectId: 201 }) }));
        expect(sdk.getTarget()?.name).toBe('sewer rat');
    });

    test('geometry', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        expect(sdk.distanceTo({ x: 560300, y: 511400 })).toBe(500);
        // DAoC heading: 0 = +Y, increasing clockwise toward -X (world/Point2D.cs:102-113)
        expect(headingBetween({ x: 0, y: 0 }, { x: 0, y: 100 })).toBe(0);
        expect(headingBetween({ x: 0, y: 0 }, { x: -100, y: 0 })).toBe(1024);
        expect(headingBetween({ x: 0, y: 0 }, { x: 0, y: -100 })).toBe(2048);
        expect(headingBetween({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(3072);
        expect(sdk.headingTo({ x: 560000, y: 511100 })).toBe(0);
    });

    test('chat history, cursors and showChat', () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        expect(sdk.getChat().map(m => m.text)).toEqual(['Otherguy says, "hello there"']);
        expect(sdk.getChat({ includeSelf: true })).toHaveLength(2);
        expect(sdk.getChat({ types: 'all', includeSelf: true })).toHaveLength(3);
        expect(sdk.getNewChat()).toHaveLength(1);
        expect(sdk.getNewChat()).toHaveLength(0);
        feed(sdk, makeState({ tick: 2, gameMessages: [...makeState().gameMessages, makeMessage(4, 'Ann says, "yo"', { type: 'say', sender: 'Ann' })] }));
        expect(sdk.getNewChat().map(m => m.sender)).toEqual(['Ann']);
        expect(sdk.getChatFrom('ann')).toHaveLength(1);

        const quiet = stubSdk(5000).sdk;
        (quiet as any).config.showChat = false;
        feed(quiet, makeState());
        // Other players' chat goes; our own echo stays (bot.say watches it).
        expect(quiet.getChat({ types: 'all', includeSelf: true }).map(m => m.text)).toEqual(['Welcome to OpenDAoC', 'You say, "hi"']);
    });

    test('showChat=false keeps NPC speech and our own echoes for bot.*', () => {
        const quiet = stubSdk(5000).sdk;
        (quiet as any).config.showChat = false;
        // Trainers answer through GameNPC.SayTo as CT_Say (GameNPC.cs:2607-2608): type 'say' like player chat.
        feed(quiet, makeState({
            nearbyNpcs: [makeNpc({ objectId: 210, name: 'Master Thing', role: 'trainer' })],
            gameMessages: [
                makeMessage(1, 'Master Thing says, "Do you wish to train as an [Armsman]?"', { type: 'say', rawType: 1, sender: 'Master Thing' }),
                makeMessage(2, 'You say, "hi"', { type: 'say', rawType: 1 }),
                makeMessage(3, 'Bob says, "hi"', { type: 'say', rawType: 1, sender: 'Bob' }),
                makeMessage(4, '[Party] Testbot: "inc"', { type: 'group', rawType: 3, sender: 'Testbot' }),
                makeMessage(5, 'Welcome!', { type: 'say', rawType: 1, popup: true }),
            ],
        }));
        expect(quiet.getState()!.gameMessages.map(m => m.id)).toEqual([1, 2, 4, 5]);
    });

    test('a takeover by another controller is recorded as pre-emption', () => {
        const { sdk } = stubSdk(5000);
        expect(sdk.wasPreempted()).toBeFalse();
        const warn = console.warn;
        console.warn = () => {};
        try {
            (sdk as any).handleMessage(JSON.stringify({ type: 'sdk_error', error: 'Disconnected: another controller connected' }));
        } finally {
            console.warn = warn;
        }
        expect(sdk.wasPreempted()).toBeTrue();
        expect(sdk.getPreemptedReason()).toContain('another controller');
        expect((sdk as any).intentionalDisconnect).toBeTrue();
    });

    test('waitForChat and waitForTicks resolve from state updates', async () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        const chat = sdk.waitForChat({ from: 'ann', timeout: 1000 });
        const ticks = sdk.waitForTicks(2);
        feed(sdk, makeState({ tick: 2 }));
        feed(sdk, makeState({ tick: 3, gameMessages: [makeMessage(4, 'Ann says, "yo"', { type: 'say', sender: 'Ann' })] }));
        expect((await chat)?.text).toContain('yo');
        expect((await ticks).tick).toBe(3);
        expect(await sdk.waitForChat({ timeout: 20 })).toBeNull();
        await expect(sdk.waitForCondition(() => false, 20)).rejects.toThrow('waitForCondition timed out');
    });

    test('waitForReady needs inGame and a player', async () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState({ inGame: false, player: null }));
        const ready = sdk.waitForReady(1000);
        feed(sdk, makeState({ tick: 2 }));
        expect((await ready).tick).toBe(2);
    });

    test('waits are abortable', async () => {
        const { sdk } = stubSdk(5000);
        feed(sdk, makeState());
        const controller = new AbortController();
        const wait = executionContext.run({ signal: controller.signal }, () => sdk.waitForCondition(() => false, 10_000));
        controller.abort(new Error('stop'));
        await expect(wait).rejects.toThrow('stop');
        expect((sdk as any).stateListeners.size).toBe(0);
    });
});

describe('helpers', () => {
    test('deriveGatewayUrl', () => {
        const saved = process.env.GATEWAY_URL;
        delete process.env.GATEWAY_URL;
        try {
            expect(deriveGatewayUrl()).toBe('ws://localhost:7780');
            expect(deriveGatewayUrl('localhost:7781')).toBe('ws://localhost:7781');
            expect(deriveGatewayUrl('example.com')).toBe('ws://example.com:7780');
            expect(deriveGatewayUrl('wss://x.example/gw')).toBe('wss://x.example/gw');
            process.env.GATEWAY_URL = 'ws://override:1';
            expect(deriveGatewayUrl('localhost:7781')).toBe('ws://override:1');
        } finally {
            if (saved === undefined) delete process.env.GATEWAY_URL;
            else process.env.GATEWAY_URL = saved;
        }
    });

    test('parseEnvFile', () => {
        expect(parseEnvFile('# c\nBOT_USERNAME=bob\r\nREALM=albion   # comment\nPASSWORD=a=b\n\nBAD\n')).toEqual({ BOT_USERNAME: 'bob', REALM: 'albion', PASSWORD: 'a=b' });
    });

    test('bestNameMatch prefers the shortest name, then nearest', () => {
        const items = [{ name: 'giant rat', distance: 1 }, { name: 'rat', distance: 50 }, { name: 'rat', distance: 10 }];
        expect(bestNameMatch(items, 'rat')).toEqual({ name: 'rat', distance: 10 });
        expect(bestNameMatch(items, /^giant/i)?.name).toBe('giant rat');
        expect(bestNameMatch(items, 'wolf')).toBeNull();
    });

    test('isAttackable', () => {
        const p = makePlayer();
        expect(isAttackable(makeNpc(), p)).toBe(true);
        expect(isAttackable(makeNpc({ realm: 'albion' }), p)).toBe(false);
        expect(isAttackable(makeNpc({ realm: 'midgard' }), p)).toBe(true);
        expect(isAttackable(makeNpc({ isPeaceful: true }), p)).toBe(false);
        // A dead one leaves the list: at 0 % it is alive, the percent is truncated (GameLiving.cs:2621).
        expect(isAttackable(makeNpc({ healthPercent: 0 }), p)).toBe(true);
        expect(isAttackable(makeNpc({ isPet: true }), p)).toBe(false);
        // A pet has its owner's realm: ours no, an enemy's yes (AbstractServerRules.cs:344-348), and with no player to compare, no.
        expect(isAttackable(makeNpc({ isPet: true, realm: 'albion' }), p)).toBe(false);
        expect(isAttackable(makeNpc({ isPet: true, realm: 'midgard' }), p)).toBe(true);
        expect(isAttackable(makeNpc({ isPet: true, realm: 'midgard', isPeaceful: true }), p)).toBe(false);
        expect(isAttackable(makeNpc({ isPet: true, realm: 'midgard' }), null)).toBe(false);
        expect(isAttackable(makeNpc({ realm: 'midgard' }), null)).toBe(true);
    });
});
