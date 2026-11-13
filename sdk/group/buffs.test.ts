import { describe, expect, test } from 'bun:test';
import { nextBuff, planBuffs, providerFor, REBUFF_AFTER_LOSS_MS, strippedMembers, surplusConcentration, type BuffTask } from './buffs';
import { report } from './fixtures';
import type { BuffSpell, MemberReport, Role } from './types';

// The hibernia group at level 9 (spell lists read live in session 2).
const conc = (name: string, slot: BuffSpell['slot'], c: number): BuffSpell => ({ name, slot, target: 'Realm', concentration: c });
const NURTURE: BuffSpell[] = [conc('Bark Skin', 'af', 2), conc('Strength of the Redwood', 'str', 3), conc("Oak's Stoutness", 'con', 2), conc('Dexterity of the Ferret', 'dex', 3)];
const DRUID: BuffSpell[] = [
    conc('Major Bark Skin', 'af', 3), ...NURTURE.slice(1), conc("Hunter's Attack", 'haste', 1), conc('Briarsprout', 'dmgshield', 1),
    { name: 'Talons of the Wild', slot: 'dmgadd', target: 'Self', concentration: 0 },
];
// Songs (Rhythm of Hibernia, Chant of Healing, Clear Path) are not buffs: songs.ts picks one at a time.
const BARD: BuffSpell[] = NURTURE;
const CASTER: BuffSpell[] = [
    { name: 'Powerbarrier', slot: 'af', target: 'Self', concentration: 0 },
    { name: 'Aura of Redirection', slot: 'dmgshield', target: 'Realm', concentration: 0 },
];

function member(name: string, role: Role, buffSpells: BuffSpell[], over: Partial<MemberReport> = {}): MemberReport {
    return report(name, { role, capabilities: { heal: false, cc: false, nuke: false, buffs: buffSpells.map(s => s.name), buffSpells }, ...over });
}

function group(over: Record<string, Partial<MemberReport>> = {}, druidSpells = DRUID): MemberReport[] {
    return [
        member('Cuchulainn', 'tank', [], over.Cuchulainn),
        member('Brigid', 'healer', druidSpells, over.Brigid),
        member('Oisin', 'support', BARD, over.Oisin),
        member('Niamh', 'nuker', CASTER, over.Niamh),
        member('Ciaran', 'nuker', CASTER, over.Ciaran),
    ];
}

const show = (ts: BuffTask[]) => ts.map(t => `${t.spell.name}>${t.target}`);

describe('buff plan', () => {
    test('every caster keeps its own self buffs (Ciaran no longer leaves his to Niamh)', () => {
        const g = group();
        expect(show(planBuffs('Ciaran', g))).toEqual(['Powerbarrier>Ciaran']);
        expect(show(planBuffs('Niamh', g))).toEqual(['Powerbarrier>Niamh']);
    });

    test('the Bard gives base buffs to the others and himself; the Druid keeps her own base buffs', () => {
        const g = group();
        const bard = show(planBuffs('Oisin', g));
        // Rounds over what each member can get: the tank's AF and the Bard's own Con first (the
        // casters' first is their own AF), then the tank's Con, the Bard's AF, the casters' Con, ...
        expect(bard.slice(0, 6)).toEqual(['Bark Skin>Cuchulainn', "Oak's Stoutness>Oisin", "Oak's Stoutness>Cuchulainn", 'Bark Skin>Oisin', "Oak's Stoutness>Niamh", "Oak's Stoutness>Ciaran"]);
        expect(bard).toContain('Strength of the Redwood>Cuchulainn');
        expect(bard).toContain('Dexterity of the Ferret>Niamh');
        expect(bard).not.toContain('Bark Skin>Niamh');           // casters' AF comes from their own spell
        expect(bard.some(t => t.endsWith('>Brigid'))).toBe(false);
        const druid = show(planBuffs('Brigid', g));
        expect(druid).toEqual(["Oak's Stoutness>Brigid", 'Major Bark Skin>Brigid', 'Dexterity of the Ferret>Brigid', "Hunter's Attack>Cuchulainn", 'Briarsprout>Cuchulainn']);
    });

    test('the Druid gives spec buffs, tank first; the Bard covers base buffs when she has none', () => {
        const specs = [...DRUID, conc('Enduring Strength', 'strcon', 6), conc('Swiftness of the Wild', 'dexqui', 6)];
        const druid = show(planBuffs('Brigid', group({}, specs)));
        expect(druid.slice(0, 5)).toEqual(['Enduring Strength>Cuchulainn', "Oak's Stoutness>Brigid", 'Major Bark Skin>Brigid', 'Enduring Strength>Brigid', 'Enduring Strength>Oisin']);
        expect(druid).toContain('Swiftness of the Wild>Niamh');
    });

    test('with the Bard dead, the Druid takes over his base buffs', () => {
        const g = group({ Oisin: { isDead: true } });
        expect(providerFor('str', g[0]!, g)?.name).toBe('Brigid');
        expect(show(planBuffs('Brigid', g))).toContain('Strength of the Redwood>Cuchulainn');
        expect(planBuffs('Oisin', g)).toEqual([]);
    });

    test('a slot already on the target is covered, whoever cast it', () => {
        const g = group({ Cuchulainn: { effects: ['Major Bark Skin'] } });
        const t = planBuffs('Oisin', g).find(x => x.target === 'Cuchulainn' && x.spell.slot === 'af')!;
        expect(t.covered).toBe(true);
        expect(t.ours).toBe(false);
    });
});

