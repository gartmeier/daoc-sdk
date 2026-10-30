import { describe, expect, test } from 'bun:test';
import { nextBuff, planBuffs, providerFor, surplusConcentration, type BuffTask } from './buffs';
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
