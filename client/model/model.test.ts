import { describe, expect, test } from 'bun:test';
import { encodeCp1252, PacketWriter } from '../protocol/buffer';
import { ServerOp } from '../protocol/opcodes';
import { getRacesForClass, getStartingClasses } from '../../data/index';
import { creationPoints, planCharacter, RACE_MODELS } from './classes';
import { coinDrops, guessNpcRole, MAX_COMBAT_EVENTS, WorldModel } from './world-model';

const W = () => new PacketWriter();
const ME = { x: 574797, y: 530161, z: 2896 };

/** The realm each id was last created with: an 0xA1 of the same moment carries it (PacketLib168.cs:759, PacketLib1124.cs:163). */
const createdRealm = new Map<number, number>();

function npcCreate(oid: number, name: string, x: number, y: number, opts: { guild?: string; level?: number; peace?: boolean; pet?: boolean; realm?: number } = {}): Uint8Array {
    createdRealm.set(oid, opts.realm ?? 0);
    return W().u16(oid).u16(0).u16(0).u16(ME.z).u32(x).u32(y).u16(0).u16(400).u8(50).u8(opts.level ?? 1)
        .u8(((opts.realm ?? 0) << 6) | (opts.peace ? 0x10 : 0)).u8(0x20).u8(opts.pet ? 0x80 : 0).u8(0).u16(0).pascal(name).pascal(opts.guild ?? '').u8(0).toBytes();
}

/** 0x4B PlayerCreate (objects.ts decodePlayerCreate): realm in flag bits 2-3. */
const playerCreate = (oid: number, session: number, name: string, realm: number, model = 32) =>
    W().f32le(ME.x + 50).f32le(ME.y).f32le(ME.z).u16(session).u16(oid).u16(0).u16(model).u8(20).u8(realm << 2).fill(0, 10)
        .pascal(name).pascal('').pascal('').pascal('').pascal('').u8(0).toBytes();
const combatAnimation = (attacker: number, defender: number, healthPercent: number) =>
    W().u16(attacker).u16(defender).u16(3).u16(0).u16le(0).u8(0).u8(10).u8(healthPercent).u8(0).toBytes();

/** 0xEA open (PacketLib1109.cs:34-78). Money is [mithril, platinum, gold, silver, copper]; items are [slot, name]. */
function tradeOpen(title: string, o: { slots?: number[]; mine?: number[]; theirs?: number[]; items?: Array<[number, string]> } = {}): Uint8Array {
    const slots = o.slots ?? [];
    const items = o.items ?? [];
    const w = W().bytes(slots).fill(0, 10 - slots.length).u16(0);
    for (const coin of o.mine ?? [0, 0, 0, 0, 0]) w.u16(coin);
    w.u16(0);
    for (const coin of o.theirs ?? [0, 0, 0, 0, 0]) w.u16(coin);
    w.u16(0).u8(items.length).u8(1).u8(0).u8(0);
    for (const [slot, name] of items) {
        const count = Number(/^\d+/.exec(name)?.[0] ?? 1); // also in the value bytes (PacketLib1124.cs:850-853)
        w.u8(slot).u16(0).u8(5).u8(count).u8(0).u8(0).u8(0).u8(0).u16(5).u8(100).u8(100).u8(100).u8(0).u8(0).u16(99).u8(0).u16(0).u8(0x02).u16(0).pascal(name);
    }
    return w.pascal(title).toBytes();
}
const TRADE_CLOSE = new Uint8Array(40);

describe('classes / character creation', () => {
    test('every creatable class/race plan costs exactly 30 points and stays in realm', () => {
        let n = 0;
        for (const realm of [1, 2, 3]) {
            for (const c of getStartingClasses(realm)) {
                for (const race of getRacesForClass(c.id)) {
                    expect(race.realm).toBe(realm);
                    const plan = planCharacter(realm, c.key, race.name);
                    expect(plan.classId).toBe(c.id);
                    expect(creationPoints(race.id, plan.stats)).toBe(30);
                    expect(RACE_MODELS[race.id]).toContain(plan.model);
                    if (c.gender === 'female') expect(plan.gender).toBe(1);
                    n++;
                }
            }
        }
        expect(n).toBeGreaterThan(150);
    });

    test('follows the C# where the old hand-written table was wrong', () => {
        // ClassBainshee.cs:169 has no eligible races; Valkyrie has none on this server either.
        expect(() => planCharacter('hibernia', 'Bainshee', 'Elf')).toThrow(/cannot be a Bainshee/);
        expect(() => planCharacter('midgard', 'Valkyrie', 'Norseman')).toThrow();
        expect(planCharacter('albion', 'Fighter', 'Briton', 1).gender).toBe(1);
    });

    test('rejects invalid combos with readable errors', () => {
        expect(() => planCharacter('albion', 'Viking', 'Briton')).toThrow(/not a starting class/);
        expect(() => planCharacter('albion', 'Friar', 'Saracen')).toThrow(/cannot be a Friar/);
        expect(() => planCharacter('midgard', 'Warrior', 'Briton')).toThrow(/not a midgard race/);
    });

    test('Albion and Midgard "Rogue" resolve to different class ids', () => {
        expect(planCharacter('albion', 'Rogue', 'Briton').classId).toBe(17);
        expect(planCharacter('midgard', 'Rogue', 'Norseman').classId).toBe(38);
    });
});

describe('WorldModel', () => {
    test('NPC create → A1 update (zone-relative) → culling', () => {
        let now = 1000;
        const m = new WorldModel({}, () => now);
        m.handle(ServerOp.NPCCreate, npcCreate(500, 'Torr Fletcher', ME.x + 100, ME.y, { guild: 'Arrow Merchant', level: 25, peace: true }));
        let npcs = m.nearbyNpcs(ME);
        expect(npcs).toHaveLength(1);
        expect(npcs[0]).toMatchObject({ objectId: 500, name: 'Torr Fletcher', distance: 100, level: 25, isPeaceful: true, role: 'merchant', realm: 'none' });
        // 0xA1: zone 0 (Camelot Hills) XOffset 548864, YOffset 483328.
        now += 1000;
        const a1 = W().u16(0).u16(1024).u16(ME.x + 200 - 548864).u16(0).u16(ME.y - 483328).u16(0).u16(ME.z).u16(0).u16(500).u16(0)
            .u8(42).u8(0).u8(0).u8(0).toBytes();
        m.handle(ServerOp.ObjectUpdate, a1);
        npcs = m.nearbyNpcs(ME);
        expect(npcs[0]).toMatchObject({ x: ME.x + 200, y: ME.y, healthPercent: 42, heading: 1024 });
        now += 20_000;
        m.cull(ME);
        expect(m.npcs.size).toBe(0);
    });

    test('moving NPC is extrapolated toward its destination', () => {
        let now = 0;
        const m = new WorldModel({}, () => now);
        m.handle(ServerOp.NPCCreate, npcCreate(7, 'rat', ME.x, ME.y));
        const a1 = W().u16(100).u16(0).u16(ME.x - 548864).u16(ME.x + 1000 - 548864).u16(ME.y - 483328).u16(ME.y - 483328).u16(ME.z).u16(ME.z)
            .u16(7).u16(0).u8(100).u8(0).u8(0).u8(0).toBytes();
        m.handle(ServerOp.ObjectUpdate, a1);
        now += 2000;
        expect(m.positionOf(7)!.x).toBeCloseTo(ME.x + 200, 0);
        now += 60_000;
        expect(m.positionOf(7)!.x).toBeCloseTo(ME.x + 1000, 0);
    });

    test('popup NPC text becomes npcDialog with keywords', () => {
        const m = new WorldModel();
        m.handle(ServerOp.NPCCreate, npcCreate(500, 'Master Graent', ME.x, ME.y));
        m.handle(ServerOp.Message, W().u8(0x12).bytes(encodeCp1252('##')).cString('Master Graent says, "Do you wish to [train] or hear of [Camelot]?"').toBytes());
        expect(m.npcDialog).toMatchObject({ npcObjectId: 500, npcName: 'Master Graent', keywords: ['train', 'Camelot'] });
        expect(m.messages[0]).toMatchObject({ type: 'system', popup: true, sender: 'Master Graent' });
    });

    test('relayed 0xA9 from an unknown session asks for the player', () => {
        const asked: number[] = [];
        const m = new WorldModel({ onUnknownSession: s => asked.push(s) });
        const a9 = W().f32le(1).f32le(2).f32le(3).f32le(0).f32le(0).u16(9).u16(400).u16(0).u8(0).u8(0).u16(0).u16(0).u8(0).u8(0).u8(0).u8(100).u8(100).u8(100).u16(0).toBytes();
        m.handle(ServerOp.PlayerPosition, a9);
        expect(asked).toEqual([9]);
        m.handle(ServerOp.PlayerCreate172, W().f32le(1).f32le(2).f32le(3).u16(9).u16(400).u16(0).u16(32).u8(5).u8(1 << 2).fill(0, 10)
            .pascal('Bob').pascal('').pascal('').pascal('').pascal('').u8(0).toBytes());
        m.handle(ServerOp.PlayerPosition, a9);
        expect(asked).toEqual([9]);
        expect(m.nearbyPlayers(ME)[0]).toMatchObject({ name: 'Bob', sessionId: 9, realm: 'albion' });
    });

    test('our health reads 0 at the death, not the last it read: nothing else sets it until the next status packet', () => {
        // out6/vn3-115112: 'end 16 50 dead true', 'hp 16'. qa3-110639's state: 'HP 18/102 | ... | DEAD'.
        const m = new WorldModel();
        m.self.objectId = 123;
        m.self.health = 16;
        m.self.healthPercent = 16;
        m.handle(ServerOp.PlayerDeath, W().u16(123).u16(500).fill(0, 4).toBytes());
        expect(m.self).toMatchObject({ isDead: true, health: 0, healthPercent: 0 });
    });

    test('self death via 0xAE counts once and 0x89 revives', () => {
        let died = 0;
        const m = new WorldModel({ onSelfDeath: () => died++ });
        m.self.objectId = 123;
        m.self.targetObjectId = 500;
        m.handle(ServerOp.PlayerDeath, W().u16(123).u16(500).fill(0, 4).toBytes());
        m.handle(ServerOp.PlayerDeath, W().u16(123).u16(500).fill(0, 4).toBytes());
        expect(m.self.isDead).toBe(true);
        expect(m.self.targetObjectId).toBeNull(); // GamePlayer.Die: TargetObject = null (GamePlayer.cs:5743, :5900)
        expect(m.self.deathCount).toBe(1);
        expect(died).toBe(1);
        m.handle(ServerOp.PlayerRevive, W().u16(123).u16(0).toBytes());
        expect(m.self.isDead).toBe(false);
    });

    describe('a rez spell\'s question', () => {
        const REZ = 'Do you allow Nimue to resurrected you\n with 30 percent hits/power?';
        const box = (text: string) => W().u8(0).u8(6).u16(7).u16(1).u16(0).u16(0).u8(1).u8(0).bytes(encodeCp1252(text)).u8(0).toBytes();
        const dead = () => {
            const m = new WorldModel();
            m.self.objectId = 123;
            m.handle(ServerOp.PlayerDeath, W().u16(123).u16(500).fill(0, 4).toBytes());
            m.handle(ServerOp.Dialog, box(REZ));
            return m;
        };

        test('carries the offer', () => {
            expect(dead().dialog).toMatchObject({ isOpen: true, code: 6, data: [7, 1, 0, 0], resurrection: { caster: 'Nimue', healthPercent: 30 } });
        });

        test('another box carries none', () => {
            const m = new WorldModel();
            m.handle(ServerOp.Dialog, box('Do you accept?'));
            expect(m.dialog?.isOpen).toBe(true);
            expect(m.dialog?.resurrection).toBeUndefined();
        });

        test('closes with the revive: the server sends no close (0x89)', () => {
            const m = dead();
            m.handle(ServerOp.PlayerRevive, W().u16(123).u16(0).toBytes());
            expect(m.dialog?.isOpen).toBe(false);
        });

        test('closes when it expires', () => {
            const m = dead();
            m.handle(ServerOp.Message, W().u8(0).cString('Your resurrection spell has expired.').toBytes());
            expect(m.messages.at(-1)?.text).toBe('Your resurrection spell has expired.');
            expect(m.dialog?.isOpen).toBe(false);
        });

        test('a revive leaves another box open: a healer\'s offer comes while alive', () => {
            const m = dead();
            m.handle(ServerOp.Dialog, box('It will cost 188 copper to have your lost constitution restored. Do you accept?'));
            m.handle(ServerOp.PlayerRevive, W().u16(123).u16(0).toBytes());
            expect(m.dialog?.isOpen).toBe(true);
        });
    });

    test('skills: spec/ability/style split and skillIndex excludes specs', () => {
        const m = new WorldModel();
        const p = W().u8(1).u8(3).u8(3).u8(0)
            .u8(1).u16(10).u8(0).u16(0).u8(0).u16(5).pascal('Slash')
            .u8(1).u16(11).u8(1).u16(0).u8(0).u16(6).pascal('Sprint')
            .u8(2).u16(12).u8(2).u16(0x100).u8(0).u16(7).pascal('Slam').toBytes();
        m.handle(ServerOp.VariousUpdate, p);
        const s = m.skills();
        expect(s.specializations.map(x => x.name)).toEqual(['Slash']);
        expect(s.abilities).toEqual([{ name: 'Sprint', level: 1, internalId: 11, skillIndex: 0 }]);
        expect(s.styles[0]).toMatchObject({ name: 'Slam', skillIndex: 1, prerequisite: 0x100 });
    });

    test('0xD8 tooltips land on the style, spell and ability, and survive a resent skills list', () => {
        const m = new WorldModel();
        const skills = W().u8(1).u8(4).u8(3).u8(0)
            .u8(4).u16(10).u8(0).u16(0).u8(2).u16(5).pascal('Celtic Dual')
            .u8(1).u16(11).u8(1).u16(0).u8(0).u16(6).pascal('Sprint')
            .u8(4).u16(40000).u8(2).u16(105).u8(0).u16(7).pascal('Blinding Rain')
            .u8(9).u16(21).u8(3).u16(0).u8(0).u16(8).pascal('Spark').toBytes();
        const delve = (s: string) => m.handle(ServerOp.DelveInfo, new TextEncoder().encode(`${s}        expect(s.styles[0]).toMatchObject({ name: 'Slam', skillIndex: 1, prerequisite: 0x100 });`));
        m.handle(ServerOp.VariousUpdate, skills);
        delve('(Style (Index "-25536")(FollowupStyle "Blizzard, Gale")(Name "Blinding Rain")(Fatigue "5")(AttackMod "5")(OpeningDamage "175")(OpeningType "1")(OpeningResult "5")(Weapon "Dual Wield"))');
        delve('(Spell (Function "light")(Index "21")(Name "Spark")(instant "1")(damage_type "10")(power_cost "3")(range "1500")(target "1")(delve_string "Burns "hard" (once)."))');
        delve('(Ability (Index "11")(Name "Sprint"))');
        delve('not a tooltip');
        m.handle(ServerOp.VariousUpdate, skills);
        const s = m.skills();
        expect(s.specializations[0]!.bonus).toBe(2);
        expect(s.styles[0]!.details).toMatchObject({ fatigue: 5, attackMod: 5, openingDamage: 175, opening: 'defensive', result: 'evade', position: null, openingStyle: null, followUps: ['Blizzard', 'Gale'], weapon: 'Dual Wield', procSpellId: null });
        expect(s.spells[0]!.details).toMatchObject({ castTimeMs: 0, damageType: 'heat', powerCost: 3, costType: 'power', range: 1500, target: 'enemy', description: 'Burns "hard" (once).' });
        expect(s.abilities[0]!.details).toEqual({ Index: '11', Name: 'Sprint' });
    });

    test('a style tooltip with no opening type is an offensive one, and a positional 0 is the back', () => {
        const m = new WorldModel();
        m.handle(ServerOp.VariousUpdate, W().u8(1).u8(2).u8(3).u8(0)
            .u8(1).u16(1).u8(2).u16(0x100).u8(0).u16(0).pascal('Misty Gloom')
            .u8(8).u16(2).u8(2).u16(200).u8(0).u16(0).pascal('Snow Shower').toBytes());
        const delve = (s: string) => m.handle(ServerOp.DelveInfo, new TextEncoder().encode(`${s}        expect(s.styles[0]).toMatchObject({ name: 'Slam', skillIndex: 1, prerequisite: 0x100 });`));
        delve('(Style (Index "1")(Name "Misty Gloom")(Fatigue "15"))');
        delve('(Style (Index "2")(Name "Snow Shower")(OpeningType "2"))');
        const [gloom, snow] = m.skills().styles;
        expect(gloom!.details).toMatchObject({ opening: 'offensive', result: null, position: null });
        expect(snow!.details).toMatchObject({ opening: 'positional', position: 'back' });
    });

    test('merchant items keep what the window says about them', () => {
        const m = new WorldModel();
        const name = (s: string) => [s.length, 0, 0, 0, ...new TextEncoder().encode(s)];
        const item = (index: number, level: number, dps: number, spd: number, hand: number, type: number, usable: number, price: number, n: string) =>
            [index, level, dps, spd, hand << 6, type, usable, 30, 0, price & 255, price >> 8, 0, 0, 9, 0, ...name(n)];
        m.handle(ServerOp.MerchantWindow, Uint8Array.from([2, 0, 0, ...item(3, 4, 24, 35, 0, (2 << 6) | 19, 1, 375, 'long sword'), ...item(0, 1, 15, 28, 2, (1 << 6) | 20, 0, 150, 'club')]));
        expect(m.merchant.items).toMatchObject([
            { slot: 0, name: 'club', objectType: 20, hand: 2, damageType: 'crush', value1: 15, spdAbs: 28, usable: false },
            { slot: 3, name: 'long sword', objectType: 19, hand: 0, damageType: 'slash', value1: 24, spdAbs: 35, usable: true, price: 375 },
        ]);
    });

    test('inventory update adds and removes slots', () => {
        const m = new WorldModel();
        const item = (slot: number, name: string) => W().u8(slot).u16(0).u8(1).u8(0).u8(0).u8(0).u8(0).u8(0).u16(10).u8(100).u8(100).u8(100).u8(0).u8(0).u16(5).u8(0).u16(0).u8(0).u16(0).pascal(name).toBytes();
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([2, 0, 0, 0, 0, 2, ...item(40, 'a'), ...item(10, 'b')]));
        expect(m.inventoryList(40, 79).map(i => i.name)).toEqual(['a']);
        expect(m.inventoryList(10, 37).map(i => i.name)).toEqual(['b']);
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([1, 0, 0, 0, 0, 0, 40, ...new Uint8Array(24)]));
        expect(m.inventoryList(40, 79)).toEqual([]);
    });

    test('a vault keeper\'s window says it opened, even with nothing in it, and shows what it holds now', () => {
        const m = new WorldModel();
        const item = (slot: number, name: string) => W().u8(slot).u16(0).u8(1).u8(0).u8(0).u8(0).u8(0).u8(0).u16(10).u8(100).u8(100).u8(100).u8(0).u8(0).u16(5).u8(0).u16(0).u8(0).u16(0).pascal(name).toBytes();
        expect(m.vaultOpenedAt).toBeNull();
        // A move sends the slots with window 0: no window opened, and the slots land.
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([2, 0, 0, 0, 0, 0, ...item(40, 'pack'), ...item(112, 'moved')]));
        expect(m.vaultOpenedAt).toBeNull();
        expect(m.inventoryList(110, 149).map(i => i.name)).toEqual(['moved']);
        // The keeper's answer replaces the vault and leaves the rest alone: count 0, window 3 when empty (VaultKeeper.cs:78).
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([0, 0, 0, 0, 0, 3]));
        expect(m.vaultOpenedAt).not.toBeNull();
        expect(m.inventoryList(110, 149)).toEqual([]);
        expect(m.inventoryList(40, 79).map(i => i.name)).toEqual(['pack']);
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([1, 0, 0, 0, 0, 3, ...item(110, 'axe')]));
        // A vault past 30 items goes on in a second packet, with window 0.
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([1, 0, 0, 0, 0, 0, ...item(140, 'ring')]));
        expect(m.inventoryList(110, 149).map(i => i.name)).toEqual(['axe', 'ring']);
    });

    test('a smith has its own role: it buys and sells nothing, and it is no fight target', () => {
        expect(guessNpcRole('Judan Hammerfel', 'Smith')).toBe('smith');
        expect(guessNpcRole('Gram Ironhand', 'Armor Merchant')).toBe('merchant');
        expect(guessNpcRole('Lord Urqhart', 'Vault Keeper')).toBe('vault');
    });

    test('loot judged at spawn survives the 30 s 0xD9 re-create; old objects re-sent near a death are not loot', () => {
        let now = 1000;
        const m = new WorldModel({}, () => now);
        // 0xD9 ObjectCreate (PacketLib176.cs:73-149), no flags.
        const obj = (oid: number, name: string, x: number) =>
            W().u16(oid).u16(0).u16(0).u16(ME.z).u32(x).u32(ME.y).u16(500).u16(0).u32(0).pascal(name).u8(0).toBytes();
        m.handle(ServerOp.ObjectCreate, obj(900, 'well', ME.x + 50));
        m.handle(ServerOp.NPCCreate, npcCreate(501, 'spirit hound', ME.x + 100, ME.y));
        now += 1000;
        m.handle(ServerOp.RemoveObject, W().u16(501).u16(0).toBytes()); // dead NPC
        now += 500;
        m.handle(ServerOp.ObjectCreate, obj(901, 'Focus Staff', ME.x + 100));
        m.handle(ServerOp.ObjectCreate, obj(900, 'well', ME.x + 50)); // periodic re-send of a known object
        const byId = () => new Map(m.nearbyObjects(ME).map(o => [o.objectId, o]));
        expect(byId().get(901)!.isLoot).toBe(true);
        expect(byId().get(900)!.isLoot).toBe(false);
        now += 30_000;
        m.handle(ServerOp.ObjectCreate, obj(901, 'Focus Staff', ME.x + 100));
        expect(byId().get(901)!.isLoot).toBe(true);
    });

    test('spell lines: the 0x16/02 footer drops lines the server no longer sends', () => {
        const m = new WorldModel();
        const line = (idx: number, name: string) =>
            W().u8(2).u8(2).u8(2).u8(idx).u16le(0).u16(70 + idx).u16(0).pascal(name).u16le(1).u16(100 + idx).u16(5).pascal(`${name} spell`).toBytes();
        const footer = Uint8Array.of(2, 0, 99, 0);
        m.handle(ServerOp.VariousUpdate, line(0, 'A'));
        m.handle(ServerOp.VariousUpdate, line(1, 'B'));
        m.handle(ServerOp.VariousUpdate, footer);
        expect(m.skills().spells.map(s => s.lineName)).toEqual(['A', 'B']);
        m.handle(ServerOp.VariousUpdate, line(0, 'A'));
        m.handle(ServerOp.VariousUpdate, footer);
        expect([...m.spellLines.keys()]).toEqual([0]);
        m.handle(ServerOp.VariousUpdate, footer); // no lines at all (respec)
        expect(m.spellLines.size).toBe(0);
    });

    test('0xAD: the no-concentration sentinel (ushort)1000000 reads as 0, real values pass through', () => {
        const m = new WorldModel();
        const status = (maxConc: number, conc: number) => W().u8(100).u8(100).u8(0).u8(100).u8(100).u8(0)
            .u16(0).u16(100).u16(maxConc).u16(48).u16(48).u16(100).u16(0).u16(conc).toBytes();
        m.handle(ServerOp.CharacterStatusUpdate, status(16960, 16960));
        expect(m.self).toMatchObject({ maxConcentration: 0, concentration: 0, maxHealth: 48, health: 48, maxEndurance: 100 });
        m.handle(ServerOp.CharacterStatusUpdate, status(22, 17));
        expect(m.self).toMatchObject({ maxConcentration: 22, concentration: 17 });
    });

    test('decoder exceptions are caught and counted; unknown opcodes counted', () => {
        const m = new WorldModel();
        expect(m.handle(ServerOp.NPCCreate, Uint8Array.of(1, 2))).toBe(true);
        expect(m.decodeErrors).toBe(1);
        expect(m.recentDecodeErrors()).toBe(1);
        expect(m.handle(0x01, Uint8Array.of())).toBe(false);
        expect(m.unknownOpcodes.get(0x01)).toBe(1);
    });
});

