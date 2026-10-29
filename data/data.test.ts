import { describe, expect, test } from 'bun:test';
import {
    defaultStats, estimateZ, findItemTemplates, findNpcSpawns, getClass, getClasses, getItemTemplate, getMerchantItems,
    getNpcSpawns, getPlayableRacesForClass, getRace, getRacesForClass, getSpell, getSpellLine, getStartingClasses, getStartupLocation,
    getStarterArmour, getStarterEquipment, getStylesFor, getZoneAt, getZonePointsFrom, nearestBindpoint, realmId, statPointCost, toStats, validateCharacter,
} from './index';
import { splitClassList } from './build';

// Cotswold Village, Camelot Hills (region 1): bind stone at (560491, 511708, 2280).
const COTSWOLD = { x: 560491, y: 511708 };

describe('zones', () => {
    test('Camelot Hills zone lookup', () => {
        const z = getZoneAt(1, COTSWOLD.x, COTSWOLD.y);
        expect(z?.id).toBe(0);
        expect(z?.name).toBe('Camelot Hills');
        expect(getZoneAt(1, 0, 0)).toBeUndefined();
    });
});

describe('npc spawns', () => {
    test('loads all mob rows', () => {
        expect(getNpcSpawns().length).toBeGreaterThan(90000);
    });

    test('find merchants near Cotswold sorted by distance', () => {
        const m = findNpcSpawns({ regionId: 1, near: COTSWOLD, radius: 3000, classType: 'GameMerchant' });
        expect(m.length).toBeGreaterThan(3);
        expect(m.map(n => n.name)).toContain('Jon Smythe');
        for (let i = 1; i < m.length; i++) expect(m[i]!.distance!).toBeGreaterThanOrEqual(m[i - 1]!.distance!);
        expect(m[m.length - 1]!.distance!).toBeLessThanOrEqual(3000);
    });

    test('name regex and level range', () => {
        const s = findNpcSpawns({ name: /^puny skeleton$/, regionId: 1, levelRange: [0, 5] });
        expect(s.length).toBeGreaterThan(0);
        expect(s.every(n => n.name === 'puny skeleton' && n.level <= 5 && n.distance === null)).toBe(true);
    });
});

describe('merchants and items', () => {
    test('merchant list from a spawn resolves to items with prices', () => {
        const jon = findNpcSpawns({ name: 'Jon Smythe', regionId: 1 })[0]!;
        expect(jon.itemsListTemplateId).toBe('AlbClothRobes');
        const items = getMerchantItems(jon.itemsListTemplateId);
        expect(items.length).toBeGreaterThan(0);
        expect(items[0]!.itemSlot).toBe(items[0]!.page * 30 + items[0]!.slot);
        expect(items.every(i => i.price >= 0 && i.name.length > 0)).toBe(true);
        expect(getMerchantItems('albclothrobes').length).toBe(items.length);
        expect(getMerchantItems('no-such-list')).toEqual([]);
        const tpl = getItemTemplate(items[0]!.itemTemplateId.toUpperCase());
        expect(tpl?.name).toBe(items[0]!.name);
    });

    test('merchant lists merge case-insensitively and keep one item per slot', () => {
        // merchantitem has both "Alb1HStaff" and "Alb1hStaff" rows; SQL (ci collation) returns them as one list.
        const staff = getMerchantItems('Alb1HStaff');
        expect(getMerchantItems('Alb1hStaff')).toEqual(staff);
        expect(staff.length).toBeGreaterThan(100);
        // This list has two rows on page 0 slot 4; the server keeps the lowest MerchantItem_ID (steel_full_helm).
        const list = getMerchantItems('44ac972a-7aab-4d9c-8c2e-2c0fa5313c6a');
        expect(new Set(list.map(e => e.itemSlot)).size).toBe(list.length);
        expect(list.find(e => e.itemSlot === 4)?.itemTemplateId).toBe('steel_full_helm');
    });

    test('find item templates by name', () => {
        expect(findItemTemplates(/^Bread$/i, 5).length).toBeGreaterThanOrEqual(0);
        expect(findItemTemplates('sword', 3).length).toBe(3);
    });
});

