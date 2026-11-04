import { describe, expect, test } from 'bun:test';
import { formatMoney, formatWorldState, formatWorldStateSummary, summarizeWorldState } from '../formatter';
import { EXECUTE_CODE_OUTPUT_SCHEMA } from '../../mcp/execute-code';
import { makeMessage, makeNpc, makePlayer, makeState } from './fixtures';

describe('formatWorldState', () => {
    test('renders the DAoC essentials', () => {
        const text = formatWorldState(makeState({ player: makePlayer({ targetObjectId: 200, inCombat: true }) }), 0);
        expect(text).toContain('Testbot - level 5 Briton Fighter (Albion)');
        expect(text).toContain('region 1, Camelot Hills (560000, 511000, 2500)');
        expect(text).toContain('HP 80/100');
        expect(text).toContain('Target: rat L1 100%');
        expect(text).toContain('[41] rat tail x2');
        expect(text).toContain('- rat L1 100% - 100u (oid 200)');
        expect(text).toContain('Lady Grynoch L20 100% [merchant, peaceful, albion]');
        expect(text).toContain('Otherguy says, "hello there"');
        expect(text).not.toContain('## Player Chat\n- (say) You say');
        expect(text).toContain('Welcome to OpenDAoC');
    });

    test('sinceMessageId hides already-shown messages', () => {
        const text = formatWorldState(makeState(), 0, { sinceMessageId: 3 });
        expect(text).not.toContain('Welcome to OpenDAoC');
        expect(text).not.toContain('hello there');
    });

    test('shows dialog, npc keywords, merchant and death', () => {
        const state = makeState({
            player: makePlayer({ isDead: true }),
            dialog: { isOpen: true, code: 5, data: [0, 0, 0, 0], type: 1, text: 'Join group?', receivedAt: 0 },
            npcDialog: { npcObjectId: 203, npcName: 'Lady Grynoch', text: 'Do you want to [buy] or [sell]?', keywords: ['buy', 'sell'], receivedAt: 0 },
            merchant: { isOpen: true, merchantObjectId: 203, windowType: 0, items: [{ page: 0, slot: 1, name: 'bread', level: 1, price: 150, model: 1, usable: true, objectType: 0, hand: 0, damageType: null, value1: 0, spdAbs: 0 }] },
        });
        const text = formatWorldState(state, 0);
        expect(text).toContain('"Join group?" (code 5, yes/no)');
        expect(text).toContain('Keywords: [buy] [sell]');
        expect(text).toContain('[p0 s1] bread L1 - 1s 50c');
        expect(text).toContain('DEAD');
    });

    test('shows an open trade as a blocker in both views', () => {
        const partnerItems = [{ slot: 45, name: 'helm', level: 1, count: 1, model: 1, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 5, value1: 0, value2: 0 }];
        const state = makeState({ trade: { id: 1, revision: 3, partnerName: 'Aine', mySlots: [40, 41], myMoney: 0, partnerItems, partnerMoney: 0 } });
        expect(formatWorldState(state, 0)).toContain('trading with Aine (2 ours, 1 theirs)');
        expect(formatWorldStateSummary(state, 0)).toContain('trading with Aine (2 ours, 1 theirs)');
        expect(formatWorldState(makeState({ trade: null }), 0)).not.toContain('trading with');
        expect(formatWorldState(makeState(), 0)).not.toContain('trading with');
    });

    test('shows our pet in both views', () => {
        const pet = { objectId: 600, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: 200 } as const;
        const npcs = [makeNpc(), makeNpc({ objectId: 600, name: 'wolf cub', level: 4, healthPercent: 70, distance: 64, realm: 'albion', isPet: true })];
        const line = 'Pet: wolf cub L4 70% (64u) - defensive, follow, fighting rat';
        const state = makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: npcs });
        expect(formatWorldState(state, 0)).toContain(line);
        expect(formatWorldStateSummary(state, 0)).toContain(line);
        const away = makeState({ pet: { ...pet, icons: [], targetObjectId: null, walk: 'stay' }, nearbyNpcs: [] });
        expect(formatWorldStateSummary(away, 0)).toContain('Pet: oid 600 (not in view) - defensive, stay');
        const named = makeState({ pet: { ...pet, name: 'lynx cub', icons: [], targetObjectId: null, walk: 'stay' }, nearbyNpcs: [] });
        expect(formatWorldStateSummary(named, 0)).toContain('Pet: lynx cub (not in view) - defensive, stay');
        expect(formatWorldState(makeState({ pet: null }), 0)).not.toContain('Pet:');
        expect(formatWorldStateSummary(makeState(), 0)).not.toContain('Pet:');
    });

    test('the pet line: a mob on it reads as its fight too, one of them out of view or dead no', () => {
        const pet = { objectId: 600, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null } as const;
        const petNpc = makeNpc({ objectId: 600, name: 'wolf cub', level: 4, healthPercent: 70, distance: 64, realm: 'albion', isPet: true });
        const onIt = makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: [petNpc, makeNpc({ targetObjectId: 600 })] });
        expect(formatWorldStateSummary(onIt, 0)).toContain('Pet: wolf cub L4 70% (64u) - defensive, follow, fighting rat');
        const idle = makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: [petNpc, makeNpc()] });
        expect(formatWorldStateSummary(idle, 0)).toContain('Pet: wolf cub L4 70% (64u) - defensive, follow');
        expect(formatWorldStateSummary(idle, 0)).not.toContain('fighting');
        const gone = makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: [petNpc, makeNpc({ targetObjectId: 600, healthPercent: 0 })] });
        expect(formatWorldStateSummary(gone, 0)).not.toContain('fighting');
    });

    test('a pet is tagged in the NPC list, a fire-and-forget one too, and it has no role', () => {
        const text = formatWorldState(makeState({ nearbyNpcs: [makeNpc({ objectId: 610, name: 'air spirit', level: 8, realm: 'albion', isPet: true, inCombat: true, distance: 130 })] }), 0);
        expect(text).toContain('- air spirit L8 100% [pet, in combat, albion] - 130u (oid 610)');
    });

    test('an NPC with no name reads by its id in the summary, one line each', () => {
        const text = formatWorldStateSummary(makeState({ nearbyNpcs: [makeNpc({ objectId: 15905, name: '', distance: 82 }), makeNpc({ objectId: 15906, name: '', distance: 90 })] }), 0);
        expect(text).toContain('NPCs: #15905 (82u), #15906 (90u)');
    });

    test('a shade shows in the state line of both views, and only then', () => {
        const shade = makeState({ player: makePlayer({ isShade: true }) });
        expect(formatWorldStateSummary(shade, 0)).toContain('Testbot L5 Fighter (shade) @ Camelot Hills');
        expect(formatWorldState(shade, 0)).toContain('Testbot - level 5 Briton Fighter (Albion) (shade)');
        for (const state of [makeState(), makeState({ player: makePlayer({ isShade: false }) })]) {
            expect(formatWorldStateSummary(state, 0)).not.toContain('(shade)');
            expect(formatWorldState(state, 0)).not.toContain('(shade)');
        }
    });

    test('our own id as the target reads self, in both views: nearby lists never hold us', () => {
        const self = makeState({ player: makePlayer({ objectId: 100, targetObjectId: 100 }) });
        expect(formatWorldState(self, 0)).toContain('Target: self');
        expect(formatWorldState(self, 0)).not.toContain('not in view');
        expect(formatWorldStateSummary(self, 0)).toContain('Target: self');
        // Anyone else out of view still reads as that.
        const away = makeState({ player: makePlayer({ objectId: 100, targetObjectId: 999 }) });
        expect(formatWorldState(away, 0)).toContain('Target: oid 999 (not in view)');
        expect(formatWorldStateSummary(away, 0)).not.toContain('Target:');
        for (const none of [makeState({ player: makePlayer({ targetObjectId: null }) })]) {
            expect(formatWorldState(none, 0)).not.toContain('Target:');
            expect(formatWorldStateSummary(none, 0)).not.toContain('Target:');
        }
    });

    test('not in game', () => {
        const text = formatWorldState(makeState({ inGame: false, player: null, connection: { phase: 'charScreen', serverName: '', clientVersion: '1.127', lastError: 'AccountIsInLogoutProcedure' } }), 9000);
        expect(text).toContain('Phase: charScreen');
        expect(text).toContain('Last error: AccountIsInLogoutProcedure');
        expect(text).toContain('Updated: 9s ago');
    });
});

