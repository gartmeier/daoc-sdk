import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { songKind } from '../group/songs';
import type { SpellPick } from '../group/spells';
import { reachOfBuild } from './reach';
import { BUBBLE_EVERY_MS, bladeturns, bubbleNow, damageAdd, warden } from './warden';

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

    test('damageAdd: in a fight it starts the damage chant even when song() would pick endurance', async () => {
        // The top rank per kind, as Spellbook.songs() gives them.
        const songs = picks().filter(s => songKind(s)).map(s => ({ ...s, kind: songKind(s)! }))
            .filter((s, _, all) => !all.some(o => o.kind === s.kind && o.spell.level > s.spell.level));
        const cast: string[] = [];
        const memory = new Map<string, any>([['songSince', 0]]);
        const ctx: any = {
            spells: { songs: () => songs },
            memory,
            orders: () => ({ phase: 'engage', cc: [] }),
            members: () => [],
            me: () => ({ endurancePercent: 20, attacking: false }),
            settings: {},
            sdk: { getState: () => ({ effects: [] }) },
            bot: { isDead: () => false, castSpell: async (sp: { name: string }) => { cast.push(sp.name); return { success: true }; } },
            doing() {}, result() {},
        };
        expect(await damageAdd().run(ctx)).toBe(true);
        expect(cast).toEqual(["Nature's Retaliation"]);
    });

    test('in the pack\'s healer list: the group heal above her heals, the damage add and the bubble in her idle turns', () => {
        const list = withCharacter(packBehaviors().healer, warden()).map(b => b.name);
        expect(list.indexOf('groupHeal')).toBeLessThan(list.lastIndexOf('heal'));
        expect(list.indexOf('damageAdd')).toBeGreaterThan(list.lastIndexOf('heal'));
        expect(list.indexOf('bladeturn')).toBe(list.indexOf('damageAdd') + 1);
        expect(warden().role).toBe('healer');
    });
});