describe('estimateZ', () => {
    test('near Cotswold returns a sane ground height', () => {
        const z = estimateZ(1, COTSWOLD.x + 300, COTSWOLD.y + 200);
        expect(z).not.toBeNull();
        expect(z!).toBeGreaterThan(2000);
        expect(z!).toBeLessThan(3000);
    });

    test('fallback when nothing is nearby', () => {
        expect(estimateZ(1, 10, 10)).toBeNull();
        expect(estimateZ(1, 10, 10, 1234)).toBe(1234);
        expect(estimateZ(99999, 1, 1, 7)).toBe(7);
    });

    test('leave-one-out error in Camelot Hills is small', () => {
        const spawns = findNpcSpawns({ regionId: 1, near: COTSWOLD, radius: 20000 }).filter(n => !(n.flags & 0x20));
        const errs: number[] = [];
        for (let i = 0; i < spawns.length; i += Math.max(1, Math.floor(spawns.length / 300))) {
            const s = spawns[i]!;
            const z = estimateZ(1, s.x, s.y, null, { exclude: { x: s.x, y: s.y } });
            if (z !== null) errs.push(Math.abs(z - s.z));
        }
        errs.sort((a, b) => a - b);
        const median = errs[errs.length >> 1]!;
        expect(errs.length).toBeGreaterThan(100);
        expect(median).toBeLessThan(150);
    });
});

describe('bind points, zone points, startup', () => {
    test('nearest bind point to Cotswold is the village stone', () => {
        const b = nearestBindpoint(1, COTSWOLD.x + 50, COTSWOLD.y, 'albion');
        expect(b?.x).toBe(560491);
        expect(b!.distance).toBeCloseTo(50, 0);
        expect(nearestBindpoint(424242, 0, 0)).toBeUndefined();
    });

    test('zone points from Camelot Hills region', () => {
        const zp = getZonePointsFrom(1);
        expect(zp.every(z => z.sourceRegion === 1)).toBe(true);
    });

    test('startup location for Briton Armsman is Camelot Hills', () => {
        const s = getStartupLocation({ realm: 'albion', raceId: 1, classId: 2 });
        expect(s).toMatchObject({ regionId: 1, x: 574123, y: 530520, z: 2933, heading: 3077 });
    });
});