/** 0xFB StatsUpdate in the SendCharStatsUpdate write order (PacketLib175.cs:240-300): base, buff, item (shorts + pad), caps, RA (bytes + pad), 0, maxHP. */
function statsPacket(base: number[], buff: number[], item: number[] = Array(8).fill(0), caps: number[] = Array(8).fill(0)): Uint8Array {
    const w = W();
    for (const v of base) w.u16(v);
    w.u16(0);
    for (const v of buff) w.u16(v & 0xFFFF); // pak.WriteShort((ushort) buff)
    w.u16(0);
    for (const v of item) w.u16(v);
    w.u16(0);
    for (const v of caps) w.u8(v);
    w.u8(0);
    w.fill(0, 9).u8(0).u8(0).u16(40).u16(0);
    return w.toBytes();
}

describe('WorldModel fixes', () => {
    test('0xFB: a stat debuff (negative buff column) lowers the stat instead of wrapping to ~65 000', () => {
        const m = new WorldModel();
        m.handle(ServerOp.StatsUpdate, statsPacket([60, 60, 60, 60, 60, 60, 60, 60], [-15, 0, 0, 0, 0, 0, 0, 10]));
        expect(m.decodeErrors).toBe(0);
        expect(m.self.stats!.strength).toBe(45);
        expect(m.self.stats!.charisma).toBe(70);
        expect(m.self.stats!.dexterity).toBe(60);
    });

    test('0xFA: platinum is 10^7 copper and mithril 10^10 (Money.cs:39-66)', () => {
        const m = new WorldModel();
        // PacketLib168.cs:1192-1196: copper u8, silver u8, gold u16, mithril u16, platinum u16.
        m.handle(ServerOp.MoneyUpdate, W().u8(5).u8(4).u16(3).u16(0).u16(1).toBytes());
        expect(m.self.money).toMatchObject({ copper: 5, silver: 4, gold: 3, platinum: 1, mithril: 0, totalCopper: 10_000_000 + 30_405 });
        m.handle(ServerOp.MoneyUpdate, W().u8(0).u8(0).u16(0).u16(2).u16(0).toBytes());
        expect(m.self.money.totalCopper).toBe(20_000_000_000);
    });

    test('0x16/01 style entries name their weapon spec from the GetSpecToInternalIndex byte', () => {
        const m = new WorldModel();
        // level, internalId, skillType 2 (style), special, bonus = GetSpecToInternalIndex(spec) (PacketLib1112.cs:150), icon, name.
        const p = W().u8(1).u8(3).u8(3).u8(0)
            .u8(2).u16(12).u8(2).u16(0).u8(0x01).u16(7).pascal('Backstab')
            .u8(5).u16(13).u8(2).u16(0).u8(0x41).u16(8).pascal('Bash')
            .u8(5).u16(14).u8(2).u16(0).u8(0xEE).u16(9).pascal('Odd').toBytes();
        m.handle(ServerOp.VariousUpdate, p);
        expect(m.skills().styles.map(s => s.specName)).toEqual(['Slash', 'Two Handed', null]);
    });

    test('0x16/01 lists a line under its display name while its style says the key', () => {
        const m = new WorldModel();
        const p = W().u8(1).u8(2).u8(3).u8(0)
            .u8(3).u16(74).u8(0).u16(0).u8(0).u16(1).pascal('Shield')
            .u8(3).u16(13).u8(2).u16(0).u8(0x2B).u16(8).pascal('Numb').toBytes();
        m.handle(ServerOp.VariousUpdate, p);
        expect(m.skills().specializations.map(s => s.name)).toEqual(['Shield']);
        expect(m.skills().styles.map(s => s.specName)).toEqual(['Shields']);
    });

    describe('trainer window lifetime', () => {
        const trainerPacket = W().u8(1).u8(3).u8(0).u8(0).u8(0).u8(2).u8(3).pascal('Slash').toBytes();
        const trainerAt = (m: WorldModel, x: number) => m.handle(ServerOp.NPCCreate, npcCreate(210, 'Master Graent', x, ME.y, { guild: 'Fighter Trainer' }));

        test('opens on 0x7B with the targeted trainer and receivedAt; a new target closes it', () => {
            let now = 5000;
            const m = new WorldModel({}, () => now);
            trainerAt(m, ME.x + 50);
            m.setSelfTarget(210);
            m.handle(ServerOp.TrainerWindow, trainerPacket);
            expect(m.trainer).toMatchObject({ isOpen: true, specPoints: 3, trainerObjectId: 210, receivedAt: 5000 });
            m.setSelfTarget(210); // re-targeting the same trainer keeps it open
            expect(m.trainer.isOpen).toBe(true);
            now = 6000;
            m.setSelfTarget(999);
            expect(m.trainer).toMatchObject({ isOpen: false, specs: [], trainerObjectId: null, receivedAt: 5000 });
        });

        test('the server ChangeTarget (0xB0) and a region change close it too', () => {
            const m = new WorldModel();
            trainerAt(m, ME.x + 50);
            m.setSelfTarget(210);
            m.handle(ServerOp.TrainerWindow, trainerPacket);
            m.handle(ServerOp.ChangeTarget, W().u16(0).u16(0).toBytes()); // PacketLib168.cs:2924-2932
            expect(m.trainer.isOpen).toBe(false);
            m.setSelfTarget(210);
            m.handle(ServerOp.TrainerWindow, trainerPacket);
            expect(m.trainer.isOpen).toBe(true);
            m.clearWorld();
            expect(m.trainer.isOpen).toBe(false);
        });

        test('walking away from where it opened closes it; opening far from the trainer does not (allow_train_anywhere)', () => {
            const m = new WorldModel();
            trainerAt(m, ME.x + 2000);
            m.setSelfTarget(210);
            m.handle(ServerOp.TrainerWindow, trainerPacket);
            m.cull(ME); // anchors here, 2000 units from the trainer
            expect(m.trainer.isOpen).toBe(true);
            m.cull({ ...ME, x: ME.x + 400 });
            expect(m.trainer.isOpen).toBe(true);
            m.cull({ ...ME, x: ME.x - 600 });
            expect(m.trainer.isOpen).toBe(false);
        });

        test('a window with no trainer target (allow_train_anywhere, or an in-flight reply) closes when we walk away from where it opened', () => {
            const m = new WorldModel();
            m.handle(ServerOp.TrainerWindow, trainerPacket);
            expect(m.trainer).toMatchObject({ isOpen: true, trainerObjectId: null });
            m.cull(ME); // anchors here
            m.setSelfTarget(999);
            m.cull({ ...ME, x: ME.x + 300 });
            expect(m.trainer.isOpen).toBe(true);
            m.cull({ ...ME, x: ME.x + 600 });
            expect(m.trainer.isOpen).toBe(false);
        });
    });
});