describe('concentration', () => {
    test('at 20 concentration effects (the server\'s cap) no concentration buff is next, a timed one still is; non-plan ones are dropped first', () => {
        const tasks = planBuffs('Oisin', group({ Oisin: { effects: ["Oak's Stoutness"] } }));
        expect(nextBuff(tasks, { current: 68, max: 70, effects: 19 })?.target).toBe('Cuchulainn');
        expect(nextBuff(tasks, { current: 68, max: 70, effects: 20 })).toBeNull();
        expect(nextBuff(planBuffs('Ciaran', group()), { current: 0, max: 0, effects: 20 })?.spell.name).toBe('Powerbarrier');
        const stray = { index: 0, concentration: 2, name: 'Stray Buff', ownerName: 'Cuchulainn' };
        const full = Array.from({ length: 20 }, (_, i) => ({ ...stray, index: i }));
        expect(surplusConcentration(tasks, full, { current: 68 }, group()).length).toBe(20);
        expect(surplusConcentration(tasks, full.slice(0, 19), { current: 68 }, group())).toEqual([]);
    });

    test('nextBuff takes the first task that fits, counts our active buffs and reserves room for ones waiting to retry', () => {
        const tasks = planBuffs('Oisin', group({ Oisin: { effects: ["Oak's Stoutness"] } }));
        expect(nextBuff(tasks, { current: 68, max: 70 })?.target).toBe('Cuchulainn');
        // Bark Skin on the tank waits to retry: its 2 stay reserved, the next task goes up.
        const waiting = (t: BuffTask) => t.target === 'Cuchulainn' && t.spell.slot === 'af';
        expect(show([nextBuff(tasks, { current: 68, max: 70 }, waiting)!])).toEqual(["Oak's Stoutness>Cuchulainn"]);
        // A pool of 4: Oak's Stoutness is ours (2), Bark Skin waits (2 reserved): nothing else fits.
        expect(nextBuff(tasks, { current: 2, max: 4 }, waiting)).toBeNull();
        // Timed buffs cost no concentration and always fit.
        expect(nextBuff(planBuffs('Ciaran', group()), { current: 0, max: 0 })?.spell.name).toBe('Powerbarrier');
    });

    test('surplus: the Druid drops her base buffs on the tank only when a task of hers lacks concentration', () => {
        const specs = [...DRUID, conc('Enduring Strength', 'strcon', 6)];
        const g = group({ Cuchulainn: { effects: ['Strength of the Redwood'] } }, specs);
        const tasks = planBuffs('Brigid', g);
        const active = [
            { index: 0, concentration: 3, name: 'Strength of ..', ownerName: 'Brigid' },
            { index: 1, concentration: 3, name: 'Strength of ..', ownerName: 'Cuchulainn' },
            { index: 2, concentration: 1, name: "Hunter's Att..", ownerName: 'Cuchulainn' },
            { index: 3, concentration: 0, name: 'Rhythm of Hi..', ownerName: 'Pulse: Rhyth..' },   // a song: never dropped
        ];
        expect(surplusConcentration(tasks, active, { current: 20 }, g)).toEqual([]);
        // Strength on herself isn't in her plan either (healers need no base str): both go, Hunter's Attack stays.
        expect(surplusConcentration(tasks, active, { current: 4 }, g).map(a => `${a.name}@${a.ownerName}`)).toEqual(['Strength of ..@Brigid', 'Strength of ..@Cuchulainn']);
    });
});