describe('classes and races', () => {
    test('enum ids come from the C# source', () => {
        expect(getClass('Armsman')?.id).toBe(2);
        expect(getClass('Fighter')?.id).toBe(14);
        expect(getClass(14)?.advancedClassIds).toContain(2);
        expect(getClass('Rogue', 'midgard')?.id).toBe(38);
        expect(getClass('Rogue', 'albion')?.id).toBe(17);
        expect(getClass('AlbionRogue')?.id).toBe(17);
        expect(getClass('Scout')?.baseClassId).toBe(17);
        expect(getRace('Briton')?.id).toBe(1);
        expect(getRace('Troll')?.id).toBe(6);
        expect(getRace('Sylvan')?.id).toBe(15);
        expect(getRace('HalfOgre')?.creatable).toBe(false);
    });

    test('starting classes per realm', () => {
        const alb = getStartingClasses('albion').map(c => c.name);
        expect(alb).toContain('Fighter');
        expect(alb).toContain('Armsman');
        expect(alb).not.toContain('Heretic');
        const mid = getStartingClasses(2).map(c => c.key);
        expect(mid).toContain('Viking');
        expect(mid).not.toContain('Warlock');
        // Valkyrie is a starting class but its EligibleRaces list is empty in ClassValkyrie.cs.
        expect(mid).not.toContain('Valkyrie');
        expect(getStartingClasses('hibernia').every(c => c.realm === 3)).toBe(true);
        expect(getRacesForClass('Friar').map(r => r.name)).toEqual(['Briton']);
    });

    test('validateCharacter mirrors IsCharacterValid', () => {
        expect(validateCharacter({ realm: 'albion', class: 'Armsman', race: 'Briton', gender: 'male' }).valid).toBe(true);
        expect(validateCharacter({ realm: 'midgard', class: 'Viking', race: 'Troll' }).valid).toBe(true);
        expect(validateCharacter({ realm: 'albion', class: 'Armsman', race: 'Troll' }).valid).toBe(false);
        expect(validateCharacter({ realm: 'albion', class: 'Viking', race: 'Briton' }).valid).toBe(false);
        // ClassBainshee.cs:169 `EligibleRaces => new() { /* commented out */ }`: no race can be one.
        expect(validateCharacter({ realm: 'hibernia', class: 'Bainshee', race: 'Elf', gender: 'female' }).valid).toBe(false);
        expect(getClass('Bainshee')?.eligibleRaceIds).toEqual([]);
        expect(getStartingClasses('hibernia').map(c => c.key)).not.toContain('Bainshee');
        expect(validateCharacter({ realm: 'hibernia', class: 'Eldritch', race: 'Elf' }).valid).toBe(true);
        expect(validateCharacter({ realm: 'albion', class: 'Heretic', race: 'Briton' }).valid).toBe(false);
        expect(validateCharacter({ realm: 'none', class: 'Fighter', race: 'Briton' }).valid).toBe(false);
    });

    test('startup location: every creatable pair but two has one', () => {
        const missing: string[] = [];
        for (const c of getClasses().filter(x => x.creatable)) {
            for (const r of c.creatableRaceIds) {
                const v = validateCharacter({ realm: c.realm, class: c.id, race: r });
                if (v.warnings.length) missing.push(`${c.key}/${v.raceInfo!.name}`);
            }
        }
        expect(missing.sort()).toEqual(['Acolyte/Inconnu', 'Disciple/Saracen']);
        expect(validateCharacter({ realm: 'albion', class: 'Armsman', race: 'Briton' }).warnings).toEqual([]);
    });

    test('getPlayableRacesForClass drops the pairs without a startup location', () => {
        expect(getRacesForClass('Acolyte', 'albion').map(r => r.name)).toContain('Inconnu');
        expect(getPlayableRacesForClass('Acolyte', 'albion').map(r => r.name)).toEqual(['Briton', 'Avalonian', 'Highlander']);
        expect(getPlayableRacesForClass('Disciple', 'albion').map(r => r.name)).toEqual(['Briton', 'Inconnu']);
        expect(getPlayableRacesForClass('Fighter', 'albion').map(r => r.name)).toEqual(getRacesForClass('Fighter', 'albion').map(r => r.name));
        expect(getPlayableRacesForClass('Nope')).toEqual([]);
    });

    test('gender resolves to the race/class constraint', () => {
        expect(validateCharacter({ realm: 'albion', class: 'Armsman', race: 'Briton' })).toMatchObject({ valid: true, gender: 'male' });
        expect(validateCharacter({ realm: 'albion', class: 'Armsman', race: 'Briton', gender: 'female' }).gender).toBe('female');
        // Valkyrie is female-only (GlobalConstants.cs:1029) and also has no eligible races.
        const v = validateCharacter({ realm: 'midgard', class: 'Valkyrie', race: 'Norseman' });
        expect(v.gender).toBe('female');
        expect(v.errors.some(e => e.includes('must be'))).toBe(false);
        expect(validateCharacter({ realm: 'midgard', class: 'Valkyrie', race: 'Norseman', gender: 'male' }).errors)
            .toContain('Valkyrie must be female');
    });

    test('every class/race pair matches the C# EligibleRaces lists', () => {
        // Hand-checked against server/core/GameServer/playerclasses/*/Class*.cs.
        expect(getRacesForClass('Armsman').map(r => r.name).sort()).toEqual(['Avalonian', 'Briton', 'Highlander', 'Inconnu', 'Saracen']);
        expect(getRacesForClass('Fighter').map(r => r.id)).toEqual([1, 2, 3, 4, 13]);
        expect(getClass('Fighter')?.eligibleRaceIds).toEqual([1, 2, 3, 4, 13, 16, 19]);
        for (const c of getClasses()) {
            for (const id of c.creatableRaceIds) expect(getRace(id)?.realm, `${c.key} race ${id}`).toBe(c.realm);
        }
    });

    test('defaultStats spends exactly 30 points', () => {
        for (const realm of ['albion', 'midgard', 'hibernia'] as const) {
            for (const c of getStartingClasses(realm)) {
                for (const raceId of c.creatableRaceIds) {
                    const stats = defaultStats(c.id, raceId);
                    expect(statPointCost(stats, raceId)).toBe(30);
                    expect(validateCharacter({ realm, class: c.id, race: raceId, gender: c.gender ?? 'male', stats }).errors).toEqual([]);
                }
            }
        }
        const s = defaultStats('Armsman', 'Briton');
        expect(s).toMatchObject({ STR: 70, CON: 70, DEX: 70, QUI: 60 });
        expect(toStats(s).strength).toBe(70);
    });

    test('realmId', () => {
        expect(realmId('albion')).toBe(1);
        expect(realmId('Hib')).toBe(3);
        expect(realmId(2)).toBe(2);
        expect(realmId('none')).toBe(0);
    });
});