describe('formatWorldStateSummary', () => {
    test('reports progress against a baseline', () => {
        const text = formatWorldStateSummary(makeState(), 0, { baseline: { level: 4, experience: 1000, realmPoints: 0, totalCopper: 10000 } });
        expect(text).toContain('Testbot L5 Fighter @ Camelot Hills');
        expect(text).toContain('Progress: level +1, xp +500, money +2s 50c');
        expect(text).toContain('Inv 3/40');
        expect(text).toContain('> Otherguy says, "hello there"');
        expect(text).not.toContain('> You say');
    });
});

describe('formatMoney', () => {
    test('denominations', () => {
        expect(formatMoney(0)).toBe('0c');
        expect(formatMoney(10250)).toBe('1g 2s 50c');
        expect(formatMoney(10_000_000)).toBe('1m');
    });
});

describe('summarizeWorldState', () => {
    test('caps lists by detail and sorts nearest first', () => {
        const npcs = Array.from({ length: 30 }, (_, i) => makeNpc({ objectId: 1000 + i, name: `mob ${i}`, distance: 1000 - i }));
        const brief = summarizeWorldState(makeState({ nearbyNpcs: npcs }), 10);
        expect(brief.nearby.npcs.total).toBe(30);
        expect(brief.nearby.npcs.items).toHaveLength(10);
        expect(brief.nearby.npcs.items[0]!.objectId).toBe(1029);
        const full = summarizeWorldState(makeState({ nearbyNpcs: npcs }), 10, { detail: 'full' });
        expect(full.nearby.npcs.items).toHaveLength(30);
    });

    test('player, target, messages', () => {
        const s = summarizeWorldState(makeState({ player: makePlayer({ targetObjectId: 201 }) }), 5, { sinceMessageId: 1 });
        expect(s.player).toMatchObject({ name: 'Testbot', level: 5, realm: 'albion', className: 'Fighter', regionId: 1, health: 80, totalCopper: 10250 });
        expect(s.target).toMatchObject({ objectId: 201, kind: 'npc', name: 'sewer rat', level: 3 });
        expect(s.messages.chat).toEqual([{ from: 'Otherguy', type: 'say', text: 'Otherguy says, "hello there"' }]);
        expect(s.messages.system).toEqual([]);
        expect(s.inventory.freeSlots).toBe(37);
        expect(s.dialog).toBeNull();
        expect(s.merchant).toBeNull();
    });

    test('our pet: the window, and its entry while in view', () => {
        const pet = { objectId: 600, aggression: 'passive', walk: 'stay', icons: [], targetObjectId: 200 } as const;
        const inView = summarizeWorldState(makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: [makeNpc({ objectId: 600, name: 'wolf cub', level: 4, healthPercent: 70, distance: 64 })] }), 0);
        expect(inView.pet).toEqual({ objectId: 600, name: 'wolf cub', level: 4, healthPercent: 70, distance: 64, aggression: 'passive', walk: 'stay', targetObjectId: 200 });
        const away = summarizeWorldState(makeState({ pet: { ...pet, icons: [] }, nearbyNpcs: [] }), 0);
        expect(away.pet).toEqual({ objectId: 600, name: null, level: null, healthPercent: null, distance: null, aggression: 'passive', walk: 'stay', targetObjectId: 200 });
        expect(summarizeWorldState(makeState(), 0).pet).toBeNull();
    });

    test('summary keys match the MCP output schema', () => {
        const state = makeState({
            player: makePlayer({ targetObjectId: 200 }),
            pet: { objectId: 200, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null },
            dialog: { isOpen: true, code: 5, data: [0, 0, 0, 0], type: 1, text: 'x', receivedAt: 0 },
            npcDialog: { npcObjectId: 1, npcName: 'n', text: 't', keywords: [], receivedAt: 0 },
            merchant: { isOpen: true, merchantObjectId: 1, windowType: 0, items: [{ page: 0, slot: 0, name: 'b', level: 1, price: 1, model: 1, usable: true, objectType: 0, hand: 0, damageType: null, value1: 0, spdAbs: 0 }] },
            group: [{ name: 'g', className: 'c', level: 1, objectId: 1, healthPercent: 1, manaPercent: 1, endurancePercent: 1, isDead: false, inOtherRegion: false }],
        });
        const summary = summarizeWorldState(state, 0);
        const worldSchema = (EXECUTE_CODE_OUTPUT_SCHEMA.properties.world as any).anyOf[0];
        const check = (value: any, schema: any, path: string) => {
            if (schema.anyOf) schema = value === null ? { type: 'null' } : schema.anyOf[0];
            if (schema.type === 'object' && schema.properties) {
                expect(Object.keys(value).sort(), path).toEqual(Object.keys(schema.properties).sort());
                for (const key of Object.keys(schema.properties)) check(value[key], schema.properties[key], `${path}.${key}`);
            } else if (schema.type === 'array') {
                expect(Array.isArray(value), path).toBe(true);
                for (const item of value) check(item, schema.items, `${path}[]`);
            } else if (schema.type && schema.type !== 'null') {
                expect(typeof value, path).toBe(schema.type);
            }
        };
        check(summary, worldSchema, 'world');
    });
});

test('messages with ids at or below sinceMessageId are excluded', () => {
    const s = summarizeWorldState(makeState({ gameMessages: [makeMessage(5, 'old'), makeMessage(6, 'new')] }), 0, { sinceMessageId: 5 });
    expect(s.messages.system).toEqual(['new']);
});