describe('WorldModel combat events', () => {
    test('0xBC sets the health of a player defender too (WeaponAction.cs:369), not only of an NPC', () => {
        const m = new WorldModel();
        m.self.objectId = 123;
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Ally', 1));
        m.handle(ServerOp.NPCCreate, npcCreate(500, 'rat', ME.x + 100, ME.y));
        m.handle(ServerOp.CombatAnimation, combatAnimation(302, 301, 61));
        m.handle(ServerOp.CombatAnimation, combatAnimation(301, 500, 40));
        expect(m.nearbyPlayers(ME).find(pl => pl.objectId === 301)).toMatchObject({ realm: 'midgard', healthPercent: 61, isDead: false });
        expect(m.nearbyNpcs(ME)[0]).toMatchObject({ objectId: 500, healthPercent: 40 });
        expect(m.combatEvents.map(e => [e.kind, e.attackerObjectId, e.targetObjectId, e.targetHealthPercent])).toEqual([['melee', 302, 301, 61], ['melee', 301, 500, 40]]);
    });

    test("our own swing at a player leaves its health alone: an intercepted blow carries the interceptor's (WeaponAction.cs:363-369)", () => {
        const m = new WorldModel();
        m.self.objectId = 123;
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Spiritmaster', 2));
        m.handle(ServerOp.CombatAnimation, combatAnimation(302, 301, 60));
        m.handle(ServerOp.CombatAnimation, combatAnimation(123, 301, 90)); // the pet's health
        m.handle(ServerOp.CombatAnimation, combatAnimation(123, 301, 0)); // the blow that killed the pet
        expect(m.nearbyPlayers(ME)[0]).toMatchObject({ objectId: 301, healthPercent: 60, isDead: false });
    });

    test('our own swing still sets an NPC defender\'s health', () => {
        const m = new WorldModel();
        m.self.objectId = 123;
        m.handle(ServerOp.NPCCreate, npcCreate(500, 'rat', ME.x + 100, ME.y));
        m.handle(ServerOp.CombatAnimation, combatAnimation(123, 500, 35));
        expect(m.nearbyNpcs(ME)[0]).toMatchObject({ objectId: 500, healthPercent: 35 });
    });

    test('another player dies only by 0xAE or a dead flag, and stays dead until it shows health again', () => {
        let now = 1000;
        const m = new WorldModel({}, () => now);
        m.self.objectId = 123;
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        /** 0xA9 relayed for session 9 (objects.ts decodePlayerPosition): state 0x14 is DEAD, the health byte's low 7 bits. */
        const a9 = (hp: number, state = 0) => W().f32le(ME.x + 50).f32le(ME.y).f32le(ME.z).f32le(0).f32le(0).u16(9).u16(301).u16(0)
            .u8(state).u8(0).u16(0).u16(0).u8(0).u8(0).u8(0).u8(hp).u8(100).u8(100).u16(0).toBytes();
        const norseman = () => m.nearbyPlayers(ME)[0]!;
        // Health is rounded down (GameLiving.cs:2621): a living player with a few hit points reads 0.
        m.handle(ServerOp.PlayerPosition, a9(0));
        m.handle(ServerOp.CombatAnimation, combatAnimation(302, 301, 0));
        expect(norseman()).toMatchObject({ healthPercent: 0, isDead: false });
        m.handle(ServerOp.PlayerDeath, W().u16(301).u16(302).fill(0, 4).toBytes());
        expect(norseman()).toMatchObject({ healthPercent: 0, isDead: true });
        // A relay without the flag (a client that doesn't send it) carries health 0: it stays dead.
        now += 1000;
        m.handle(ServerOp.PlayerPosition, a9(0));
        expect(norseman().isDead).toBe(true);
        // A relay sent before the death and delivered after it carries the old health: no revive yet.
        m.handle(ServerOp.PlayerPosition, a9(3));
        expect(norseman()).toMatchObject({ healthPercent: 3, isDead: true });
        // Rezzed (0x89 goes to it alone, ResurrectSpellHandler.cs:179): health again is the revive.
        now += 5000;
        m.handle(ServerOp.PlayerPosition, a9(10));
        expect(norseman()).toMatchObject({ healthPercent: 10, isDead: false });
        // A stale DEAD left over from before that revive: the server relays the state it last stored.
        m.handle(ServerOp.PlayerPosition, a9(10, 0x14));
        expect(norseman().isDead).toBe(false);
        // A DEAD state holds (the server strips it only from the living).
        m.handle(ServerOp.PlayerPosition, a9(0, 0x14));
        expect(norseman().isDead).toBe(true);
    });

    test('a dead player gone quiet is culled: it released out of our view and its corpse is gone', () => {
        let now = 1000;
        const m = new WorldModel({}, () => now);
        m.self.objectId = 123;
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Norseman', 2));
        m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Ally', 1));
        m.handle(ServerOp.PlayerDeath, W().u16(301).u16(302).fill(0, 4).toBytes());
        now += 30_000;
        m.cull(ME);
        expect(m.players.size).toBe(2);
        now += 31_000;
        m.cull(ME);
        // The living one standing still stays (it may just be idle).
        expect([...m.players.keys()]).toEqual([302]);
    });

    test('spell cast and effect events keep the client effect id', () => {
        const m = new WorldModel();
        m.handle(ServerOp.SpellCastAnimation, W().u16(301).u16(5208).u16(30).u16(0).toBytes());
        m.handle(ServerOp.SpellEffectAnimation, W().u16(301).u16(5208).u16(123).u16(0).u8(0).u8(1).toBytes());
        expect(m.combatEvents).toMatchObject([
            { kind: 'spellCast', attackerObjectId: 301, targetObjectId: null, castTimeMs: 3000, effectId: 5208 },
            { kind: 'spellEffect', attackerObjectId: 301, targetObjectId: 123, effectId: 5208 },
        ]);
    });

    test('0xEA opens a trade: copper totals, the partner by name, and a signal', () => {
        const signals: string[] = [];
        const m = new WorldModel({ onSignificant: r => signals.push(r) });
        expect(m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine', { slots: [40, 41], mine: [0, 0, 1, 2, 3], theirs: [0, 0, 0, 0, 50], items: [[45, '3 minor healing potion']] }))).toBe(true);
        expect(m.trade).toMatchObject({ revision: 1, partnerName: 'Aine', mySlots: [40, 41], myMoney: 10203, partnerMoney: 50 });
        expect(m.trade!.partnerItems).toMatchObject([{ slot: 45, name: 'minor healing potion', count: 3 }]);
        expect(signals).toEqual(['trade']);
        expect(m.unknownOpcodes.size).toBe(0);
        expect(m.decodeErrors).toBe(0);
    });

    test('a second 0xEA in the same millisecond is a new revision of the same window', () => {
        const m = new WorldModel({}, () => 1000);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        const first = m.trade!;
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine', { slots: [40] }));
        expect(m.trade).toMatchObject({ id: first.id, revision: 2, mySlots: [40] });
        expect(first).toMatchObject({ revision: 1, mySlots: [] }); // replaced, never mutated: a snapshot may hold it
    });

    test('the close clears the window, and is a no-op with nothing open', () => {
        const m = new WorldModel();
        expect(m.handle(ServerOp.TradeWindow, TRADE_CLOSE)).toBe(true);
        expect(m.trade).toBeNull();
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        m.handle(ServerOp.TradeWindow, TRADE_CLOSE);
        expect(m.trade).toBeNull();
        expect(m.decodeErrors).toBe(0);
        expect(m.unknownOpcodes.size).toBe(0);
    });

    test('a new window gets a new id: after a close, for another partner, and across models', () => {
        const m = new WorldModel({}, () => 1000);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        const first = m.trade!.id;
        m.handle(ServerOp.TradeWindow, TRADE_CLOSE);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        const second = m.trade!;
        expect(second.id).not.toBe(first);
        expect(second.revision).toBe(1);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Bran'));
        expect(m.trade!.id).not.toBe(second.id);
        expect(m.trade!.revision).toBe(1);
        const other = new WorldModel();
        other.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        expect(other.trade!.id).toBeGreaterThan(m.trade!.id);
    });

    test('Selfcrafting has no partner', () => {
        const m = new WorldModel();
        m.handle(ServerOp.TradeWindow, tradeOpen('Selfcrafting'));
        expect(m.trade).toMatchObject({ partnerName: null, revision: 1 });
        m.handle(ServerOp.TradeWindow, tradeOpen('Selfcrafting'));
        expect(m.trade).toMatchObject({ partnerName: null, revision: 2 });
    });

    test('a partner item in slot 45 leaves our slot 45 alone', () => {
        const m = new WorldModel();
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine', { items: [[45, 'their sword']] }));
        expect(m.items.has(45)).toBe(false);
        m.items.set(45, { slot: 45, name: 'my sword' } as never);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine', { items: [[45, 'their sword'], [46, 'their shield']] }));
        expect(m.items.get(45)!.name).toBe('my sword');
        expect(m.items.has(46)).toBe(false);
    });

    test('clearWorld clears the window, and a late close stays a no-op', () => {
        const m = new WorldModel();
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        m.clearWorld();
        expect(m.trade).toBeNull();
        m.handle(ServerOp.TradeWindow, TRADE_CLOSE);
        expect(m.trade).toBeNull();
    });

    test('the slot refresh after a money drop (500-504 wrapped to a byte, 244-248) changes nothing', () => {
        const m = new WorldModel();
        m.items.set(40, { slot: 40, name: 'my sword' } as never);
        m.handle(ServerOp.TradeWindow, tradeOpen('Trading with Aine'));
        const trade = m.trade;
        m.handle(ServerOp.InventoryUpdate, W().u8(1).u8(0).u8(0).u8(0).u8(0).u8(0).u8(244).fill(0, 24).toBytes());
        expect([...m.items.keys()]).toEqual([40]);
        expect(m.trade).toBe(trade);
        expect(m.decodeErrors).toBe(0);
    });

    test('coinDrops: one drop per nonzero coin, largest first, adding up to the amount', () => {
        expect(coinDrops(10_000_030_405)).toEqual([[500, 1], [502, 3], [503, 4], [504, 5]]);
        expect(coinDrops(500)).toEqual([[503, 5]]);
        expect(coinDrops(10_000_000)).toEqual([[501, 1]]);
        expect(coinDrops(19_999_999)).toEqual([[501, 1], [502, 999], [503, 99], [504, 99]]);
    });

    test(`the buffer keeps the newest ${MAX_COMBAT_EVENTS} events (a group fight is many swings a second)`, () => {
        expect(MAX_COMBAT_EVENTS).toBe(200);
        const m = new WorldModel();
        for (let i = 0; i < 250; i++) m.handle(ServerOp.CombatAnimation, combatAnimation(301, 123, 100 - (i % 100)));
        expect(m.combatEvents).toHaveLength(200);
        expect(m.combatEvents[0]!.id).toBe(m.combatEvents.at(-1)!.id - 199);
    });
});

describe('WorldModel pet window', () => {
    const SELF = 123;
    const PET = 600;
    const MOB = 500;
    /** 0x88 in the write order of PacketLib181.cs:102-176. Action 2 open, 1 update; aggro 1 aggressive, 2 defensive, 3 passive; walk 1 follow, 2 stay, 3 go to target, 4 come here. */
    const petWindow = (action: number, aggro = 2, walk = 1, icons: number[] = [], oid = PET): Uint8Array => {
        const w = W().u16(oid).u8(0).u8(0).u8(action).u8(aggro).u8(walk).u8(0).u8(icons.length);
        for (const icon of icons) w.u16(icon);
        return w.toBytes();
    };
    const PET_CLOSE = Uint8Array.of(0, 0, 0, 0, 0, 1, 1, 0, 0); // CharacterClassBase.cs:305
    /** 0xA2: type 0 a dead NPC, 1 a living one moved (PacketLib168.cs:884). */
    const remove = (oid: number, type: number) => W().u16(oid).u16(type).toBytes();
    /** 0xA1 in zone 0 (Camelot Hills): targetId 0 not attacking, 65535 attacking but unnamed (PacketLib168.cs:820-828). */
    const objectUpdate = (oid: number, targetId: number, healthPercent = 100, realm = createdRealm.get(oid) ?? 0) =>
        W().u16(0).u16(0).u16(ME.x - 548864).u16(0).u16(ME.y - 483328).u16(0).u16(ME.z).u16(0).u16(oid).u16(targetId).u8(healthPercent).u8(realm << 6).u8(0).u8(0).toBytes();
    /** The same with a speed, at a chosen spot. */
    const movingUpdate = (oid: number, targetId: number, speed: number, healthPercent = 100, x = ME.x) =>
        W().u16(speed).u16(0).u16(x - 548864).u16(0).u16(ME.y - 483328).u16(0).u16(ME.z).u16(0).u16(oid).u16(targetId).u8(healthPercent).u8((createdRealm.get(oid) ?? 0) << 6).u8(0).u8(0).toBytes();
    /** 0x72 SpellCastAnimation: the caster, its effect, the cast time in tenths. */
    const castAnimation = (caster: number) => W().u16(caster).u16(5208).u16(30).u16(0).toBytes();
    /** 0x1B (PacketLib174.cs:410-470). The effect is the spell's ClientEffect (SpellHandler.cs:1284-1291): by default a snare's, Detaining Vines. */
    const spellEffect = (caster: number, target: number, effect = 5208) => W().u16(caster).u16(effect).u16(target).u16(0).u8(0).u8(1).toBytes();
    /** Our summon's 0x1B on its pet: Call Minor Earth Elemental's effect (spell.sql). */
    const summoned = (target: number) => spellEffect(SELF, target, 101);
    const objectCreate = (oid: number, name: string, x: number) => W().u16(oid).u16(0).u16(0).u16(ME.z).u32(x).u32(ME.y).u16(500).u16(0).u32(0).pascal(name).u8(0).toBytes();
    /** Somebody's hit on a mob: one on a pet at full health with no attack seen has no aggro on us, and isn't handed over (StandardMobBrain.cs:566-571). */
    const hurt = (m: WorldModel, oid = MOB, healthPercent = 90) => m.handle(ServerOp.CombatAnimation, combatAnimation(999, oid, healthPercent));

    /** A model with our pet up, its window open, and no combat in the last 8 s. */
    function withPet() {
        let now = 100_000;
        const signals: string[] = [];
        const m = new WorldModel({ onSignificant: r => signals.push(r) }, () => now);
        m.self.objectId = SELF;
        m.self.realm = 1;
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
        m.handle(ServerOp.PetWindow, petWindow(2));
        return { m, signals, advance: (ms: number) => { now += ms; }, now: () => now };
    }

    test('open: state from the server, unhandled opcodes stay empty, and a signal', () => {
        const { m, signals } = withPet();
        expect(m.pet).toEqual({ objectId: PET, name: 'wolf', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null });
        expect(m.lastPetLoss).toBeNull();
        expect(signals).toEqual(['pet']);
        expect(m.unknownOpcodes.size).toBe(0);
        expect(m.decodeErrors).toBe(0);
    });

    test('update: the wire values, icons, and it keeps the target', () => {
        const { m } = withPet();
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
        const before = m.pet;
        m.handle(ServerOp.PetWindow, petWindow(1, 1, 2, [3586, 5251]));
        expect(m.pet).toEqual({ objectId: PET, name: 'wolf', aggression: 'aggressive', walk: 'stay', icons: [3586, 5251], targetObjectId: MOB });
        expect(before).toMatchObject({ aggression: 'defensive', icons: [] }); // replaced, never mutated: a snapshot may hold it
        m.handle(ServerOp.PetWindow, petWindow(1, 3, 3));
        expect(m.pet).toMatchObject({ aggression: 'passive', walk: 'goTarget' });
        m.handle(ServerOp.PetWindow, petWindow(1, 3, 4));
        expect(m.pet).toMatchObject({ aggression: 'passive', walk: 'comeHere' });
    });

    test('close: the window is gone, cause released, named from the NPC entry', () => {
        const { m, now } = withPet();
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toEqual({ objectId: PET, name: 'wolf', cause: 'released', at: now() });
    });

    test('a close with no window open is a no-op', () => {
        const m = new WorldModel();
        expect(m.handle(ServerOp.PetWindow, PET_CLOSE)).toBe(true);
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toBeNull();
        expect(m.decodeErrors).toBe(0);
    });

    test('clearWorld: cause region_change, and a late close stays a no-op', () => {
        const { m } = withPet();
        m.clearWorld();
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toMatchObject({ name: 'wolf', cause: 'region_change' });
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toMatchObject({ cause: 'region_change' });
    });

    test('our death: cause owner_died, and a late close and 0xA2 stay no-ops', () => {
        const { m } = withPet();
        m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toMatchObject({ name: 'wolf', cause: 'owner_died' });
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        m.handle(ServerOp.RemoveObject, remove(PET, 0));
        expect(m.lastPetLoss).toMatchObject({ cause: 'owner_died' });
    });

    test('0xA2 type 0 with the window open: it died, keeps the death event, and a later close is a no-op', () => {
        const { m, now, advance } = withPet();
        m.handle(ServerOp.RemoveObject, remove(PET, 0));
        const at = now();
        expect(m.pet).toBeNull();
        expect(m.lastPetLoss).toEqual({ objectId: PET, name: 'wolf', cause: 'died', at });
        expect(m.combatEvents.at(-1)).toMatchObject({ kind: 'death', targetObjectId: PET });
        advance(100);
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        expect(m.lastPetLoss).toEqual({ objectId: PET, name: 'wolf', cause: 'died', at });
    });

    test('an update landing between that 0xA2 and the close brings nothing back', () => {
        const { m } = withPet();
        m.handle(ServerOp.RemoveObject, remove(PET, 0));
        m.handle(ServerOp.PetWindow, petWindow(1));
        expect(m.pet).toBeNull();
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        expect(m.lastPetLoss).toMatchObject({ cause: 'died' });
    });

    test('close, then its 0xA2 type 0: released, and still a death event', () => {
        const { m } = withPet();
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        m.handle(ServerOp.RemoveObject, remove(PET, 0));
        expect(m.lastPetLoss).toMatchObject({ objectId: PET, name: 'wolf', cause: 'released' });
        expect(m.combatEvents.at(-1)).toMatchObject({ kind: 'death', targetObjectId: PET });
    });

    test('a window for the next pet after a loss: its own state, the loss stays on record', () => {
        const { m } = withPet();
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], 601));
        expect(m.pet).toEqual({ objectId: 601, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null });
        expect(m.lastPetLoss).toMatchObject({ objectId: PET, cause: 'released' });
    });

    test('no pet, dead or released, is a loot source, and another NPC still is', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.RemoveObject, remove(PET, 0));
        m.handle(ServerOp.ObjectCreate, objectCreate(900, 'well', ME.x + 50));
        expect(m.nearbyObjects(ME).find(o => o.objectId === 900)!.isLoot).toBe(false);
        // An enemy's pet too, with no window of ours.
        m.handle(ServerOp.NPCCreate, npcCreate(602, 'bear', ME.x + 200, ME.y, { pet: true, realm: 2 }));
        m.handle(ServerOp.RemoveObject, remove(602, 0));
        m.handle(ServerOp.ObjectCreate, objectCreate(901, 'stone', ME.x + 200));
        expect(m.nearbyObjects(ME).find(o => o.objectId === 901)!.isLoot).toBe(false);
        advance(100);
        m.handle(ServerOp.RemoveObject, remove(MOB, 0));
        m.handle(ServerOp.ObjectCreate, objectCreate(902, 'Focus Staff', ME.x + 100));
        expect(m.nearbyObjects(ME).find(o => o.objectId === 902)!.isLoot).toBe(true);
    });

    test('0xA2 type 1, the same-region jump, keeps the pet and drops only its entry', () => {
        const { m } = withPet();
        m.handle(ServerOp.RemoveObject, remove(PET, 1));
        expect(m.pet).toMatchObject({ objectId: PET });
        expect(m.lastPetLoss).toBeNull();
        expect(m.npcs.has(PET)).toBe(false);
        expect(m.combatEvents).toEqual([]);
    });

    test('a cull drops the entry and keeps the window, by range and by silence', () => {
        const { m, advance } = withPet();
        m.cull({ ...ME, x: ME.x + 7000 });
        expect(m.npcs.has(PET)).toBe(false);
        expect(m.pet).toMatchObject({ objectId: PET });
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
        advance(20_000);
        m.cull(ME);
        expect(m.npcs.has(PET)).toBe(false);
        expect(m.pet).toMatchObject({ objectId: PET });
        expect(m.lastPetLoss).toBeNull();
    });

    test('a 0xDA re-create of a jumped or culled pet keeps its health, and only the pet\'s', () => {
        const { m } = withPet();
        m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 55));
        m.handle(ServerOp.RemoveObject, remove(PET, 1));
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 500, ME.y, { pet: true, realm: 1 }));
        expect(m.npcs.get(PET)!.healthPercent).toBe(55);
        // A 0xA1 keeps it current, even with no entry to land on.
        m.cull({ ...ME, x: ME.x + 7000 });
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0, 40));
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
        expect(m.npcs.get(PET)!.healthPercent).toBe(40);
        // Someone else's NPC comes back whole, as before.
        m.handle(ServerOp.RemoveObject, remove(MOB, 1));
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
        expect(m.npcs.get(MOB)!.healthPercent).toBe(100);
    });

    test('a charmed mob keeps its wound through the window opening', () => {
        const m = new WorldModel();
        m.self.objectId = SELF;
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
        m.handle(ServerOp.CombatAnimation, combatAnimation(SELF, MOB, 70));
        m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], MOB));
        m.handle(ServerOp.RemoveObject, remove(MOB, 1));
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y, { pet: true }));
        expect(m.npcs.get(MOB)!.healthPercent).toBe(70);
    });

    test('0xBC with the pet swinging: we are in combat, and it is its target', () => {
        const { m, advance } = withPet();
        expect(m.inCombat()).toBe(false);
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
        expect(m.inCombat()).toBe(true);
        expect(m.pet!.targetObjectId).toBe(MOB);
        expect(m.self.attacking).toBe(false);
        advance(8000);
        expect(m.inCombat()).toBe(false);
    });

    test('0xBC with the pet hit: we are in combat, and the mob now aims at the pet, not at us', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 80));
        expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.targetObjectId).toBe(SELF);
        advance(8000);
        expect(m.inCombat()).toBe(true); // that mob still reads as on us
        m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 60));
        expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)).toMatchObject({ targetObjectId: PET, inCombat: true });
        expect(m.npcs.get(PET)!.healthPercent).toBe(60);
        expect(m.pet!.targetObjectId).toBeNull(); // its attacker is not who it is fighting, until it swings or 0xA1 says so
        expect(m.inCombat()).toBe(true);
        // And back again.
        m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 70));
        expect(m.npcs.get(MOB)!.targetId).toBe(SELF);
    });

    test('a mob on the pet reads as combat for as long as it stays on it, and with the pet gone it is on us until an 0xA1 reads 0', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET, 90));
        expect(m.inCombat()).toBe(true);
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        expect(m.inCombat()).toBe(true);
        m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
        expect(m.inCombat()).toBe(false);
        advance(8000);
        expect(m.inCombat()).toBe(false);
    });

    test('with no pet, swings between others count for nothing', () => {
        const m = new WorldModel({}, () => 100_000);
        m.self.objectId = SELF;
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
        expect(m.inCombat()).toBe(false);
        m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, 0, 90));
        expect(m.inCombat()).toBe(false);
    });

    test('0x1B by the pet on us or on itself is no combat and no target', () => {
        const { m } = withPet();
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, SELF));
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, PET));
        expect(m.inCombat()).toBe(false);
        expect(m.pet!.targetObjectId).toBeNull();
    });

    test('0x1B by the pet at one of our realm is no combat and no target: it buffs the group and its minions (ControlledMobBrain.cs:434-503)', () => {
        const { m } = withPet();
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
        m.handle(ServerOp.NPCCreate, npcCreate(601, 'minion', ME.x + 60, ME.y, { pet: true, realm: 1 }));
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, 301));
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, 601));
        expect(m.inCombat()).toBe(false);
        expect(m.pet!.targetObjectId).toBeNull();
    });

    test('0x1B by the pet at an enemy: combat, and its target, also one out of our view or a player of another realm', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB));
        expect(m.inCombat()).toBe(true);
        expect(m.pet!.targetObjectId).toBe(MOB);
        advance(8000);
        expect(m.inCombat()).toBe(false);
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, 999));
        expect(m.pet!.targetObjectId).toBe(999);
        m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, 302));
        expect(m.pet!.targetObjectId).toBe(302);
    });

    test('0x1B on the pet by an enemy is combat, by a friend it is not; on us it counts as ever', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(301, PET));
        expect(m.inCombat()).toBe(false);
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, PET));
        expect(m.inCombat()).toBe(true);
        expect(m.pet!.targetObjectId).toBeNull();
        advance(8000);
        m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SELF));
        expect(m.inCombat()).toBe(true);
    });

    test('0xA1 for the pet: 0 clears the target once the aim is old, 65535 keeps it, a real id sets it, with or without its entry', () => {
        const { m, advance } = withPet();
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
        expect(m.pet!.targetObjectId).toBe(MOB);
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
        expect(m.pet!.targetObjectId).toBe(MOB);
        advance(6001);
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
        expect(m.pet!.targetObjectId).toBeNull();
        m.handle(ServerOp.RemoveObject, remove(PET, 1));
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 501));
        expect(m.pet!.targetObjectId).toBe(501);
        // Another NPC's 0xA1 leaves it alone.
        m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
        expect(m.pet!.targetObjectId).toBe(501);
    });

    test('its target removed: type 0 clears it, a jump keeps it, and a player dies by 0xAE', () => {
        const { m } = withPet();
        m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, 501, 90));
        m.handle(ServerOp.RemoveObject, remove(MOB, 0)); // somebody else's
        expect(m.pet!.targetObjectId).toBe(501);
        m.handle(ServerOp.RemoveObject, remove(501, 1));
        expect(m.pet!.targetObjectId).toBe(501);
        m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
        m.handle(ServerOp.RemoveObject, remove(501, 0));
        expect(m.pet!.targetObjectId).toBeNull();
        m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
        m.handle(ServerOp.CombatAnimation, combatAnimation(PET, 302, 50));
        expect(m.pet!.targetObjectId).toBe(302);
        m.handle(ServerOp.PlayerDeath, W().u16(302).u16(PET).fill(0, 4).toBytes());
        expect(m.pet!.targetObjectId).toBeNull();
        expect(m.pet).not.toBeNull();
    });

    /** A system line (0xAF Message, chat.ts decodeMessage). */
    const line = (text: string) => W().u8(0).cString(text).toBytes();
    const KILL = 'You command the wolf to kill your target!';
    const elsewhere = { ...ME, x: ME.x + 7000 };

    describe('the pet\'s name outlives its entry', () => {
        test('a loss out of view still names it, after a cull and after a jump', () => {
            const { m } = withPet();
            m.cull(elsewhere);
            expect(m.npcs.has(PET)).toBe(false);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(m.lastPetLoss).toMatchObject({ objectId: PET, name: 'wolf', cause: 'released' });

            m.handle(ServerOp.NPCCreate, npcCreate(601, 'bear', ME.x + 50, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], 601));
            m.handle(ServerOp.RemoveObject, remove(601, 1));
            m.clearWorld();
            expect(m.lastPetLoss).toMatchObject({ objectId: 601, name: 'bear', cause: 'region_change' });
        });

        test('an entry that comes after the window counts, and a pet never seen has no name, not the last one\'s', () => {
            const { m } = withPet();
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], 602));
            m.handle(ServerOp.NPCCreate, npcCreate(602, 'cat', ME.x + 50, ME.y, { pet: true, realm: 1 }));
            m.cull(elsewhere);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(m.lastPetLoss).toMatchObject({ objectId: 602, name: 'cat' });

            m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], 603));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(m.lastPetLoss).toMatchObject({ objectId: 603, name: null });
        });
    });

    describe('who the pet is fighting', () => {
        test('an attack order\'s line names our target, through the run-in', () => {
            const { m, advance } = withPet();
            m.setSelfTarget(MOB);
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBe(MOB);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
            expect(m.pet!.targetObjectId).toBe(MOB);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBe(MOB);
            advance(6001);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBeNull();
        });

        test('the line names nobody with no target selected, and with no window it is ignored', () => {
            const { m } = withPet();
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBeNull();
            const none = new WorldModel({}, () => 100_000);
            none.setSelfTarget(MOB);
            none.handle(ServerOp.Message, line(KILL));
            expect(none.decodeErrors).toBe(0);
            expect(none.pet).toBeNull();
        });

        test('a caster between casts: 0xA1\'s 0 clears only when the last aim is over 6 s old, and 0xBC, 0x1B and a named 0xA1 each renew it', () => {
            const aims: Array<(m: WorldModel) => void> = [
                m => m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90)),
                m => m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB)),
                m => m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB)),
            ];
            for (const aim of aims) {
                const { m, advance } = withPet();
                aim(m);
                expect(m.pet!.targetObjectId).toBe(MOB);
                advance(6000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
                expect(m.pet!.targetObjectId).toBe(MOB);
                aim(m);
                advance(5999);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
                expect(m.pet!.targetObjectId).toBe(MOB);
                advance(2);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
                expect(m.pet!.targetObjectId).toBeNull();
            }
        });

        test('a run-in over 6 s: its 0xFFFFs keep the aim fresh, so its first 0 at the stop still holds', () => {
            const { m, advance } = withPet();
            m.setSelfTarget(MOB);
            m.handle(ServerOp.Message, line(KILL));
            for (let i = 0; i < 4; i++) {
                advance(2000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
            }
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBe(MOB);
            advance(6000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBe(MOB);
            advance(1);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBeNull();
        });

        test('a 0xFFFF with no target aims at nobody', () => {
            const { m } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
            expect(m.pet!.targetObjectId).toBeNull();
        });

        test('the target\'s death ends the hold at once, by 0xA2 type 0 and by 0xAE', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            expect(m.pet!.targetObjectId).toBeNull();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBeNull();

            m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, 302));
            m.handle(ServerOp.PlayerDeath, W().u16(302).u16(PET).fill(0, 4).toBytes());
            expect(m.pet!.targetObjectId).toBeNull();
        });

        describe('its own entry goes with it: a pet that stands still has no 0xA1 for up to 5 s (AttackComponent.cs:737-785, ClientService.cs:816-823)', () => {
            const inCombat = (m: WorldModel, oid = PET) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.inCombat;

            test('at the death of its target, by 0xA2 type 0 and by 0xAE', () => {
                const { m } = withPet();
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
                expect(inCombat(m)).toBe(true);
                m.handle(ServerOp.RemoveObject, remove(MOB, 0));
                expect(inCombat(m)).toBe(false);

                m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 302));
                expect(inCombat(m)).toBe(true);
                m.handle(ServerOp.PlayerDeath, W().u16(302).u16(PET).fill(0, 4).toBytes());
                expect(inCombat(m)).toBe(false);
            });

            test('a 0xFFFF it read on its way in goes too, by 0xA2 type 0 and by 0xAE: it can\'t outlive the fight', () => {
                const { m } = withPet();
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
                expect(inCombat(m)).toBe(true);
                m.handle(ServerOp.RemoveObject, remove(MOB, 0));
                expect(inCombat(m)).toBe(false);

                m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, 302, 50));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
                expect(inCombat(m)).toBe(true);
                m.handle(ServerOp.PlayerDeath, W().u16(302).u16(PET).fill(0, 4).toBytes());
                expect(inCombat(m)).toBe(false);
            });

            test('not when another mob dies: it reads 0xFFFF on its way to the one it is after', () => {
                const { m } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0xFFFF));
                m.handle(ServerOp.RemoveObject, remove(501, 0));
                expect(inCombat(m)).toBe(true);
                expect(m.pet!.targetObjectId).toBe(MOB);
            });

            test('a summon\'s too, which has no window to clear', () => {
                const { m } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(610, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, summoned(610));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(610, MOB));
                expect(inCombat(m, 610)).toBe(true);
                m.handle(ServerOp.RemoveObject, remove(MOB, 0));
                expect(inCombat(m, 610)).toBe(false);
            });

            test('at an order that calls it off', () => {
                for (const off of [
                    (m: WorldModel) => m.handle(ServerOp.Message, line('You command the wolf to stay in this position!')),
                    (m: WorldModel) => m.handle(ServerOp.Message, line('You command the wolf to go to your target.')),
                    (m: WorldModel) => m.handle(ServerOp.PetWindow, petWindow(1, 3)),
                ]) {
                    const { m } = withPet();
                    m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
                    off(m);
                    expect(inCombat(m)).toBe(false);
                }
            });

            test('not at another mob\'s death, nor at a jump of its own target (0xA2 type 1)', () => {
                const { m } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(302, 'goblin', ME.x + 120, ME.y));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
                m.handle(ServerOp.RemoveObject, remove(302, 0));
                expect(inCombat(m)).toBe(true);
                m.handle(ServerOp.RemoveObject, remove(MOB, 1));
                expect(inCombat(m)).toBe(true);
            });
        });

        test('a follow, stay, come here or go to target answer clears it at once; a stance answer doesn\'t', () => {
            for (const text of ['You command the wolf to follow you!', 'You command the wolf to stay in this position!', 'You command the wolf to come to you.', 'You command the wolf to go to your target.']) {
                const { m } = withPet();
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
                m.handle(ServerOp.Message, line(text));
                expect(m.pet!.targetObjectId).toBeNull();
                // A defensive pet that is hit back has a fresh target from its next swing.
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 80));
                expect(m.pet!.targetObjectId).toBe(MOB);
            }
            for (const text of ['You command the wolf to defend you!', 'You command the wolf to attack all enemies!', 'Bob says, "You command the wolf to follow you!"']) {
                const { m } = withPet();
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
                m.handle(ServerOp.Message, line(text));
                expect(m.pet!.targetObjectId).toBe(MOB);
            }
        });

        test('a window change to passive clears it at once; a passive window repeated keeps a later swing', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
            m.handle(ServerOp.PetWindow, petWindow(1, 1));
            expect(m.pet!.targetObjectId).toBe(MOB);
            m.handle(ServerOp.PetWindow, petWindow(1, 3));
            expect(m.pet).toMatchObject({ aggression: 'passive', targetObjectId: null });
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 80));
            m.handle(ServerOp.PetWindow, petWindow(1, 3, 1, [3586]));
            expect(m.pet).toMatchObject({ aggression: 'passive', targetObjectId: MOB });
        });
    });

    describe('summons: our pets with no window', () => {
        const SPIRIT = 610;
        /** A Theurgist-like model: no window, one pet just summoned (0xDA in AddToWorld, then the effect's 0x1B caster us, target it: SummonSpellHandler.cs:176, :183), and no combat so far. */
        function withSummon() {
            let now = 100_000;
            const m = new WorldModel({}, () => now);
            m.self.objectId = SELF;
            m.self.realm = 1;
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
            return { m, advance: (ms: number) => { now += ms; } };
        }

        test('our 0x1B on a fresh pet of our realm makes it one, and it stays out of state.pet', () => {
            const { m } = withSummon();
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            expect(m.pet).toBeNull();
        });

        test('a summon reads fresh for 3.5 s: it is in its fight with nothing to show yet', () => {
            const { m, advance } = withSummon();
            expect(m.freshSummons()).toEqual([SPIRIT]);
            advance(3499);
            expect(m.freshSummons()).toEqual([SPIRIT]);
            advance(1);
            expect(m.freshSummons()).toEqual([]);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
        });

        test('a minion never does: it stands by its commander', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, SPIRIT, 10151)); // Summon Bone Dart
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            expect(m.freshSummons()).toEqual([]);
        });

        test('within 2 s of the entry\'s first appearing, and a 0xDA re-create doesn\'t freshen it', () => {
            let now = 100_000;
            const m = new WorldModel({}, () => now);
            m.self.objectId = SELF;
            m.self.realm = 1;
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            now += 2000;
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            now += 1;
            m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
            expect(m.summons.size).toBe(0);

            m.handle(ServerOp.NPCCreate, npcCreate(611, 'ice spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            now += 2000;
            m.handle(ServerOp.SpellEffectAnimation, summoned(611));
            expect([...m.summons.keys()]).toEqual([611]);
        });

        test('not a mob, not an enemy\'s pet, not the window pet, not somebody else\'s cast', () => {
            const { m } = withPet();
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, MOB));
            m.handle(ServerOp.NPCCreate, npcCreate(620, 'enemy pet', ME.x + 60, ME.y, { pet: true, realm: 2 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(620));
            m.handle(ServerOp.SpellEffectAnimation, summoned(PET));
            m.handle(ServerOp.NPCCreate, npcCreate(621, 'their pet', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(301, 621, 101));
            m.handle(ServerOp.SpellEffectAnimation, summoned(999)); // no entry
            expect(m.summons.size).toBe(0);
        });

        test('only a summon\'s own effect counts: a group heal or a buff of ours on a groupmate\'s fresh pet is none (HealSpellHandler.cs:58, SpellHandler.cs:1747-1850)', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(621, 'their pet', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, 621, 1321)); // Angelic Commendation
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, 621, 1)); // Amethyst Shield
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, 621, 0));
            expect(m.summons.size).toBe(0);
            m.handle(ServerOp.SpellEffectAnimation, summoned(621));
            expect([...m.summons.keys()]).toEqual([621]);
        });

        test('a window that opens on one takes it over', () => {
            const { m } = withSummon();
            m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], SPIRIT));
            expect(m.summons.size).toBe(0);
            expect(m.pet).toMatchObject({ objectId: SPIRIT });
        });

        test('a Bonedancer: minions next to the window pet', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            expect(m.pet).toMatchObject({ objectId: PET });
        });

        test('gone by 0xA2 type 0, by a region change, and by a 0xDA that isn\'t a pet: ids get reused', () => {
            const dead = withSummon();
            dead.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
            expect(dead.m.summons.size).toBe(0);

            const left = withSummon();
            left.m.clearWorld();
            expect(left.m.summons.size).toBe(0);

            const reused = withSummon();
            reused.m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'zombie farmer', ME.x + 60, ME.y));
            expect(reused.m.summons.size).toBe(0);
        });

        test('a minion goes when the window closes, whatever closed it: it goes with its commander, its 0xA2 only to those in view (SummonCommanderPet.cs:25-38)', () => {
            const minion = (m: WorldModel) => {
                m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, SPIRIT, 10151)); // Summon Bone Dart
                expect([...m.summons.keys()]).toEqual([SPIRIT]);
            };
            const closed = withPet();
            minion(closed.m);
            closed.m.cull(elsewhere); // out of view: no 0xA2 will come
            closed.m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(closed.m.summons.size).toBe(0);

            const died = withPet();
            minion(died.m);
            died.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(died.m.summons.size).toBe(0);

            const ownerDied = withPet();
            minion(ownerDied.m);
            ownerDied.m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
            expect(ownerDied.m.summons.size).toBe(0);
        });

        test('a Theurgist\'s or an Animist\'s stays when a window closes: no such tie', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
        });

        test('30 s with no entry ends one: no 0xA2 reaches us from beyond view (WorldMgr.cs:60), and its id will go to somebody else', () => {
            const { m, advance } = withSummon();
            m.cull(ME);
            m.cull(elsewhere);
            expect(m.npcs.has(SPIRIT)).toBe(false);
            advance(30_000);
            m.cull(elsewhere);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            advance(1);
            m.cull(elsewhere);
            expect(m.summons.size).toBe(0);
        });

        test('an entry resets that clock: seen at the last cull counts, and one in view stays however long', () => {
            const { m, advance } = withSummon();
            advance(29_000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(SPIRIT, 0));
            m.cull(ME);
            advance(9000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(SPIRIT, 0));
            m.cull(ME);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            m.cull(elsewhere);
            advance(29_000);
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.cull(ME);
            m.cull(elsewhere);
            advance(29_000);
            m.cull(elsewhere);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
        });

        test('after that it reads as a stranger\'s when it comes back', () => {
            const { m, advance } = withSummon();
            m.cull(elsewhere);
            advance(30_001);
            m.cull(elsewhere);
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            expect(m.summons.size).toBe(0);
        });

        describe('a minion isn\'t under that rule while its window is open: it can\'t outlive its commander, and out of `summons` nothing could address it', () => {
            const dart = (m: WorldModel) => {
                m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, SPIRIT, 10151)); // Summon Bone Dart
            };

            test('out of view for long, and still ours when it comes back', () => {
                const { m, advance } = withPet();
                dart(m);
                m.cull(elsewhere);
                advance(120_000);
                m.cull(elsewhere);
                expect([...m.summons.keys()]).toEqual([SPIRIT]);
                m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.cull(ME);
                expect([...m.summons.keys()]).toEqual([SPIRIT]);
            });

            test('a 0xDA with another name still drops it, and so does a close', () => {
                const renamed = withPet();
                dart(renamed.m);
                renamed.m.cull(elsewhere);
                renamed.advance(60_000);
                renamed.m.cull(elsewhere);
                renamed.m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bandit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                expect(renamed.m.summons.size).toBe(0);

                const closed = withPet();
                dart(closed.m);
                closed.m.cull(elsewhere);
                closed.advance(60_000);
                closed.m.cull(elsewhere);
                closed.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(closed.m.summons.size).toBe(0);
            });

            test('with no window it goes by the 30 s, as any other, and so does a Theurgist\'s beside a window', () => {
                const { m, advance } = withSummon();
                m.summons.clear();
                m.npcs.delete(SPIRIT);
                dart(m);
                m.cull(elsewhere);
                advance(30_001);
                m.cull(elsewhere);
                expect(m.summons.size).toBe(0);

                const beside = withPet();
                beside.m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                beside.m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
                beside.m.cull(elsewhere);
                beside.advance(30_001);
                beside.m.cull(elsewhere);
                expect(beside.m.summons.size).toBe(0);
            });
        });

        test('a 0xDA with another name under its id is somebody else: ids get reused; the same name is the same pet', () => {
            const { m } = withSummon();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'ruby simulacrum', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            expect(m.summons.size).toBe(0);
        });

        test('kept through a cull, a jump, a 0xDA that is still a pet, and our death', () => {
            const { m } = withSummon();
            m.cull(elsewhere);
            expect(m.npcs.has(SPIRIT)).toBe(false);
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.RemoveObject, remove(SPIRIT, 1));
            m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
            expect([...m.summons.keys()]).toEqual([SPIRIT]);
        });

        test('its 0xBC counts as ours, either way round, and the mob on it reads as on it', () => {
            const swinging = withSummon();
            swinging.m.handle(ServerOp.CombatAnimation, combatAnimation(SPIRIT, MOB, 90));
            expect(swinging.m.inCombat()).toBe(true);
            swinging.advance(8000);
            expect(swinging.m.inCombat()).toBe(false);

            const hit = withSummon();
            hurt(hit.m);
            hit.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            expect(hit.m.inCombat()).toBe(true);
            expect(hit.m.nearbyNpcs(ME).find(n => n.objectId === MOB)).toMatchObject({ targetObjectId: SPIRIT, inCombat: true });
            hit.advance(8000);
            expect(hit.m.inCombat()).toBe(true); // that mob still reads as on it
            hit.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
            expect(hit.m.inCombat()).toBe(true); // and with it gone, on us
            hit.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(hit.m.inCombat()).toBe(false);
        });

        test('its 0x1B counts like the window pet\'s: at an enemy yes, at us, itself or a friend no; and a mob\'s on it yes', () => {
            const { m, advance } = withSummon();
            m.handle(ServerOp.NPCCreate, npcCreate(611, 'other spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SPIRIT, SELF));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SPIRIT, SPIRIT));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SPIRIT, 611));
            expect(m.inCombat()).toBe(false);
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SPIRIT, MOB));
            expect(m.inCombat()).toBe(true);
            advance(8000);
            expect(m.inCombat()).toBe(false);
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SPIRIT));
            expect(m.inCombat()).toBe(true);
        });
    });

    describe('our own harmless cast is no combat', () => {
        test('on us, the pet, a summon or a friendly it is none', () => {
            const { m } = withPet();
            m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
            m.handle(ServerOp.NPCCreate, npcCreate(610, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(610)); // its summon
            expect(m.summons.has(610)).toBe(true);
            for (const target of [SELF, PET, 610, 301]) m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, target));
            expect(m.self.lastCombatAt).toBe(0);
            expect(m.inCombat()).toBe(false);
        });

        test('a charm is none, landed or resisted: its first 0x1B comes before the mob is ours, and the server doesn\'t count it as harm (CharmSpellHandler.cs:426, :430, Spell.cs:301-306)', () => {
            const charm = (target: number) => spellEffect(SELF, target, 951); // Persuade Will
            const owner = () => {
                const m = new WorldModel({}, () => 100_000);
                m.self.objectId = SELF;
                m.self.realm = 1;
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
                return m;
            };
            const landed = owner();
            landed.handle(ServerOp.SpellEffectAnimation, charm(MOB));
            expect(landed.inCombat()).toBe(false);
            landed.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], MOB));
            landed.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y, { pet: true, realm: 1 }));
            landed.handle(ServerOp.SpellEffectAnimation, charm(MOB)); // CharmECSEffect.cs:42
            expect(landed.self.lastCombatAt).toBe(0);
            expect(landed.inCombat()).toBe(false);
            expect(landed.summons.size).toBe(0);

            const resisted = owner();
            resisted.handle(ServerOp.SpellEffectAnimation, charm(MOB));
            expect(resisted.self.lastCombatAt).toBe(0);
            // What the mob does next is a fight like any other.
            resisted.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            expect(resisted.inCombat()).toBe(true);
        });

        test('on an enemy or at nothing named it counts, as ever, and so does a mob\'s on us', () => {
            const at = (target: number, caster = SELF) => {
                const { m } = withPet();
                m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(caster, target));
                return m.inCombat();
            };
            expect(at(MOB)).toBe(true);
            expect(at(999)).toBe(true);
            expect(at(0)).toBe(true);
            expect(at(SELF, MOB)).toBe(true);
        });
    });

    describe('a friend\'s cast isn\'t combat: the server\'s InCombat comes from combat ticks (GameLiving.cs:225-227)', () => {
        const castOn = (caster: number, target: number) => {
            const { m } = withPet();
            m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
            m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
            m.handle(ServerOp.NPCCreate, npcCreate(612, 'their pet', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(caster, target));
            return m.inCombat();
        };

        test('a friendly player\'s or pet\'s buff, heal or revive on us or our pet is none', () => {
            for (const target of [SELF, PET]) {
                expect(castOn(301, target)).toBe(false);
                expect(castOn(612, target)).toBe(false);
            }
        });

        test('an enemy player, a mob, and a caster out of view all count: one we can\'t place stays combat', () => {
            for (const target of [SELF, PET]) {
                expect(castOn(302, target)).toBe(true);
                expect(castOn(MOB, target)).toBe(true);
                expect(castOn(999, target)).toBe(true);
                expect(castOn(0, target)).toBe(true);
            }
        });
    });

    describe('a mob on the move keeps its known target', () => {
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;

        test('us, for 5 s after it was last named, through 0xFFFF', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
            advance(5000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBe(SELF);
            advance(1);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBeNull();
            expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.inCombat).toBe(true);
        });

        test('a swing renews it, also one on the pet or a summon', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(610, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(610));
            for (const victim of [SELF, PET, 610]) {
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, victim, 90));
                advance(4000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBe(victim);
                advance(1001);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBeNull();
            }
        });

        test('0 clears it at once', () => {
            const { m } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBeNull();
        });

        test('any other target reads as before: 0xFFFF replaces it', () => {
            const { m } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            expect(targetOf(m)).toBe(999);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBeNull();
        });

        test('the hold survives a 0xDA re-create, and with the pet it was on gone it goes on, on us', () => {
            const { m } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBe(SELF);

            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET, 90));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBe(SELF);
        });
    });

    describe('a dead id can\'t come back: an 0xA1 built before the death lands after it, its queue drained after TCP (PacketProcessor.cs:273-274)', () => {
        const entry = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!;

        test('the pet\'s own 0xA1 naming it reads 0: no aim, and its entry reads no fight', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 0));
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(m.pet!.targetObjectId).toBeNull();
            expect(entry(m, PET)).toMatchObject({ targetObjectId: null, inCombat: false });
        });

        test('it stamps no hold: a fresh aim keeps its own clock, and goes as it should', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, 501, 90));
            advance(1500);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(m.pet!.targetObjectId).toBe(501);
            advance(4501);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
            expect(m.pet!.targetObjectId).toBeNull();
        });

        test('another NPC\'s too, and a player\'s death by 0xAE counts the same', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(501, MOB));
            expect(entry(m, 501)).toMatchObject({ targetObjectId: null, inCombat: false });

            m.handle(ServerOp.PlayerCreate172, playerCreate(302, 10, 'Norseman', 2));
            m.handle(ServerOp.PlayerDeath, W().u16(302).u16(PET).fill(0, 4).toBytes());
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 302));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(501, 302));
            expect(m.pet!.targetObjectId).toBeNull();
            expect(entry(m, 501).targetObjectId).toBeNull();
        });

        test('for 2000 ms: after that a named id counts again', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            advance(2000);
            expect(m.diedRecently(MOB)).toBe(true);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(m.pet!.targetObjectId).toBeNull();
            advance(1);
            expect(m.diedRecently(MOB)).toBe(false);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(m.pet!.targetObjectId).toBe(MOB);
        });

        test('a 0xDA under that id ends it at once: the server hands the id on (Region.cs:955, :779)', () => {
            const { m } = withPet();
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'earth spirit', ME.x + 100, ME.y));
            expect(m.diedRecently(MOB)).toBe(false);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(m.pet!.targetObjectId).toBe(MOB);
        });

        test('a real target out of our view still counts, and so does a jump: having no entry is not being dead', () => {
            const { m } = withPet();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 999));
            expect(m.pet!.targetObjectId).toBe(999);
            expect(entry(m, PET).targetObjectId).toBe(999);

            const jumped = withPet();
            jumped.m.handle(ServerOp.RemoveObject, remove(MOB, 1));
            expect(jumped.m.diedRecently(MOB)).toBe(false);
            jumped.m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
            expect(jumped.m.pet!.targetObjectId).toBe(MOB);
        });

        test('our own death leaves our id alone: we are still there, and 0xAE clears nobody\'s target on us', () => {
            const { m } = withPet();
            m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
            expect(m.diedRecently(SELF)).toBe(false);
        });

        test('a region change forgets them, and the map stays small', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.clearWorld();
            expect(m.diedRecently(MOB)).toBe(false);
            for (let oid = 1000; oid < 2000; oid++) {
                m.handle(ServerOp.RemoveObject, remove(oid, 0));
                advance(100);
            }
            expect((m as unknown as { deadIds: Map<number, number> }).deadIds.size).toBeLessThanOrEqual(22);
        });
    });

    describe('a lost pet\'s id is stale for 2 s: an 0xA1 built before the loss lands after it (PacketProcessor.cs:273-274), and a released charm has no 0xA2 to mark it dead', () => {
        const SPIRIT = 610;
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;
        /** A mob standing in melee with the window pet, and the release of that pet as a charm: the close, then its 0xDA as a mob. */
        const released = () => {
            const c = withPet();
            hurt(c.m);
            c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 90));
            c.m.handle(ServerOp.PetWindow, PET_CLOSE);
            c.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y));
            return c;
        };

        test('close, 0xDA, an 0xA1 naming the ex-pet, an 0xA1 reading 0xFFFF: it stays on us', () => {
            const { m } = released();
            expect(targetOf(m)).toBe(SELF);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET, 61));
            expect(targetOf(m)).toBe(SELF);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF, 61));
            expect(targetOf(m)).toBe(SELF);
            expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.healthPercent).toBe(61);
        });

        test('a later real id overrides it, and a 0 clears it, as ever', () => {
            const named = released();
            named.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            named.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            expect(targetOf(named.m)).toBe(999);

            const zero = released();
            zero.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            zero.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(zero.m)).toBeNull();
        });

        test('for 2000 ms: after that a mob naming the ex-pet is on it', () => {
            const { m, advance } = released();
            advance(2000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBe(SELF);
            advance(1);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBe(PET);
        });

        test('a mob with no hand-over naming it reads as on nobody', () => {
            const { m } = withPet();
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBeNull();
            expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.inCombat).toBe(false);
        });

        test('a summon lost to a 0xDA with no pet flag too: that one has no 0xA2 either', () => {
            let now = 100_000;
            const m = new WorldModel({}, () => now);
            m.self.objectId = SELF;
            m.self.realm = 1;
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
            hurt(m);
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'air spirit', ME.x + 60, ME.y));
            expect(m.summons.size).toBe(0);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SPIRIT));
            expect(targetOf(m)).toBe(SELF);
            now += 2001;
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SPIRIT));
            expect(targetOf(m)).toBe(SPIRIT);
        });

        test('a minion that goes with its commander too', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, SPIRIT, 10151)); // Summon Bone Dart
            hurt(m);
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SPIRIT));
            expect(targetOf(m)).toBe(SELF);
        });

        test('another name under that id is somebody else, and so is any 0xDA after its entry went: the server hands ids on (Region.cs:955, :779)', () => {
            const { m } = released();
            m.handle(ServerOp.NPCCreate, npcCreate(PET, 'earth spirit', ME.x + 50, ME.y));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBe(PET);

            const gone = withPet();
            gone.m.handle(ServerOp.PetWindow, PET_CLOSE);
            gone.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            gone.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y));
            gone.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(gone.m)).toBe(PET);
        });

        test('a window that opens on it again makes it ours again: a mob on it is on it', () => {
            const { m } = released();
            m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.PetWindow, petWindow(2));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBe(PET);
        });

        test('a region change forgets them, and the map stays small', () => {
            const lost = (m: WorldModel) => (m as unknown as { lostPetIds: Map<number, number> }).lostPetIds;
            const { m, advance } = released();
            expect(lost(m).size).toBe(1);
            m.clearWorld();
            expect(lost(m).size).toBe(0);
            for (let oid = 1000; oid < 2000; oid++) {
                m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], oid));
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                advance(100);
            }
            expect(lost(m).size).toBeLessThanOrEqual(22);
        });

        describe('an 0xA1 whose realm isn\'t the entry\'s is older than the last 0xDA: its target goes with its realm', () => {
            const entry = (m: WorldModel, oid = PET) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!;

            test('an ex-pet doesn\'t read as on its old mob: the server stopped its attack (CharmECSEffect.cs:75-78)', () => {
                const { m } = withPet();
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB));
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y));
                expect(entry(m)).toMatchObject({ targetObjectId: null, inCombat: false });
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB, 80, 1));
                expect(entry(m)).toMatchObject({ targetObjectId: null, inCombat: false, realm: 'none', healthPercent: 80 });
                // The next, of its time, counts.
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, SELF));
                expect(entry(m)).toMatchObject({ targetObjectId: SELF, inCombat: true });
            });

            describe('a pulsing charm\'s ex-pet is sent straight at us (CharmECSEffect.cs:75-82), which reads 0xFFFF all the way: Melodies and Enemy lines, Pulse 1 in spell.sql', () => {
                const MELODY = 1151;
                const PERSUADE = 951;
                const singing = (effect = MELODY, distance = 800) => {
                    const c = withPet();
                    c.m.hooks.selfPosition = () => ME;
                    c.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + distance, ME.y, { pet: true, realm: 1 }));
                    c.m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, PET, effect));
                    return c;
                };
                const freed = (c: ReturnType<typeof singing>, distance = 800) => {
                    c.m.handle(ServerOp.PetWindow, PET_CLOSE);
                    c.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + distance, ME.y));
                };

                test('it reads as on us for the length of its run, 0xDA and all, in a group too: only the server\'s own StartAttack is at work here', () => {
                    const c = singing();
                    freed(c);
                    expect(entry(c.m)).toMatchObject({ targetObjectId: SELF, inCombat: true, realm: 'none' });
                    expect(c.m.inCombat()).toBe(true);
                    c.advance(7000);
                    c.m.handle(ServerOp.ObjectUpdate, movingUpdate(PET, 0xFFFF, 150, 100, ME.x + 200));
                    expect(entry(c.m).targetObjectId).toBe(SELF);

                    const grouped = singing();
                    grouped.m.handle(ServerOp.VariousUpdate, W().u8(0x06).u8(2).pascal('Me').pascal('Cleric').u16(SELF).u8(20).pascal('Tank').pascal('Armsman').u16(SELF + 1).u8(20).toBytes());
                    freed(grouped);
                    expect(entry(grouped.m).targetObjectId).toBe(SELF);
                });

                test('no longer than the run: past it a 0xFFFF reads as on nobody, and a real id or a 0 overrides at once', () => {
                    const late = singing();
                    freed(late);
                    late.advance(7334);
                    late.m.handle(ServerOp.ObjectUpdate, movingUpdate(PET, 0xFFFF, 150, 100, ME.x + 800));
                    expect(entry(late.m).targetObjectId).toBeNull();

                    const other = singing();
                    freed(other);
                    other.m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 999));
                    expect(entry(other.m).targetObjectId).toBe(999);

                    const off = singing();
                    freed(off);
                    off.m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0));
                    expect(entry(off.m).targetObjectId).toBeNull();
                });

                test('an 0xA1 built before the 0xDA, in its old realm, changes nothing', () => {
                    const c = singing();
                    freed(c);
                    c.m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB, 80, 1));
                    expect(entry(c.m).targetObjectId).toBe(SELF);
                });

                test('a charm that doesn\'t pulse only stops its attack (CharmECSEffect.cs:64): nothing aims it at us', () => {
                    const c = singing(PERSUADE);
                    freed(c);
                    expect(entry(c.m)).toMatchObject({ targetObjectId: null, inCombat: false });
                });

                test('the song on another mob says nothing of this one, nor one cast before a charm that doesn\'t pulse', () => {
                    const other = singing();
                    other.m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, MOB, MELODY));
                    freed(other);
                    expect(entry(other.m).targetObjectId).toBeNull();

                    const after = singing();
                    after.m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, PET, PERSUADE));
                    freed(after);
                    expect(entry(after.m).targetObjectId).toBeNull();
                });

                test('not at our death: the server\'s rule needs us alive', () => {
                    const dead = singing();
                    dead.m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
                    expect(entry(dead.m).targetObjectId).toBeNull();
                });

                test('the song\'s next pulse takes it back (CharmSpellHandler.cs:81-82): our pet again, it isn\'t on us', () => {
                    const c = singing();
                    freed(c);
                    c.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 800, ME.y, { pet: true, realm: 1 }));
                    c.m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], PET));
                    expect(c.m.pet).toMatchObject({ objectId: PET });
                    expect(entry(c.m).targetObjectId).toBeNull();
                    expect(c.m.inCombat()).toBe(false);
                });
            });

            test('a mob just charmed doesn\'t read as our pet on us: no aim, and no entry on us', () => {
                const { m } = withPet();
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], MOB));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF, 90, 0));
                expect(m.pet).toMatchObject({ objectId: MOB, targetObjectId: null });
                expect(entry(m, MOB)).toMatchObject({ targetObjectId: null, healthPercent: 90 });
                expect(m.inCombat()).toBe(false);
            });

            test('a pet with no entry has nothing to compare with: its 0xA1 counts', () => {
                const { m } = withPet();
                m.handle(ServerOp.RemoveObject, remove(PET, 1));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, MOB, 100, 0));
                expect(m.pet!.targetObjectId).toBe(MOB);
            });
        });
    });

    test('realm comes from 0xDA alone: an 0xA1 built while it was still ours lands after a release\'s 0xDA (PlayerTargetHandler.cs:56, GameNPC.cs:303-305, CharmECSEffect.cs:104-113)', () => {
        const { m } = withPet();
        m.handle(ServerOp.PetWindow, PET_CLOSE);
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y));
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0, 100, 1));
        expect(m.nearbyNpcs(ME).find(n => n.objectId === PET)).toMatchObject({ realm: 'none', isPet: false });
        m.handle(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
        m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 0, 100, 0));
        expect(m.nearbyNpcs(ME).find(n => n.objectId === PET)).toMatchObject({ realm: 'albion', isPet: true });
    });

    describe('losing a pet hands its mobs to us: the server re-aims them (StandardMobBrain.cs:569, CharmECSEffect.cs:87-95), and they come naming nobody', () => {
        const SPIRIT = 610;
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;
        const summonAt = (m: WorldModel, x = ME.x + 60, oid = SPIRIT, effect = 101) => {
            m.handle(ServerOp.NPCCreate, npcCreate(oid, 'air spirit', x, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, oid, effect));
        };
        /** A model with a mob on the window pet, by a swing. */
        const mobOnPet = () => {
            const c = withPet();
            hurt(c.m);
            c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 90));
            expect(targetOf(c.m)).toBe(PET);
            return c;
        };
        /** No window: a mob on one summon. */
        const mobOnSummon = (x = ME.x + 60) => {
            let now = 100_000;
            const m = new WorldModel({}, () => now);
            m.self.objectId = SELF;
            m.self.realm = 1;
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            summonAt(m, x);
            hurt(m);
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            return { m, advance: (ms: number) => { now += ms; } };
        };

        test('at its death: on us at once, and the chase hold keeps it through 0xFFFF for 5 s', () => {
            const { m, advance } = mobOnPet();
            advance(9000); // the hold counts from the loss, not from the last swing
            m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(targetOf(m)).toBe(SELF);
            advance(5000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBe(SELF);
            advance(1);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBeNull();
        });

        test('at a release: the close, then its 0xA2 changes nothing', () => {
            const { m } = mobOnPet();
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(targetOf(m)).toBe(SELF);
            m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(targetOf(m)).toBe(SELF);
        });

        test('a summon\'s death too', () => {
            const { m } = mobOnSummon();
            m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
            expect(targetOf(m)).toBe(SELF);
            expect(m.inCombat()).toBe(true);
        });

        test('a summon that gives up its id to something else too: it has gone', () => {
            const { m } = mobOnSummon();
            m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'zombie farmer', ME.x + 60, ME.y));
            expect(m.summons.size).toBe(0);
            expect(targetOf(m)).toBe(SELF);
        });

        test('a 0 in its 0xA1 clears it as ever, and a real id overrides it at once', () => {
            const reads0 = mobOnPet();
            reads0.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            reads0.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(reads0.m)).toBeNull();

            const named = mobOnPet();
            named.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            named.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            expect(targetOf(named.m)).toBe(999);
        });

        test('a late 0xA1 still naming the dead pet doesn\'t undo it: it is older than the loss', () => {
            const { m } = mobOnPet();
            m.handle(ServerOp.RemoveObject, remove(PET, 0));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
            expect(targetOf(m)).toBe(SELF);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            expect(targetOf(m)).toBe(SELF);
        });

        test('another pet of ours within 600 of the mob keeps it unassigned, and its next 0xBC or 0xA1 decides', () => {
            const window = mobOnPet();
            summonAt(window.m);
            window.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(targetOf(window.m)).toBeNull();
            window.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            expect(targetOf(window.m)).toBe(SPIRIT);

            const closed = mobOnPet();
            summonAt(closed.m);
            closed.m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(targetOf(closed.m)).toBeNull();
            closed.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
            expect(targetOf(closed.m)).toBe(SELF);

            const summon = mobOnSummon();
            summonAt(summon.m, ME.x + 700, 611); // 600 from the mob: near
            summon.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
            expect(targetOf(summon.m)).toBeNull();
        });

        test('one further than 600 doesn\'t, nor one out of view, and the lost pet\'s own entry counts for nothing', () => {
            const far = mobOnPet();
            summonAt(far.m, ME.x + 701);
            far.m.handle(ServerOp.PetWindow, PET_CLOSE); // the entry stays until its 0xA2
            expect(targetOf(far.m)).toBe(SELF);

            const gone = mobOnPet();
            summonAt(gone.m);
            gone.m.npcs.delete(SPIRIT);
            gone.m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(targetOf(gone.m)).toBe(SELF);
        });

        test('not at a region change, nor at our own death: the window goes with us (GamePlayer.cs:5988-5989)', () => {
            const { m } = mobOnPet();
            m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
            expect(targetOf(m)).toBe(PET);
            m.handle(ServerOp.RemoveObject, remove(PET, 0));
            expect(targetOf(m)).toBeNull();

            const left = mobOnPet();
            left.m.clearWorld();
            expect(left.m.lastPetLoss).toMatchObject({ cause: 'region_change' });
            expect(left.m.npcs.size).toBe(0);
        });

        test('nor when a summon ends while we lie dead: FnFs outlive us', () => {
            const { m } = mobOnSummon();
            m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
            m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
            expect(targetOf(m)).toBeNull();
        });

        test('only the mobs on it, and no friend: a mob on anybody else keeps its target', () => {
            const { m } = mobOnPet();
            m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(501, 999));
            m.handle(ServerOp.NPCCreate, npcCreate(612, 'their pet', ME.x + 100, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(612, PET));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(targetOf(m, 501)).toBe(999);
            expect(targetOf(m, 612)).toBe(PET);
        });

        describe('only with nobody else it can turn to: the server re-aims by threat (StandardMobBrain.cs:1363-1400), and the model can\'t see the table', () => {
            /** 0x16 sub 0x06 (PacketLib1125.cs:387-411): the group's members, us among them; a bare 06 00 with no group. */
            const groupWindow = (...names: string[]) => {
                const w = W().u8(0x06).u8(names.length);
                names.forEach((name, i) => w.pascal(name).pascal('Cleric').u16(SELF + i).u8(20));
                return w.toBytes();
            };
            const grouped = <T extends { m: WorldModel }>(c: T): T => {
                c.m.handle(ServerOp.VariousUpdate, groupWindow('Me', 'Tank'));
                return c;
            };

            test('in a group a mob may go to a groupmate with more threat, so it stays unassigned: at a death, a close, and a summon\'s end', () => {
                const died = grouped(mobOnPet());
                died.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                expect(targetOf(died.m)).toBeNull();

                const closed = grouped(mobOnPet());
                closed.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(closed.m)).toBeNull();

                const summon = grouped(mobOnSummon());
                summon.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
                expect(targetOf(summon.m)).toBeNull();
            });

            test('lastPetLoss.targetedBy still has it: its entry can\'t say any more', () => {
                for (const lose of [(m: WorldModel) => m.handle(ServerOp.RemoveObject, remove(PET, 0)), (m: WorldModel) => m.handle(ServerOp.PetWindow, PET_CLOSE)]) {
                    const { m } = grouped(mobOnPet());
                    lose(m);
                    expect(targetOf(m)).toBeNull();
                    expect(m.lastPetLoss!.targetedBy).toEqual([MOB]);
                }
            });

            test('its next swing or 0xA1 says who: us as well', () => {
                const swing = grouped(mobOnPet());
                swing.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                swing.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
                expect(targetOf(swing.m)).toBe(SELF);

                const named = grouped(mobOnPet());
                named.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                named.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF + 1));
                expect(targetOf(named.m)).toBe(SELF + 1);
            });

            test('a group we have left, or one of only us, is no group', () => {
                const left = grouped(mobOnPet());
                left.m.handle(ServerOp.VariousUpdate, groupWindow());
                left.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                expect(targetOf(left.m)).toBe(SELF);

                const alone = mobOnPet();
                alone.m.handle(ServerOp.VariousUpdate, groupWindow('Me'));
                alone.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                expect(targetOf(alone.m)).toBe(SELF);
            });

            /** A minion's Owner is the commander, who gets the threat of its hits (SummonMinionHandler.cs:147-149, StandardMobBrain.cs:569-570). */
            const mobOnMinion = (commanderX = ME.x + 50) => {
                const c = withPet();
                c.m.handle(ServerOp.NPCCreate, npcCreate(PET, 'bone commander', commanderX, ME.y, { pet: true, realm: 1 }));
                summonAt(c.m, ME.x + 60, SPIRIT, 10151); // Summon Bone Dart
                c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
                return c;
            };

            test('a minion\'s mob goes for its commander while that lives, however far from it', () => {
                const near = mobOnMinion();
                near.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
                expect(targetOf(near.m)).toBeNull();

                const far = mobOnMinion(ME.x + 2000);
                far.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
                expect(targetOf(far.m)).toBeNull();

                const unseen = mobOnMinion();
                unseen.m.npcs.delete(PET);
                unseen.m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
                expect(targetOf(unseen.m)).toBeNull();
            });

            test('another summon of ours has its Owner in us: its mob comes for us with a window pet far away', () => {
                const { m } = mobOnMinion(ME.x + 2000);
                m.handle(ServerOp.NPCCreate, npcCreate(611, 'air spirit', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(SELF, 611, 101));
                m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0)); // the minion's mob goes to the commander...
                hurt(m);
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, 611, 90));
                m.npcs.delete(SPIRIT);
                m.handle(ServerOp.RemoveObject, remove(611, 0)); // ...and this one's to us
                expect(targetOf(m)).toBe(SELF);
            });
        });

        test('a mob on a minion when its commander goes: the two go together', () => {
            const { m } = withPet();
            summonAt(m, ME.x + 60, SPIRIT, 10151); // Summon Bone Dart
            hurt(m);
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SPIRIT, 90));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(m.summons.size).toBe(0);
            expect(targetOf(m)).toBe(SELF);
        });

        describe('lastPetLoss.targetedBy: the mobs on it when it went', () => {
            test('one handed over to us as well, by its id', () => {
                const { m } = mobOnPet();
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBe(SELF);
                expect(m.lastPetLoss!.targetedBy).toEqual([MOB]);
            });

            test('beside another pet of ours, where it stays unassigned', () => {
                const { m } = mobOnPet();
                summonAt(m);
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBeNull();
                expect(m.lastPetLoss!.targetedBy).toEqual([MOB]);
            });

            test('every one of them; not one on somebody else, and absent with none', () => {
                const c = mobOnPet();
                c.m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
                c.m.handle(ServerOp.CombatAnimation, combatAnimation(501, PET, 80));
                c.m.handle(ServerOp.NPCCreate, npcCreate(502, 'bear', ME.x + 100, ME.y));
                c.m.handle(ServerOp.ObjectUpdate, objectUpdate(502, 999));
                c.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(c.m.lastPetLoss!.targetedBy).toEqual([MOB, 501]);

                const none = withPet();
                none.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(none.m.lastPetLoss).not.toHaveProperty('targetedBy');
            });
        });

        describe('the hold fits its run: a pet fights up to 2000 from us (GamePlayer.cs:12185), and 0xA1 reads 0xFFFF all the way (PacketLib168.cs:820-828)', () => {
            /** A mob this far from us on the window pet, in a model that knows where we stand. */
            const mobOnPetAt = (distance: number) => {
                const c = withPet();
                c.m.hooks.selfPosition = () => ME;
                c.m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + distance, ME.y));
                hurt(c.m);
                c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 90));
                return c;
            };

            test('distance / 150 units/s + 2 s, through every 0xFFFF on the way, and no longer', () => {
                for (const [distance, hold] of [[1050, 9000], [1500, 12_000], [1800, 14_000]] as const) {
                    const { m, advance } = mobOnPetAt(distance);
                    m.handle(ServerOp.RemoveObject, remove(PET, 0));
                    expect(targetOf(m)).toBe(SELF);
                    advance(5001);
                    m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                    expect(targetOf(m)).toBe(SELF);
                    advance(hold - 5001);
                    m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                    expect(targetOf(m)).toBe(SELF);
                    advance(1);
                    m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                    expect(targetOf(m)).toBeNull();
                }
            });

            test('never under the 5 s of any chase, and never over 30 s', () => {
                const near = mobOnPetAt(300); // 4 s by its run
                near.m.handle(ServerOp.PetWindow, PET_CLOSE);
                near.advance(5000);
                near.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(near.m)).toBe(SELF);
                near.advance(1);
                near.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(near.m)).toBeNull();

                const far = mobOnPetAt(5400); // 38 s by its run
                far.m.handle(ServerOp.PetWindow, PET_CLOSE);
                far.advance(30_000);
                far.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(far.m)).toBe(SELF);
                far.advance(1);
                far.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(far.m)).toBeNull();
            });

            test('with no word of where we stand it is the 5 s', () => {
                const { m, advance } = mobOnPetAt(1800);
                delete m.hooks.selfPosition;
                m.handle(ServerOp.RemoveObject, remove(PET, 0));
                advance(5001);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBeNull();
            });

            test('a 0 clears it at once, a real id overrides it at once, and its run is over with them', () => {
                const reads0 = mobOnPetAt(1800);
                reads0.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                reads0.advance(6000);
                reads0.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(targetOf(reads0.m)).toBeNull();
                reads0.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
                reads0.advance(5001);
                reads0.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(reads0.m)).toBeNull();

                const named = mobOnPetAt(1800);
                named.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                named.advance(6000);
                named.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
                expect(targetOf(named.m)).toBe(999);

                const onUs = mobOnPetAt(1800);
                onUs.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                onUs.advance(1000);
                onUs.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
                onUs.advance(5001);
                onUs.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(onUs.m)).toBeNull();
            });

            test('a late 0xA1 naming the lost pet leaves its run as it was', () => {
                const { m, advance } = mobOnPetAt(1800);
                m.handle(ServerOp.RemoveObject, remove(PET, 0));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET));
                advance(14_000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBe(SELF);
            });

            test('it survives a 0xDA re-create', () => {
                const { m, advance } = mobOnPetAt(1800);
                m.handle(ServerOp.RemoveObject, remove(PET, 0));
                advance(6000);
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 900, ME.y));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBe(SELF);
            });

            test('a summon\'s mob too', () => {
                const { m, advance } = mobOnSummon();
                m.hooks.selfPosition = () => ME;
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 1800, ME.y));
                m.handle(ServerOp.RemoveObject, remove(SPIRIT, 0));
                advance(14_000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
                expect(targetOf(m)).toBe(SELF);
            });
        });

        describe('the pet\'s own target goes with them: on its first run-in it was never named (PacketLib168.cs:820-828), but the model holds who the pet is on', () => {
            /** The window pet aimed at the mob, the mob reading this. */
            const aimedAt = (target: number, opts: { health?: number; speed?: number } = {}) => {
                const c = withPet();
                c.m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB));
                c.m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, target, opts.speed ?? 0, opts.health ?? 100));
                expect(c.m.pet!.targetObjectId).toBe(MOB);
                return c;
            };

            test('reading 0xFFFF and moving, or either and hurt: on us, at a close and at its death', () => {
                for (const [target, opts] of [
                    [0xFFFF, { speed: 150 }],
                    [0xFFFF, { health: 76 }],
                    [0, { health: 76 }],
                ] as const) {
                    const closed = aimedAt(target, opts);
                    closed.m.handle(ServerOp.PetWindow, PET_CLOSE);
                    expect(targetOf(closed.m)).toBe(SELF);

                    const died = aimedAt(target, opts);
                    died.m.handle(ServerOp.RemoveObject, remove(PET, 0));
                    expect(targetOf(died.m)).toBe(SELF);
                }
            });

            test('its hold fits the run like any other', () => {
                const { m, advance } = withPet();
                m.hooks.selfPosition = () => ME;
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB));
                m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 150, 100, ME.x + 1800));
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                advance(14_000);
                m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 150, 100, ME.x + 1800));
                expect(targetOf(m)).toBe(SELF);
                advance(1);
                m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 150, 100, ME.x + 1800));
                expect(targetOf(m)).toBeNull();
            });

            test('not one reading 0 at full health on the move: that is no attack (PacketLib168.cs:820-828), a roam or a walk home at speed 70 (StandardMobState.cs:155-178), and a real run-in reads 0xFFFF', () => {
                for (const speed of [70, 150]) {
                    const { m } = aimedAt(0, { speed });
                    m.handle(ServerOp.PetWindow, PET_CLOSE);
                    expect(targetOf(m)).toBeNull();
                    expect(m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.inCombat).toBe(false);
                }
            });

            test('not one standing at full health: nothing says it has noticed', () => {
                for (const target of [0xFFFF, 0]) {
                    const { m } = aimedAt(target);
                    m.handle(ServerOp.PetWindow, PET_CLOSE);
                    expect(targetOf(m)).toBeNull();
                }
            });

            test('not one that names somebody else, nor anybody but the pet\'s target', () => {
                const { m } = aimedAt(999, { health: 76, speed: 150 });
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBe(999);

                const other = withPet();
                other.m.handle(ServerOp.NPCCreate, npcCreate(501, 'bat', ME.x + 100, ME.y));
                other.m.handle(ServerOp.ObjectUpdate, movingUpdate(501, 0xFFFF, 150, 76));
                other.m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB));
                other.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(other.m, 501)).toBeNull();
            });

            test('the group and other-pet rules hold: it stays as it read', () => {
                const inCombat = (m: WorldModel) => m.nearbyNpcs(ME).find(n => n.objectId === MOB)!.inCombat;
                const beside = aimedAt(0xFFFF, { speed: 150 });
                summonAt(beside.m);
                beside.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(beside.m)).toBeNull();
                expect(inCombat(beside.m)).toBe(true);

                const grouped = aimedAt(0xFFFF, { speed: 150 });
                grouped.m.handle(ServerOp.VariousUpdate, W().u8(0x06).u8(2).pascal('Me').pascal('Cleric').u16(SELF).u8(20).pascal('Tank').pascal('Armsman').u16(SELF + 1).u8(20).toBytes());
                grouped.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(grouped.m)).toBeNull();
                expect(inCombat(grouped.m)).toBe(true);
            });

            test('not at our death, and nothing with the mob out of view', () => {
                const dead = aimedAt(0xFFFF, { speed: 150 });
                dead.m.handle(ServerOp.PlayerDeath, W().u16(SELF).u16(MOB).fill(0, 4).toBytes());
                expect(targetOf(dead.m)).toBeNull();

                const unseen = aimedAt(0xFFFF, { speed: 150 });
                unseen.m.npcs.delete(MOB);
                unseen.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(unseen.m.decodeErrors).toBe(0);
                expect(unseen.m.lastPetLoss).toMatchObject({ objectId: PET });
            });

            test('not a friend, and not a mob it isn\'t after any more', () => {
                const friend = withPet();
                friend.m.handle(ServerOp.NPCCreate, npcCreate(612, 'their pet', ME.x + 100, ME.y, { pet: true, realm: 1 }));
                friend.m.handle(ServerOp.ObjectUpdate, objectUpdate(PET, 612));
                friend.m.handle(ServerOp.ObjectUpdate, movingUpdate(612, 0xFFFF, 150));
                friend.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(friend.m, 612)).toBeNull();

                const off = aimedAt(0xFFFF, { speed: 150 });
                off.m.handle(ServerOp.Message, line('You command the wolf to follow you!'));
                off.m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(off.m)).toBeNull();
            });
        });
    });

    describe('a caster mob reads 0 between casts (PacketLib168.cs:820): its 0x1B says who it is on', () => {
        const SPIRIT = 610;
        const entry = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!;

        test('at us, the window pet or a summon: named at once, and a 0 clears it only after 6 s', () => {
            for (const victim of [SELF, PET, SPIRIT]) {
                const { m, advance } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, victim));
                expect(entry(m).targetObjectId).toBe(victim);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBe(victim);
                advance(6000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBe(victim);
                advance(1);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBeNull();
            }
        });

        test('its first cast holds from the start, before any 0x1B: a mob on us, the pet or a summon, and for 6 s', () => {
            for (const victim of [SELF, PET, SPIRIT]) {
                const { m, advance } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(SPIRIT, 'bone dart', ME.x + 60, ME.y, { pet: true, realm: 1 }));
                m.handle(ServerOp.SpellEffectAnimation, summoned(SPIRIT));
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, victim, 90));
                advance(5000);
                m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBe(victim);
                advance(6000);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBe(victim);
                advance(1);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                expect(entry(m).targetObjectId).toBeNull();
            }
        });

        test('a cast renews that only while the mob was named of late: one gone on to somebody else clears, however long it goes on casting at them', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            const cycle = () => {
                advance(3500);
                m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, 999));
            };
            cycle();
            cycle();
            expect(entry(m).targetObjectId).toBe(SELF);
            cycle();
            expect(entry(m).targetObjectId).toBeNull();
            for (let i = 0; i < 5; i++) cycle();
            expect(entry(m).targetObjectId).toBeNull();
            expect(entry(m).inCombat).toBe(false);
        });

        test('a cast on us each time goes on reading so, by each 0x1B', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            for (let i = 0; i < 8; i++) {
                advance(3500);
                m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
                m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SELF));
                expect(entry(m).targetObjectId).toBe(SELF);
            }
        });

        test('a cast names nobody: a mob on nobody, or on anybody else, clears as ever', () => {
            const none = withPet();
            none.m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(entry(none.m).targetObjectId).toBeNull();
            none.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(none.m).targetObjectId).toBeNull();

            const other = withPet();
            other.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            other.m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            other.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(other.m).targetObjectId).toBeNull();

            // That cast was at somebody else: its swing on us, a moment later, is one like any other.
            other.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            other.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(other.m).targetObjectId).toBeNull();
        });

        test('a real id in its 0xA1 overrides that at once too', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            expect(entry(m).targetObjectId).toBe(999);
        });

        test('its next cast renews that', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SELF));
            advance(5000);
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SELF));
            advance(5000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(m).targetObjectId).toBe(SELF);
        });

        test('a real id in its 0xA1 overrides it at once, and a 0 then clears as ever', () => {
            const { m } = withPet();
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, PET));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            expect(entry(m).targetObjectId).toBe(999);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(m).targetObjectId).toBeNull();
        });

        test('a mob that only ever swung clears at once, as before', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 90));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(m).targetObjectId).toBeNull();
        });

        test('the hold survives a 0xDA re-create', () => {
            const { m } = withPet();
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, SELF));
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(entry(m).targetObjectId).toBe(SELF);
        });

        test('no peace flag: a realm-0 Hastener\'s 0x1B at us as we talk to it is no attacker and no fight (Hastener.cs:28-29, AbstractServerRules.cs:380-384)', () => {
            for (const victim of [SELF, PET]) {
                const { m, advance } = withPet();
                m.handle(ServerOp.NPCCreate, npcCreate(613, 'Hastener', ME.x + 60, ME.y, { peace: true }));
                m.handle(ServerOp.SpellEffectAnimation, spellEffect(613, victim));
                expect(entry(m, 613).targetObjectId).toBeNull();
                expect(m.inCombat()).toBe(false);
                advance(10);
                m.handle(ServerOp.ObjectUpdate, objectUpdate(613, 0));
                expect(entry(m, 613).targetObjectId).toBeNull();
            }
        });

        test('no friendly caster, and no cast at anybody else', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(612, 'their pet', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(612, SELF));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(612, PET));
            expect(entry(m, 612).targetObjectId).toBeNull();
            m.handle(ServerOp.PlayerCreate172, playerCreate(301, 9, 'Ally', 1));
            m.handle(ServerOp.SpellEffectAnimation, spellEffect(MOB, 301));
            expect(entry(m).targetObjectId).toBeNull();
        });
    });

    describe('the answer line names what we ordered', () => {
        const OTHER = 501;
        const ordered = () => {
            const c = withPet();
            c.m.handle(ServerOp.NPCCreate, npcCreate(OTHER, 'bat', ME.x + 100, ME.y));
            c.m.notePetAttack(MOB);
            c.m.setSelfTarget(OTHER); // a melee fight moved our target back before the line came
            return c;
        };

        test('the ordered id, before our current target', () => {
            const { m } = ordered();
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBe(MOB);
        });

        test('forgotten after the line: the next one goes by our target', () => {
            const { m } = ordered();
            m.handle(ServerOp.Message, line(KILL));
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBe(OTHER);
        });

        test('forgotten after 3 s', () => {
            const { m, advance } = ordered();
            advance(3000);
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBe(MOB);

            const late = ordered();
            late.advance(3001);
            late.m.handle(ServerOp.Message, line(KILL));
            expect(late.m.pet!.targetObjectId).toBe(OTHER);
        });

        test('one that has just died is aimed at by nothing', () => {
            const { m } = ordered();
            m.handle(ServerOp.RemoveObject, remove(MOB, 0));
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBeNull();
        });

        test('another line doesn\'t use it up, and a region change forgets it', () => {
            const { m } = ordered();
            m.handle(ServerOp.Message, line('You command the wolf to defend you!'));
            m.handle(ServerOp.Message, line(KILL));
            expect(m.pet!.targetObjectId).toBe(MOB);

            const left = ordered();
            left.m.clearWorld();
            left.m.handle(ServerOp.PetWindow, petWindow(2));
            left.m.setSelfTarget(OTHER);
            left.m.handle(ServerOp.Message, line(KILL));
            expect(left.m.pet!.targetObjectId).toBe(OTHER);
        });
    });

    describe('PetState.name: the name its entry had', () => {
        test('from the entry at the open, and it stays through a cull', () => {
            const { m } = withPet();
            expect(m.pet!.name).toBe('wolf');
            m.cull(elsewhere);
            expect(m.npcs.has(PET)).toBe(false);
            m.handle(ServerOp.PetWindow, petWindow(1, 1));
            expect(m.pet).toMatchObject({ name: 'wolf', aggression: 'aggressive' });
        });

        test('an entry that comes after the window names it, in a new object: a snapshot may hold the old one', () => {
            const m = new WorldModel({}, () => 100_000);
            m.handle(ServerOp.PetWindow, petWindow(2));
            const before = m.pet!;
            expect('name' in before).toBe(false);
            m.handle(ServerOp.NPCCreate, npcCreate(PET, 'lynx cub', ME.x + 50, ME.y, { pet: true, realm: 1 }));
            expect(m.pet!.name).toBe('lynx cub');
            expect(before.name).toBeUndefined();
        });

        test('another NPC\'s 0xDA leaves it, a new pet has its own, and a loss still names it', () => {
            const { m } = withPet();
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
            expect(m.pet!.name).toBe('wolf');
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            m.handle(ServerOp.PetWindow, petWindow(2, 2, 1, [], 603));
            expect(m.pet!.name).toBeUndefined();
            expect(m.lastPetLoss).toMatchObject({ objectId: PET, name: 'wolf' });
        });
    });

    describe('small items', () => {
        test('a pet has no role, whatever its name says; anybody else keeps theirs', () => {
            const m = new WorldModel({}, () => 100_000);
            m.handle(ServerOp.NPCCreate, npcCreate(610, 'spirit soldier', ME.x + 60, ME.y, { pet: true, realm: 1 }));
            m.handle(ServerOp.NPCCreate, npcCreate(611, 'royal soldier', ME.x + 60, ME.y));
            expect(m.nearbyNpcs(ME).find(n => n.objectId === 610)!.role).toBeNull();
            expect(m.nearbyNpcs(ME).find(n => n.objectId === 611)!.role).toBe('guard');
        });

        test('a bow draw (0xBC with no defender, AttackAction.cs:261) pushes no melee event, and a real swing still does', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, 0, 0));
            expect(m.combatEvents).toEqual([]);
            expect(m.pet!.targetObjectId).toBeNull();
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
            expect(m.combatEvents.map(e => e.targetObjectId)).toEqual([MOB]);
        });

        test('the line "Your ground target is not visible!" drops our ground target: the server has (PlayerGroundTargetHandler.cs:30)', () => {
            const m = new WorldModel({}, () => 100_000);
            m.groundTarget = { x: 1, y: 2, z: 3 };
            m.handle(ServerOp.Message, line('You have to set a ground target for this Spell.'));
            expect(m.groundTarget).toEqual({ x: 1, y: 2, z: 3 });
            m.handle(ServerOp.Message, line('Your ground target is not visible!'));
            expect(m.groundTarget).toBeNull();
        });

        test('stats also come without items: what a percent power cost goes by (SpellHandler.cs:1190-1199)', () => {
            const m = new WorldModel({}, () => 100_000);
            expect(m.self.statsWithoutItems).toBeNull();
            const w = W();
            for (const x of [10, 60, 30, 40, 50, 11, 12, 13, 0]) w.u16(x); // base
            for (const x of [1, 5, 2, 3, 4, 0, 0, 0, 0]) w.u16(x); // buffs
            for (const x of [7, 20, 7, 7, 7, 7, 7, 7, 0]) w.u16(x); // items
            for (const x of [50, 50, 50, 50, 50, 50, 50, 50, 0]) w.u8(x); // item caps
            for (const x of [0, 2, 0, 0, 0, 0, 0, 0, 0]) w.u8(x); // realm abilities
            w.u8(0).u8(0).u16(100).u16(0);
            m.handle(ServerOp.StatsUpdate, w.toBytes());
            expect(m.decodeErrors).toBe(0);
            expect(m.self.stats).toMatchObject({ dexterity: 87 });
            expect(m.self.statsWithoutItems).toEqual({ strength: 11, dexterity: 67, constitution: 32, quickness: 43, intelligence: 54, piety: 11, empathy: 12, charisma: 13 });
        });

        test('the shade: effect icon 403 as a negative effect, on until its icon goes', () => {
            /** 0x75 entries: index, source, immune, icon, seconds, tooltip, negative, name (PacketLib1110.cs:92-120). */
            const icons = (...entries: Array<[index: number, icon: number, name: string, negative?: number]>) => {
                const w = W().u8(entries.length).u8(0).u8(0).u8(0);
                for (const [index, icon, name, negative] of entries) w.u8(index).u8(0xFF).u8(0).u16(icon).u16(0).u16(0).u8(negative ?? 1).pascal(name);
                return w.toBytes();
            };
            const m = new WorldModel({}, () => 100_000);
            expect(m.isShade()).toBe(false);
            m.handle(ServerOp.UpdateIcons, icons([0, 100, 'Bark Skin']));
            expect(m.isShade()).toBe(false);
            m.handle(ServerOp.UpdateIcons, icons([1, 403, 'Shade']));
            expect(m.isShade()).toBe(true);
            // A trailing slot is emptied with zeroes: no icon, no name (PacketLib1110.cs:125-130).
            m.handle(ServerOp.UpdateIcons, W().u8(1).u8(0).u8(0).u8(0).u8(1).fill(0, 10).toBytes());
            expect(m.isShade()).toBe(false);

            // The same icon, on the good side of the list: Stealth (StealthECSEffect.cs:14, :16) and a Theurgist's haste, spell 403 (spell.sql). The shade alone is negative (ShadeECSEffect.cs:8, :10).
            for (const name of ['Hidden', 'Bolstering Gust (Major)']) {
                const other = new WorldModel({}, () => 100_000);
                other.handle(ServerOp.UpdateIcons, icons([0, 403, name, 0]));
                expect(other.isShade()).toBe(false);
                other.handle(ServerOp.UpdateIcons, icons([1, 403, 'Shade']));
                expect(other.isShade()).toBe(true);
            }
        });
    });

    describe('a mob on its way to us: how long it runs in, and who is handed over at all', () => {
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;
        /** A mob this far from us, hit by the pet and on it, in a model that knows where we stand. */
        const onPetAt = (distance: number, healthPercent = 90) => {
            const c = withPet();
            c.m.hooks.selfPosition = () => ME;
            c.m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + distance, ME.y));
            c.m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, healthPercent));
            c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
            return c;
        };

        test('below 33 % health it runs slower (MaxSpeedCalculator.cs:147-150): at 4 %, d621, the hold fits about 44 units/s, not 150', () => {
            // "L6 at 4 %, d621: 'handOverMobs pet=19397 named=[] petTarget=6680 (hp=4 tgt=65535 speed=188)', 'handOver result ["6680:chase+5648"]', every 0xA1 from there 'speed=57 hp=4'."
            const { m, advance } = onPetAt(621, 4);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(targetOf(m)).toBe(SELF);
            advance(15_000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF, 4));
            expect(targetOf(m)).toBe(SELF);
            advance(1500);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF, 4));
            expect(targetOf(m)).toBeNull();
        });

        test('at 33 % and over it runs as a healthy mob does: the bound stays what it was', () => {
            const { m, advance } = onPetAt(450, 33);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            advance(5100);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF, 33));
            expect(targetOf(m)).toBeNull();
        });

        test('a snared mob outlasts its first estimate: the hold goes on while it reads 0xFFFF, moves and comes nearer', () => {
            // "That hold was 14.97 s; the run took 16.8 s": released at d 1945, 'sp 107', '+21.09 mobT null, inC false, atk []' through d 350, 300, 250, 200.
            const { m, advance } = onPetAt(1945);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            for (let t = 1; t <= 16; t++) {
                advance(1000);
                m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 107, 90, ME.x + 1945 - 107 * t));
                expect(targetOf(m)).toBe(SELF);
            }
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
        });

        test('a real id ends that at once too', () => {
            const { m, advance } = onPetAt(1945);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            advance(1000);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 107, 90, ME.x + 1838));
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 999, 107, 90, ME.x + 1731));
            expect(targetOf(m)).toBe(999);
            advance(100);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 107, 90, ME.x + 1720));
            expect(targetOf(m)).toBeNull();
        });

        test('its cap is 30 s from the hand-over', () => {
            const { m, advance } = onPetAt(1900);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            for (let t = 1; t <= 29; t++) {
                advance(1000);
                m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 30, 90, ME.x + 1900 - 30 * t));
                expect(targetOf(m)).toBe(SELF);
            }
            advance(2000);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 30, 90, ME.x + 1000));
            expect(targetOf(m)).toBeNull();
        });

        test.each([['standing', 0, 450], ['walking off', 100, 900]])('%s it doesn\'t extend: the first estimate is all it gets', (_what, speed, x) => {
            const { m, advance } = onPetAt(450);
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            advance(5001);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, speed as number, 90, ME.x + (x as number)));
            expect(targetOf(m)).toBeNull();
        });

        describe('a mob on the pet at full health with no hit by it has no aggro on us: only the pet\'s damage tags the owner (StandardMobBrain.cs:566-571)', () => {
            test('it goes to nobody, and targetedBy still knows it', () => {
                // "win defensive/follow tgt=19661 ... mob hp100 (777109,684984) d=1493 tgt=null inC=false": that mob walks away from us, d 1493, 1582, 1682.
                const { m, advance } = withPet();
                m.hooks.selfPosition = () => ME;
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 1493, ME.y));
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
                advance(100);
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBeNull();
                expect(m.lastPetLoss!.targetedBy).toEqual([MOB]);
            });

            test.each([
                ['hurt', (m: WorldModel) => m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, PET, 51))],
                ['with a swing of the pet\'s seen, which can miss: the tag comes with the attack (StandardMobBrain.cs:569-570)', (m: WorldModel) => m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 100))],
                ['with a spell of the pet\'s seen', (m: WorldModel) => m.handle(ServerOp.SpellEffectAnimation, spellEffect(PET, MOB))],
                ['with a hit of our own seen', (m: WorldModel) => m.handle(ServerOp.CombatAnimation, combatAnimation(SELF, MOB, 100))],
            ])('%s, it comes for us', (_what, then) => {
                const { m } = withPet();
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
                then(m);
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBe(SELF);
            });

            test('a hit under its id from before this entry is another mob\'s (Region.cs:955)', () => {
                const { m, advance } = withPet();
                m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 40));
                m.handle(ServerOp.RemoveObject, remove(MOB, 0));
                advance(3000);
                m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'bear', ME.x + 100, ME.y));
                advance(10);
                m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
                m.handle(ServerOp.PetWindow, PET_CLOSE);
                expect(targetOf(m)).toBeNull();
            });
        });

        test('lastPetLoss.targetObjectId: who it aimed at as it went, and absent with nobody', () => {
            const aimed = withPet();
            aimed.m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
            aimed.m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(aimed.m.lastPetLoss!.targetObjectId).toBe(MOB);
            const none = withPet();
            none.m.handle(ServerOp.PetWindow, PET_CLOSE);
            expect(none.m.lastPetLoss).not.toHaveProperty('targetObjectId');
        });
    });

    describe('a caster mob at its stop: its 0 can come before its first 0x72', () => {
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;
        const onUs = () => {
            const c = withPet();
            c.m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, SELF));
            expect(targetOf(c.m)).toBe(SELF);
            return c;
        };

        test('the 0 then the 0x72: it is back on us, and the next 0 holds', () => {
            // q11: '17332 d=875 {"atk":0,"patk":0,"t":null,"sp":1,"mC":false}', 'EV 17578 spellCast', '20062 {"atk":1,"t":"us"}'.
            const { m, advance } = onUs();
            advance(1000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
            advance(245);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBe(SELF);
            advance(2000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBe(SELF);
        });

        test('so with one last named on the pet', () => {
            // a7c: '14.34 mT 24379', '14.54 mT null', '17.87 EV spellCast by 8476 on null eff 551 cast 3100'.
            const { m, advance } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
            advance(200);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
            advance(3330);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBe(PET);
        });

        test('a mob that reads 0 and goes home sends no 0x72, so it stays cleared', () => {
            const { m, advance } = onUs();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            advance(3000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
        });

        test('over 6 s after that naming a 0x72 says nothing of us', () => {
            const { m, advance } = onUs();
            advance(3000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            advance(3001);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBeNull();
        });

        test('one handed over has its naming from its stop: its whole run reads 0xFFFF', () => {
            const { m, advance } = withPet();
            m.hooks.selfPosition = () => ME;
            m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 1745, ME.y));
            m.handle(ServerOp.CombatAnimation, combatAnimation(PET, MOB, 90));
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            advance(8000);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0xFFFF, 180, 90, ME.x + 900));
            expect(targetOf(m)).toBe(SELF);
            advance(300);
            m.handle(ServerOp.ObjectUpdate, movingUpdate(MOB, 0, 0, 90, ME.x + 875));
            expect(targetOf(m)).toBeNull();
            advance(245);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBe(SELF);
        });

        test('a real id since then is someone else: the 0x72 is about them', () => {
            const { m, advance } = onUs();
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 999));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            advance(100);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBeNull();
        });

        test('the bound holds over repeats: a mob that has gone on to somebody else, casting on, doesn\'t read as on us until it dies', () => {
            const { m, advance } = onUs();
            advance(1000);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            advance(200);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBe(SELF);
            advance(6100);
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            expect(targetOf(m)).toBeNull();
            advance(100);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBeNull();
        });

        test('nor if the pet it was on has gone: nobody is back', () => {
            const { m, advance } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
            m.handle(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            m.handle(ServerOp.PetWindow, PET_CLOSE);
            advance(100);
            m.handle(ServerOp.SpellCastAnimation, castAnimation(MOB));
            expect(targetOf(m)).toBeNull();
        });
    });

    describe('a spell\'s damage comes as an 0xBC of its own, with result 0x14 (SpellHandler.cs:3092, :3111), which no swing has (WeaponAction.cs:280-330): weapon 0 and style 0 are an unarmed mob\'s swing too', () => {
        const targetOf = (m: WorldModel, oid = MOB) => m.nearbyNpcs(ME).find(n => n.objectId === oid)!.targetObjectId;
        const blow = (attacker: number, defender: number, result: number, hp = 70) => W().u16(attacker).u16(defender).u16(0).u16(0).u16le(0).u8(0).u8(result).u8(hp).u8(0).toBytes();
        const onThePet = () => {
            const c = withPet();
            c.m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, PET, 80));
            return c;
        };

        test('a DoT\'s tick on us doesn\'t read the mob fighting our pet as on us', () => {
            // a7c: "'mT' flips 24379 (pet) to 24443 (us) and back: 27.36 pet, 28.87 us, 30.68 pet"; "Trace 20:26:09.813: Message then CombatAnimation with no swing".
            const { m } = onThePet();
            m.handle(ServerOp.CombatAnimation, blow(MOB, SELF, 0x14));
            expect(targetOf(m)).toBe(PET);
            expect(m.inCombat()).toBe(true);
            expect(m.combatEvents.at(-1)).toMatchObject({ kind: 'melee', attackerObjectId: MOB, targetObjectId: SELF, result: 'other' });
        });

        test('nor one on the pet from a mob on us', () => {
            const { m } = withPet();
            m.handle(ServerOp.CombatAnimation, combatAnimation(MOB, SELF, 80));
            m.handle(ServerOp.CombatAnimation, blow(MOB, PET, 0x14));
            expect(targetOf(m)).toBe(SELF);
        });

        test('an unarmed mob\'s swing, weapon 0 and style 0, says who it is on as ever', () => {
            const { m } = onThePet();
            m.handle(ServerOp.CombatAnimation, blow(MOB, SELF, 10));
            expect(targetOf(m)).toBe(SELF);
        });

        test('with no naming on another of ours lately the tick is all there is to go by', () => {
            const late = onThePet();
            late.advance(6001);
            late.m.handle(ServerOp.CombatAnimation, blow(MOB, SELF, 0x14));
            expect(targetOf(late.m)).toBe(SELF);

            const none = withPet();
            none.m.handle(ServerOp.CombatAnimation, blow(MOB, SELF, 0x14));
            expect(targetOf(none.m)).toBe(SELF);
        });
    });

    test('NearbyNpc.firstSeenAt: when the entry appeared; a 0xDA for one we hold keeps it, and one after its death starts anew', () => {
        const { m, advance, now } = withPet();
        const first = now();
        advance(500);
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'rat', ME.x + 100, ME.y));
        const entry = () => m.nearbyNpcs(ME).find(n => n.objectId === MOB)!;
        expect(entry().firstSeenAt).toBe(first);
        m.handle(ServerOp.RemoveObject, remove(MOB, 0));
        advance(500);
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'bear', ME.x + 100, ME.y));
        expect(entry().firstSeenAt).toBe(first + 1000);
    });
});