describe('starter equipment', () => {
    test('melee base classes start armoured, except Guardian whose templates are missing', () => {
        // starterequipment rows 8/107-112 (Fighter), 64-93 (Viking), 43-90 (Naturalist): all templates exist.
        for (const [cls, realm] of [['Fighter', 'albion'], ['Viking', 'midgard'], ['Naturalist', 'hibernia']] as const) {
            const { armour } = getStarterArmour(cls, realm);
            expect(armour.map(a => a.itemType).sort(), cls).toEqual([21, 22, 23, 25, 27, 28]);
        }
        // Rows 13, 14, 76, 77, 78, 109 ('52;44;43;45;') name leaf_tacuil_* but only leaf_tacuil_*3 exist,
        // so the server skips them (StartupEquipment.cs:82-86): a Guardian gets sword and shield only.
        const guardian = getStarterArmour('Guardian', 'hibernia');
        expect(guardian.armour).toEqual([]);
        expect(guardian.missing).toEqual(expect.arrayContaining(['leaf_tacuil_vest', 'leaf_tacuil_helm', 'leaf_tacuil_boots']));
        expect(getStarterEquipment('Guardian', 'hibernia').filter(s => s.item).map(s => s.templateId))
            .toEqual(expect.arrayContaining(['training_sword_hib', 'training_shield']));
    });

    test('class-0 rows apply only to classes with rows of their own', () => {
        // StartupEquipment.cs:125-128.
        expect(getStarterEquipment('Fighter', 'albion').map(s => s.templateId)).toContain('Personal_Bind_Recall_Stone');
        expect(getStarterEquipment(424242)).toEqual([]);
        expect(splitClassList('52;44;43;45;')).toEqual([52, 44, 43, 45]);
        expect(splitClassList('3;25;50')).toEqual([3, 25, 50]);
        expect(splitClassList('1-3;x;')).toEqual([1, 2, 3]);
    });
});

describe('skills metadata', () => {
    test('spells, lines and styles load', () => {
        const line = getSpellLine('arboreal path');
        expect(line?.spells.length).toBeGreaterThan(0);
        expect(getSpell(line!.spells[0]!.spellId)?.name.length).toBeGreaterThan(0);
        const styles = getStylesFor(2, 'Slash');
        expect(styles.length).toBeGreaterThan(0);
        expect(styles.every(s => s.classId === 2)).toBe(true);
    });
});
