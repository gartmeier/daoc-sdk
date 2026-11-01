import { describe, expect, test } from 'bun:test';
import { encodeCp1252, PacketWriter } from '../protocol/buffer';
import { ServerOp } from '../protocol/opcodes';
import { getRacesForClass, getStartingClasses } from '../../data/index';
import { creationPoints, planCharacter, RACE_MODELS } from './classes';
import { MAX_COMBAT_EVENTS, WorldModel } from './world-model';

const W = () => new PacketWriter();
const ME = { x: 574797, y: 530161, z: 2896 };

function npcCreate(oid: number, name: string, x: number, y: number, opts: { guild?: string; level?: number; peace?: boolean } = {}): Uint8Array {
    return W().u16(oid).u16(0).u16(0).u16(ME.z).u32(x).u32(y).u16(0).u16(400).u8(50).u8(opts.level ?? 1)
        .u8(opts.peace ? 0x10 : 0).u8(0x20).u8(0).u8(0).u16(0).pascal(name).pascal(opts.guild ?? '').u8(0).toBytes();
}

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

    test('inventory update adds and removes slots', () => {
        const m = new WorldModel();
        const item = (slot: number, name: string) => W().u8(slot).u16(0).u8(1).u8(0).u8(0).u8(0).u8(0).u8(0).u16(10).u8(100).u8(100).u8(100).u8(0).u8(0).u16(5).u8(0).u16(0).u8(0).u16(0).pascal(name).toBytes();
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([2, 0, 0, 0, 0, 2, ...item(40, 'a'), ...item(10, 'b')]));
        expect(m.inventoryList(40, 79).map(i => i.name)).toEqual(['a']);
        expect(m.inventoryList(10, 37).map(i => i.name)).toEqual(['b']);
        m.handle(ServerOp.InventoryUpdate, Uint8Array.from([1, 0, 0, 0, 0, 0, 40, ...new Uint8Array(24)]));
        expect(m.inventoryList(40, 79)).toEqual([]);
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
    /** 0x4B PlayerCreate (objects.ts decodePlayerCreate): realm in flag bits 2-3. */
    const playerCreate = (oid: number, session: number, name: string, realm: number) =>
        W().f32le(ME.x + 50).f32le(ME.y).f32le(ME.z).u16(session).u16(oid).u16(0).u16(32).u8(20).u8(realm << 2).fill(0, 10)
            .pascal(name).pascal('').pascal('').pascal('').pascal('').u8(0).toBytes();
    const combatAnimation = (attacker: number, defender: number, healthPercent: number) =>
        W().u16(attacker).u16(defender).u16(3).u16(0).u16le(0).u8(0).u8(10).u8(healthPercent).u8(0).toBytes();

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

    test(`the buffer keeps the newest ${MAX_COMBAT_EVENTS} events (a group fight is many swings a second)`, () => {
        expect(MAX_COMBAT_EVENTS).toBe(200);
        const m = new WorldModel();
        for (let i = 0; i < 250; i++) m.handle(ServerOp.CombatAnimation, combatAnimation(301, 123, 100 - (i % 100)));
        expect(m.combatEvents).toHaveLength(200);
        expect(m.combatEvents[0]!.id).toBe(m.combatEvents.at(-1)!.id - 199);
    });
});