describe('leftover concentration on the pets', () => {
    // Ciaran with a window pet (an Enchanter's, say); the plan is Oisin's (base buffs) and Brigid's (the rest).
    const pet = { objectId: 900, name: 'underhill ally', level: 24, x: 0, y: 0, z: 0, hp: 100, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [] } as unknown as NonNullable<MemberReport['pet']>;
    const withPet = (over: Record<string, Partial<MemberReport>> = {}) => group({ ...over, Ciaran: { pet, ...over.Ciaran } });

    test('the last pass: after every member, concentration buffs only, from the slot provider by role', () => {
        const tasks = planBuffs('Oisin', withPet());
        const petTasks = tasks.filter(t => t.pet);
        expect(petTasks.length).toBeGreaterThan(0);
        expect(tasks.findIndex(t => t.pet)).toBe(tasks.length - petTasks.length);
        expect(petTasks.every(t => t.target === 'underhill ally' && t.pet!.owner === 'Ciaran' && t.pet!.objectId === 900 && t.spell.concentration > 0)).toBe(true);
        // A fighter's needs in order: the base buffs from the Bard, haste and the damage shield from the Druid.
        expect(petTasks.map(t => t.spell.slot)).toEqual(['af', 'con', 'str', 'dex']);
        expect(planBuffs('Brigid', withPet()).filter(t => t.pet).map(t => t.spell.slot)).toEqual(['haste', 'dmgshield']);
        expect(planBuffs('Oisin', withPet(), { petNeeds: [] }).some(t => t.pet)).toBe(false);
        expect(planBuffs('Oisin', group()).some(t => t.pet)).toBe(false);
    });

    test('on a pet is what our own list says', () => {
        const own = [{ name: "Oak's Stoutn..", ownerName: 'underhill ally' }];
        const t = planBuffs('Oisin', withPet(), { ownConc: own }).find(x => x.pet && x.spell.slot === 'con')!;
        expect(t.covered && t.ours).toBe(true);
    });

    test('never at the cost of a member: a member buff short of free concentration keeps its room', () => {
        // Everyone's buffs are up but Strength on the tank (3), and 3 are free: the pet's Oak's Stoutness (2) would leave 1.
        const all = planBuffs('Oisin', withPet());
        const tasks = all.map(t => (t.pet || (t.target === 'Cuchulainn' && t.spell.slot === 'str') ? t : { ...t, covered: true, ours: true }));
        expect(nextBuff(tasks, { current: 3, max: 70 })?.target).toBe('Cuchulainn');
        // 2 free: the tank's doesn't fit yet, and the pet's (2) would take its room.
        expect(nextBuff(tasks, { current: 2, max: 70 })).toBeNull();
        // The tank's waits a retry: its room is held, nothing for the pet.
        expect(nextBuff(tasks, { current: 4, max: 70 }, t => t.target === 'Cuchulainn')).toBeNull();
        // With room for both, the pet's comes once the member's is up.
        const up = tasks.map(t => (t.pet ? t : { ...t, covered: true, ours: true }));
        expect(nextBuff(up, { current: 10, max: 70 })?.pet?.owner).toBe('Ciaran');
    });

    test('surplus: our buffs on pets go first when a member buff lacks room, and only then', () => {
        const g = withPet();
        const tasks = planBuffs('Oisin', g);
        const active = [
            { index: 0, concentration: 2, name: "Oak's Stoutn..", ownerName: 'underhill ally' },
            { index: 1, concentration: 2, name: 'Stray Buff', ownerName: 'Cuchulainn' },
        ];
        expect(surplusConcentration(tasks, active, { current: 1 }, g).map(a => a.ownerName)).toEqual(['underhill ally']);
        const membersUp = tasks.map(t => (t.pet ? t : { ...t, covered: true, ours: true }));
        expect(surplusConcentration(membersUp, active, { current: 1 }, g).map(a => a.ownerName)).toEqual(['Cuchulainn']);
    });
});

describe('a member stripped of our buffs (dead and rezzed)', () => {
    test('held some, now none and some to go back up: stripped until they are back or the window ends', () => {
        const held = new Map<string, number>(), lost = new Map<string, number>();
        const up = planBuffs('Oisin', group({ Niamh: { effects: ["Oak's Stoutness", 'Dexterity of the Ferret'] } }));
        expect(strippedMembers(up, held, lost, 0)).toEqual(new Set());
        expect(held.get('Niamh')).toBe(2);
        // Dead: no tasks on her, nothing changes.
        expect(strippedMembers(planBuffs('Oisin', group({ Niamh: { isDead: true } })), held, lost, 1000)).toEqual(new Set());
        // Rezzed, bare: stripped, and still after one is back.
        expect(strippedMembers(planBuffs('Oisin', group()), held, lost, 2000)).toEqual(new Set(['Niamh']));
        expect(strippedMembers(planBuffs('Oisin', group({ Niamh: { effects: ["Oak's Stoutness"] } })), held, lost, 3000)).toEqual(new Set(['Niamh']));
        // All back: done.
        expect(strippedMembers(up, held, lost, 4000)).toEqual(new Set());
        expect(lost.size).toBe(0);
        // Never buffed by us (just joined): not stripped, the quiet phases see to it. Bare too long: the window ends.
        const h2 = new Map<string, number>(), l2 = new Map<string, number>();
        expect(strippedMembers(planBuffs('Oisin', group()), h2, l2, 0).size).toBe(0);
        strippedMembers(up, h2, l2, 0);
        expect(strippedMembers(planBuffs('Oisin', group()), h2, l2, 10).has('Niamh')).toBe(true);
        expect(strippedMembers(planBuffs('Oisin', group()), h2, l2, 20 + REBUFF_AFTER_LOSS_MS).has('Niamh')).toBe(false);
    });
});