describe('WorldModel: a model that changes (0xDB), and a Necromancer in shade', () => {
    /** The C#'s bytes (PacketLib168.cs:990-998). */
    const modelChange = (oid: number, model: number, size = 0) => Uint8Array.of(oid >> 8, oid & 0xFF, model >> 8, model & 0xFF, size, 0, 0, 0);
    const SHADE = 822;
    const briton = (m: WorldModel) => m.nearbyPlayers(ME).find(o => o.objectId === 427)!;

    test('a player keeps the model of its create, and goes into shade and out of it on 0xDB (GamePlayer.cs:2021, ShadeECSEffect.cs:25-26, :37-38)', () => {
        const m = new WorldModel();
        m.handle(ServerOp.PlayerCreate172, playerCreate(427, 9, 'Briton', 1));
        expect(briton(m)).toMatchObject({ model: 32, isShade: false });
        expect(m.handle(ServerOp.ModelChange, modelChange(427, SHADE))).toBe(true);
        expect(briton(m)).toMatchObject({ model: SHADE, isShade: true });
        m.handle(ServerOp.ModelChange, modelChange(427, 32));
        expect(briton(m)).toMatchObject({ model: 32, isShade: false });
    });

    test('a player already in shade when first seen reads so from its create', () => {
        const m = new WorldModel();
        m.handle(ServerOp.PlayerCreate172, playerCreate(427, 9, 'Briton', 1, SHADE));
        expect(briton(m)).toMatchObject({ model: SHADE, isShade: true });
    });

    test('an NPC\'s entry follows it; our own id, which the server tells too, and an id we don\'t know change nothing', () => {
        const m = new WorldModel();
        m.self.objectId = 123;
        m.handle(ServerOp.NPCCreate, npcCreate(500, 'rat', ME.x + 100, ME.y));
        m.handle(ServerOp.ModelChange, modelChange(500, 1024, 40));
        expect(m.nearbyNpcs(ME)[0]!.model).toBe(1024);
        expect(m.handle(ServerOp.ModelChange, modelChange(123, SHADE))).toBe(true);
        expect(m.handle(ServerOp.ModelChange, modelChange(999, SHADE))).toBe(true);
        expect(m.nearbyPlayers(ME)).toEqual([]);
    });

    test('a packet cut short doesn\'t throw', () => {
        expect(new WorldModel().handle(ServerOp.ModelChange, Uint8Array.of(1, 2))).toBe(true);
    });
});
