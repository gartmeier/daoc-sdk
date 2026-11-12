import { describe, expect, test } from 'bun:test';
import { applyAnswer, damageStatOf, debuffFor, envenom, isFleeing, isPoisoned, needsRestock, poisonId, poisonOn, poisonPlan, restock, shoppingList, swapPoison, wantedRoles } from './poison';

describe('poisonPlan', () => {
    test('Envenom 20 (Mordred, Scathach): greater lethal, greater weakening, greater imbalancing, lesser infectious', () => {
        expect(poisonPlan(20)).toMatchObject({
            dot: { name: 'greater lethal poison' }, debuff: { name: 'greater weakening poison' },
            snare: { name: 'greater imbalancing poison' }, disease: { name: 'lesser infectious serum' },
        });
    });
    test('Envenom 22 (Hodur): the Str/Con debuff ahead of the Str one', () => {
        expect(poisonPlan(22).debuff?.name).toBe('minor enervating poison');
    });
    test('low Envenom takes what it may use, or nothing', () => {
        expect(poisonPlan(12)).toMatchObject({ dot: { name: 'lethal poison' }, debuff: { name: 'major weakening poison' }, snare: null });
        expect(poisonPlan(3).dot).toBeNull();
    });
});

test('poisonId: the DB ids by realm', () => {
    expect(poisonId('greater lethal poison', 'albion')).toBe('greater_lethal_poison');
    expect(poisonId('greater lethal poison', 'midgard')).toBe('greater_lethal_poison2');
    expect(poisonId('lesser infectious serum', 'hibernia')).toBe('lesser_infectious_serum3');
});

describe('which debuff a target gets (GamePlayer.GetWeaponStat)', () => {
    const read = (classes: string[], basis: string[] = [], role?: string) => ({ classGuess: { classes, basis, p: [1], role } });
    test('by the weapons seen: a hammer or sword Strength, a dagger or flail both, a bow or staff Dexterity', () => {
        expect(damageStatOf(read(['Warrior'], ['weapons crush shield']))).toBe('str');
        expect(damageStatOf(read(['Infiltrator'], ['weapons thrust']))).toBe('strdex');
        expect(damageStatOf(read(['Reaver'], ['weapons flex shield']))).toBe('strdex');
        expect(damageStatOf(read(['Scout'], ['weapons bow']))).toBe('dex');
        expect(damageStatOf(read(['Berserker'], ['weapons leftaxe|slash slash|twohand']))).toBe('str');
    });
    test('by class when no weapon was seen, Strength when nothing is known', () => {
        expect(damageStatOf(read(['Hunter']))).toBe('dex');
        expect(damageStatOf(read(['Nightshade']))).toBe('strdex');
        expect(damageStatOf({})).toBe('str');
    });
    test('the disease on a healer, caster or crowd controller, or a Dexterity fighter; the Strength debuff on the rest', () => {
        expect(debuffFor(read(['Cleric'], ['weapons crush'], 'healer'))).toBe('disease');
        expect(debuffFor({ caster: true })).toBe('disease');
        expect(debuffFor(read(['Scout'], ['weapons bow'], 'caster'))).toBe('disease');
        expect(debuffFor(read(['Ranger'], ['weapons bow']))).toBe('disease');
        expect(debuffFor(read(['Armsman'], ['weapons polearm'], 'tank'))).toBe('debuff');
        expect(debuffFor(read(['Infiltrator'], ['weapons thrust'], 'melee'))).toBe('debuff');
    });
});

test('wantedRoles: main the damage over time, off hand the debuff, spares snare, disease, then damage over time', () => {
    expect(wantedRoles(3)).toEqual({ main: 'dot', off: 'debuff', spares: ['snare', 'disease', 'dot'] });
    expect(wantedRoles(1).spares).toEqual(['snare']);
});

