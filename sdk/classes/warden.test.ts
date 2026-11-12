import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { songKind } from '../group/songs';
import type { SpellPick } from '../group/spells';
import { rvrBehaviors } from '../group/rvr';
import type { Contact, MemberReport } from '../group/types';
import { EquipmentSlot, ObjectType } from '../types';
import { reachOfBuild } from './reach';
import { FOE, kitStyles, ME, seenBy, swing } from './style-fixtures';
import {
    angleOn, atHisSide, attackerOn, AWAY_LEG, awayLeg, BUBBLE_EVERY_MS, bladeturns, bubbleNow, DAMAGE_ADD_MISSING_MS, damageAdd, damageAddNow, FINISH_HP, GLOWING_BLADE,
    HEAL_GAP, HEAL_GAP_SNARED, LAST_STAND_ALONE, LAST_STAND_CHARGE, LAST_STAND_HEAL_HP, LAST_STAND_SEEN, lastStand, lastStandMove, onHerOwn, sideSpot, warden, wardenStyle,
} from './warden';

const build = () => reachOfBuild(getBuild('Warden', 'Support')!, 24);
/** A pick as the Spellbook makes it, from the build's known spells. */
const picks = (): SpellPick[] => build().known.map(k => ({
    spell: { name: k.name, level: k.level, cooldownRemaining: 0 }, type: k.info.type, target: k.info.target, range: k.info.range, radius: k.info.radius,
    power: k.info.power, castTime: k.info.castTime, duration: k.info.duration, recast: k.info.recastDelay ?? 0, concentration: k.info.concentration,
    pulse: (k.info.pulse ?? 0) > 0 && (k.info.frequency ?? 0) > 0, value: k.info.value ?? 0, damage: k.info.damage ?? 0, spellGroup: k.info.spellGroup ?? 0,
    damageType: k.info.damageType ?? 0, effectGroup: k.info.effectGroup ?? 0, frequency: k.info.frequency ?? 0, icon: k.info.icon ?? 0,
}) as unknown as SpellPick);

describe('warden kit', () => {
    test('at 24 her songs are the damage add, the speed chant and the endurance chant; damage is Nature\'s Retaliation', () => {
        const songs = picks().map(s => ({ s, kind: songKind(s) })).filter(x => x.kind);
        const best = (kind: string) => songs.filter(x => x.kind === kind).sort((a, b) => b.s.spell.level - a.s.spell.level)[0]?.s.spell.name;
        expect(best('damage')).toBe("Nature's Retaliation");
        expect(best('endurance')).toBe('Attack Unending');
        expect(best('speed')).toBe("Protector's Encouragement");
    });

    test('her bladeturns, the group one first', () => {
        expect(bladeturns(picks()).map(s => s.spell.name)).toEqual(["Nature's Shield", "Nature's Ward"]);
    });

    test('a bubble in a fight only when ours is gone, the fight is calm, nobody is on her, with power, and not too often', () => {
        const ok = { engaged: true, ownBubble: false, lowestHp: 90, aimedAt: false, manaPercent: 70, sinceLast: BUBBLE_EVERY_MS };
        expect(bubbleNow(ok)).toBe(true);
        expect(bubbleNow({ ...ok, engaged: false })).toBe(false);
        expect(bubbleNow({ ...ok, ownBubble: true })).toBe(false);
        expect(bubbleNow({ ...ok, lowestHp: 60 })).toBe(false);
        expect(bubbleNow({ ...ok, aimedAt: true })).toBe(false);
        expect(bubbleNow({ ...ok, manaPercent: 30 })).toBe(false);
        expect(bubbleNow({ ...ok, sinceLast: 5000 })).toBe(false);
    });

    test('damageAdd: never cast while its effect showed within 12 s, nor twice in 15 s', () => {
        const at = (o: Partial<Parameters<typeof damageAddNow>[0]>) => damageAddNow({ now: 100_000, seenAt: undefined, castAt: undefined, startedAt: 0, ready: true, ...o });
        expect(at({})).toBe(true);
        // A run's first 12 s: it may be pulsing from the round before.
        expect(at({ startedAt: 95_000 })).toBe(false);
        // Seen 6 s ago (the gap between two pulses that made song() cancel it in round 145): no cast.
        expect(at({ seenAt: 94_000 })).toBe(false);
        expect(at({ seenAt: 100_000 - DAMAGE_ADD_MISSING_MS })).toBe(true);
        expect(at({ castAt: 90_000 })).toBe(false);
        expect(at({ ready: false })).toBe(false);
    });

    test('damageAdd casts Nature\'s Retaliation, not her endurance chant', async () => {
        // The top rank per kind, as Spellbook.songs() gives them.
        const songs = picks().filter(s => songKind(s)).map(s => ({ ...s, kind: songKind(s)! }))
            .filter((s, _, all) => !all.some(o => o.kind === s.kind && o.spell.level > s.spell.level));
        const cast: string[] = [];
        const ctx: any = {
            spells: { songs: () => songs },
            memory: new Map<string, any>([['damageAddSince', 0]]),
            me: () => ({ attacking: false }),
            sdk: { getState: () => ({ effects: [] }) },
            bot: { isDead: () => false, castSpell: async (sp: { name: string }) => { cast.push(sp.name); return { success: true }; } },
            doing() {}, result() {},
        };
        expect(await damageAdd().run(ctx)).toBe(true);
        expect(cast).toEqual(["Nature's Retaliation"]);
        // Right after: no second cast, which would end the pulse.
        expect(await damageAdd().run(ctx)).toBe(false);
        expect(cast).toHaveLength(1);
    });

    test('in the pack\'s healer list: the group heal above her heals, the damage add and the bubble in her idle turns', () => {
        const list = withCharacter(packBehaviors().healer, warden()).map(b => b.name);
        expect(list.indexOf('groupHeal')).toBeLessThan(list.lastIndexOf('heal'));
        expect(list.indexOf('damageAdd')).toBeGreaterThan(list.lastIndexOf('heal'));
        expect(list.indexOf('bladeturn')).toBe(list.indexOf('damageAdd') + 1);
        expect(warden().role).toBe('healer');
    });
});