describe('reading the server', () => {
    test('a delve: which poison, or clean', () => {
        expect(poisonOn(['Offensive Proc Ability:', '    - 1 Charges', 'Inflicts damage to the target repeatly over a given time period.'])).toBe('dot');
        expect(poisonOn(['    - 1 Charges', "Reduces the target's movement speed."])).toBe('snare');
        expect(poisonOn(['    - 1 Charges', "Decreases target's Str."])).toBe('debuff');
        // The delves as the server sends them (Mordred's five weapons, 2026-11-12).
        expect(poisonOn(['- 1 Charges', '- 1 Max', 'Inflicts 26 body damage every 4 seconds for 20 seconds.'])).toBe('dot');
        expect(poisonOn(['- 1 Charges', "Decreases the target's strength by 44 for 1 minute."])).toBe('debuff');
        expect(poisonOn(['- 1 Charges', 'The target is slowed by 40% for 1 minute 1 second.'])).toBe('snare');
        expect(poisonOn(['- 1 Charges', 'Inflicts a wasting disease on the target that slows target by 15%, reduces its strength by 7.5% and inhibits healing by 50% for 1 minute 30 seconds.'])).toBe('disease');
        expect(poisonOn(['    - 0 Charges', 'Inflicts damage'])).toBeNull();
        expect(isPoisoned(['Damage Modifiers:', '- 8.4 Base DPS'])).toBe(false);
    });
    test('the application answers (GamePlayer.cs:7243-7323, GamePlayer.txt:173-178)', () => {
        expect(applyAnswer(['You apply greater lethal poison to Thidranki Infiltrator Dirk.'])).toBe('applied');
        expect(applyAnswer(["You have been in combat recently and can't apply a poison yet!"])).toBe('in_combat');
        expect(applyAnswer(["You can't use this poison."])).toBe('cant_use');
        expect(applyAnswer(["You can't poison this weapon!"])).toBe('cant_poison');
        expect(applyAnswer(['You are now hidden!'])).toBeNull();
    });
});

describe('buying', () => {
    const plan = poisonPlan(20);
    const none = { dot: 0, debuff: 0, snare: 0, disease: 0 };
    test('low on the damage over time or the debuff: restock; snare and disease alone never send it', () => {
        expect(needsRestock(plan, { ...none, dot: 1, debuff: 5 })).toBe(true);
        expect(needsRestock(plan, { ...none, dot: 5, debuff: 0 })).toBe(true);
        expect(needsRestock(plan, { dot: 5, debuff: 3, snare: 0, disease: 0 })).toBe(false);
    });
    test('the list buys packs of 20 to fill each to its carry, damage over time first, within the purse', () => {
        // Mordred's first trip bought 10 packs of lethal (200) when the count was read as poisons.
        const list = shoppingList(plan, { dot: 2, debuff: 0, snare: 4, disease: 1 }, 100_000);
        expect(list.map(l => [l.row.name, l.count])).toEqual([['greater lethal poison', 1], ['greater weakening poison', 1], ['lesser infectious serum', 1]]);
        const poor = shoppingList(plan, none, 1500);
        // A pack of lethal (770) leaves 730: a pack of weakening (492) leaves 238, too little for the rest.
        expect(poor).toEqual([{ row: plan.dot!, count: 1 }, { row: plan.debuff!, count: 1 }]);
    });
});

test('isFleeing: out of melee and further by 60 within 2.5 s', () => {
    expect(isFleeing({ distance: 250, at: 0 }, { distance: 320, at: 1000 })).toBe(true);
    expect(isFleeing({ distance: 250, at: 0 }, { distance: 280, at: 1000 })).toBe(false);
    expect(isFleeing({ distance: 100, at: 0 }, { distance: 180, at: 1000 })).toBe(false);
    expect(isFleeing({ distance: 250, at: 0 }, { distance: 400, at: 4000 })).toBe(false);
    expect(isFleeing(undefined, { distance: 400, at: 0 })).toBe(false);
});

test('the behaviours', () => {
    expect([envenom().name, swapPoison().name, restock().name]).toEqual(['envenom', 'swapPoison', 'restock']);
});