describe('warden last stand', () => {
    const styles = () => kitStyles('Warden', 'Support');
    const hands = [{ slot: EquipmentSlot.RightHand, objectType: ObjectType.Blades }, { slot: EquipmentSlot.LeftHand, objectType: ObjectType.Shield }];

    test('her styles at Blades 10 have Glowing Blade from the side, a 60 % snare', () => {
        const g = styles().find(s => s.name === 'Glowing Blade')!;
        expect(g.details!.position).toBe('side');
        expect(g.details!.procSpell?.description).toMatch(/SpeedDecrease/);
    });

    test('her swing at a player: Glowing Blade first, Taunting Blade behind; once it landed, not again until the snare runs out', () => {
        let t = 100_000;
        const style = wardenStyle(() => t);
        const pick = (seen: Parameters<typeof style>[0]) => style(seen) as string[];
        expect(pick(seenBy(styles(), hands))).toEqual(['Glowing Blade', 'Taunting Blade']);
        const landed = seenBy(styles(), hands, { events: [swing(ME, FOE, 'styledHit', t)], messages: ['You perform your Glowing Blade perfectly!'] });
        // fighterStyle's likely reaction (Return Blade, after his parry) may go first; never Glowing Blade.
        expect(pick(landed)).not.toContain('Glowing Blade');
        expect(pick(landed)).toContain('Taunting Blade');
        t += GLOWING_BLADE.lastsMs + 1;
        expect(pick(landed)[0]).toBe('Glowing Blade');
    });

    test('lastStandMove: in a group nothing; on her own she closes and swings, heals from out of reach, and with him snared gets away or fights it out', () => {
        const on = { alone: true, distance: 120, snared: false, myHp: 60, hisHp: 90, canHeal: true };
        expect(lastStandMove({ ...on, alone: false })).toBe(null);
        expect(lastStandMove({ ...on, distance: null })).toBe(null);
        // Not snared: swing (Glowing Blade first), even hurt: a cast in his reach is interrupted.
        expect(lastStandMove(on)).toBe('swing');
        expect(lastStandMove({ ...on, distance: LAST_STAND_CHARGE })).toBe('swing');
        // A caster on her from afar: heal when hurt, else the list goes on.
        expect(lastStandMove({ ...on, distance: HEAL_GAP })).toBe('heal');
        expect(lastStandMove({ ...on, distance: HEAL_GAP, myHp: 90 })).toBe(null);
        expect(lastStandMove({ ...on, distance: HEAL_GAP, canHeal: false })).toBe(null);
        // Snared: a heal once he is HEAL_GAP_SNARED off.
        expect(lastStandMove({ ...on, snared: true, distance: HEAL_GAP_SNARED })).toBe('heal');
        // Too near for a heal: weaker than him she gets away, as healthy as he is she fights, and he low she finishes him.
        expect(lastStandMove({ ...on, snared: true })).toBe('away');
        expect(lastStandMove({ ...on, snared: true, myHp: 90 })).toBe('swing');
        expect(lastStandMove({ ...on, snared: true, hisHp: FINISH_HP })).toBe('swing');
        // Healed (70 % or more) and still behind him: away, out of his snared reach.
        expect(lastStandMove({ ...on, snared: true, myHp: LAST_STAND_HEAL_HP, distance: 900 })).toBe('away');
    });

    test('on her own: no other member alive in our region within 2000', () => {
        const me = { name: 'Aine', x: 0, y: 0, regionId: 252 };
        const m = (name: string, x: number, o: Partial<MemberReport> = {}) => ({ name, x, y: 0, regionId: 252, isDead: false, ...o }) as MemberReport;
        expect(onHerOwn(me, [m('Aine', 0)])).toBe(true);
        expect(onHerOwn(me, [m('Aine', 0), m('Fionn', 300)])).toBe(false);
        expect(onHerOwn(me, [m('Aine', 0), m('Fionn', 300, { isDead: true })])).toBe(true);
        expect(onHerOwn(me, [m('Aine', 0), m('Fionn', LAST_STAND_ALONE + 1)])).toBe(true);
        expect(onHerOwn(me, [m('Aine', 0), m('Fionn', 300, { regionId: 51 })])).toBe(true);
    });

    test('the attacker on her: the nearest free enemy player targeting her', () => {
        const me = { name: 'Aine', x: 0, y: 0, regionId: 252 };
        const c = (objectId: number, x: number, o: Partial<Contact> = {}) => ({ objectId, kind: 'player', x, y: 0, regionId: 252, hp: 90, stale: false, cc: null, target: 'Aine', ...o }) as Contact;
        expect(attackerOn(me, [c(1, 600), c(2, 100)])?.objectId).toBe(2);
        expect(attackerOn(me, [c(2, 100, { target: 'Fionn' })])).toBe(null);
        expect(attackerOn(me, [c(2, 100, { cc: { by: 'x', kind: 'mezz', until: Infinity } })])).toBe(null);
        expect(attackerOn(me, [c(2, 100, { stale: true })])).toBe(null);
        expect(attackerOn(me, [c(2, 100, { hp: 0 })])).toBe(null);
        expect(attackerOn(me, [c(2, 100, { kind: 'npc' })])).toBe(null);
        expect(attackerOn(me, [c(2, LAST_STAND_SEEN + 1)])).toBe(null);
    });

    test('his side, by the server\'s angles: a step to the spot square to his heading puts her there', () => {
        // He faces +y (heading 0 points at +y: pointFromHeading), she in front of him.
        const him = { x: 0, y: 0, heading: 0 };
        const front = { x: 0, y: 100 };
        expect(atHisSide(angleOn(him, front))).toBe(false);
        expect(atHisSide(angleOn(him, { x: 0, y: -100 }))).toBe(false);
        const to = sideSpot(him, { x: 30, y: 100 });
        expect(Math.round(Math.hypot(to.x, to.y))).toBe(90);
        expect(atHisSide(angleOn(him, to))).toBe(true);
        // The nearer side: she stands at +x, so the spot is at +x.
        expect(to.x).toBeGreaterThan(0);
        expect(sideSpot(him, { x: -30, y: 100 }).x).toBeLessThan(0);
    });

    test('away from him, the straightest dry leg', () => {
        const me = { x: 1000, y: 0 }, him = { x: 900, y: 0 };
        expect(awayLeg(me, him, () => false)).toEqual({ x: 1500, y: 0 });
        // Water straight ahead (east): 45 degrees off.
        const leg = awayLeg(me, him, p => p.x > 1450 && Math.abs(p.y) < 50)!;
        expect(Math.abs(Math.hypot(leg.x - me.x, leg.y - me.y) - AWAY_LEG)).toBeLessThan(2);
        expect(leg.x).toBeGreaterThan(me.x);
        expect(Math.abs(leg.y)).toBeGreaterThan(300);
        expect(awayLeg(me, him, () => true)).toBe(null);
    });

    const fake = (o: { members?: MemberReport[]; hp?: number; hisHp?: number; at?: number; events?: any[]; messages?: string[] }) => {
        const did: string[] = [];
        const me = { objectId: ME, x: 0, y: 0, z: 0, regionId: 252, healthPercent: o.hp ?? 60, health: 360, maxHealth: 600, attacking: false };
        const him = { objectId: FOE, name: 'Highlander', kind: 'player', x: o.at ?? 120, y: 0, regionId: 252, hp: o.hisHp ?? 90, stale: false, cc: null, target: 'Aine' } as unknown as Contact;
        const ctx: any = {
            name: 'Aine',
            me: () => me,
            members: () => o.members ?? [{ name: 'Aine', x: 0, y: 0, regionId: 252, isDead: false }, { name: 'Fionn', x: 50, y: 0, regionId: 252, isDead: true }],
            picture: () => ({ contacts: [him] }),
            orders: () => ({ phase: 'engage', focus: 77 }),
            contact: (id: number) => (id === FOE ? him : undefined),
            spells: { heal: () => ({ spell: { name: 'Major Regeneration' }, castTime: 3.2 }) },
            memory: new Map<string, any>(),
            sdk: {
                getState: () => ({ combatEvents: o.events ?? [], gameMessages: (o.messages ?? []).map(text => ({ text })), equipment: hands }),
                getNearbyNpc: () => null, getNearbyPlayer: () => null, getSkills: () => ({ styles: styles() }), sendAttack: async () => ({}),
            },
            bot: {
                isDead: () => false,
                castSpell: async (sp: { name: string }, target: number) => { did.push(`cast ${sp.name} on ${target}`); return { success: true }; },
                walkTo: async (x: number, y: number) => { did.push(`walk ${x},${y}`); return { success: true }; },
            },
            doing() {}, result() {},
        };
        const swing = { name: 'assistMelee', async run(c: any) { did.push(`swing at ${c.orders().focus} (${c.focus().name})`); return true; } };
        return { ctx, did, swing };
    };

    test('with a member of hers alive near: nothing, the healer list goes on', async () => {
        const f = fake({ members: [{ name: 'Aine', x: 0, y: 0, regionId: 252, isDead: false } as MemberReport, { name: 'Fionn', x: 300, y: 0, regionId: 252, isDead: false } as MemberReport] });
        expect(await lastStand({ swing: f.swing as never }).run(f.ctx)).toBe(false);
        expect(f.did).toEqual([]);
    });

    test('her partner dead, a Highlander on her: she swings at him, whatever the focus', async () => {
        const f = fake({});
        expect(await lastStand({ swing: f.swing as never }).run(f.ctx)).toBe(true);
        expect(f.did).toEqual([`swing at ${FOE} (Highlander)`]);
    });

    test('Glowing Blade landed, she hurt and behind him: a leg away; from 450 off a heal on herself', async () => {
        const t = 100_000;
        const landed = { events: [swing(ME, FOE, 'styledHit', t - 1000)], messages: ['You perform your Glowing Blade perfectly!'] };
        let f = fake({ ...landed });
        expect(await lastStand({ now: () => t, swing: f.swing as never }).run(f.ctx)).toBe(true);
        expect(f.did).toEqual([`walk ${-AWAY_LEG},0`]);
        f = fake({ ...landed, at: HEAL_GAP_SNARED });
        expect(await lastStand({ now: () => t, swing: f.swing as never }).run(f.ctx)).toBe(true);
        expect(f.did).toEqual([`cast Major Regeneration on ${ME}`]);
        // Healthier than him: she fights it out.
        f = fake({ ...landed, hp: 95, hisHp: 60 });
        expect(await lastStand({ now: () => t, swing: f.swing as never }).run(f.ctx)).toBe(true);
        expect(f.did).toEqual([`swing at ${FOE} (Highlander)`]);
    });

    test('in the squads\' healer list: above flee, below the emergency heal (which skips while a melee is on her)', () => {
        const list = withCharacter(rvrBehaviors().healer, warden()).map(b => b.name);
        expect(list.indexOf('lastStand')).toBe(list.indexOf('flee') - 1);
        expect(list.indexOf('emergencyHeal')).toBeLessThan(list.indexOf('lastStand'));
        expect(withCharacter(rvrBehaviors().healer, warden({ lastStand: false })).map(b => b.name)).not.toContain('lastStand');
    });
});
