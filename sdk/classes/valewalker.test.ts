import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { STUN_IMMUNE_MS } from './hero';
import { kitStyle } from './hybrid';
import { reachOfBuild } from './reach';
import { FOE, KIT_WEAPONS, kitStyles, ME, seenBy, swing } from './style-fixtures';
import { valewalker, VALEWALKER_OPENER, valewalkerStyle } from './valewalker';

const build = reachOfBuild(getBuild('Valewalker', 'Scythe first')!, 24);
const styles = kitStyles('Valewalker', 'Scythe first');
const scythe = KIT_WEAPONS.Valewalker;

describe('valewalker kit', () => {
    test('Stunning Blade is a 5 s stun in reach at 24; Alacrity of Kudzu and Conceal Path are instants he knows', () => {
        const sp = getSpell(build.styles.find(s => s.name === VALEWALKER_OPENER.name)!.procs![0]!.spellId)!;
        expect([sp.type, sp.duration * 1000]).toEqual(['StyleStun', VALEWALKER_OPENER.lastsMs]);
        const haste = build.known.filter(k => k.info.type === 'CombatSpeedBuff').at(-1)!;
        expect([haste.name, haste.info.castTime]).toEqual(['Alacrity of Kudzu', 0]);
        const snare = build.known.filter(k => k.info.type === 'SpeedDecrease').at(-1)!;
        expect([snare.name, snare.info.castTime, snare.info.target]).toEqual(['Conceal Path', 0, 'Enemy']);
    });

    test('buff() keeps his armour up, never the haste: it would be on its timer when the fight came', () => {
        const kept = build.buffs.map(b => b.spell.name);
        expect(kept).toContain("Grove's Armor");
        expect(kept.some(n => /Kudzu/.test(n))).toBe(false);
    });

    test('a melee: haste and snare above its fight, the procs below it, in every list', () => {
        expect(valewalker().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], valewalker()).map(b => b.name);
            const fight = list.indexOf('assistMelee');
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
            expect(list.indexOf('kudzu')).toBeLessThan(fight);
            expect(list.indexOf('snareFocus')).toBeLessThan(fight);
            expect(list.indexOf('keepProc')).toBeGreaterThan(fight);
        }
    });

    test("at a player: Stunning Blade with Taunting Scythe's damage behind (Reaper is 11 for 15 endurance)", () => {
        expect(valewalkerStyle(seenBy(styles, scythe))).toEqual(['Stunning Blade', 'Taunting Scythe']);
        expect(valewalkerStyle(seenBy(styles, scythe, { events: [swing(FOE, ME, 'parry', Date.now())] }))).toEqual(['Stunning Blade', 'Sawgrass']);
    });

    test("after the stun: Winter's Scythe follows, then the parry chain until the immunity is over", () => {
        const now = Date.now();
        let clock = now;
        const pick = kitStyle({ openers: [VALEWALKER_OPENER], now: () => clock });
        expect(pick(seenBy(styles, scythe, { events: [swing(ME, FOE, 'styledHit', now)], messages: ['You perform your Stunning Blade perfectly!'] }))).toEqual(["Winter's Scythe", 'Taunting Scythe']);
        const parried = seenBy(styles, scythe, { events: [swing(ME, FOE, 'hit', now + 500), swing(FOE, ME, 'parry', now + 1000, 2)] });
        clock = now + 20_000;
        expect(pick(parried)).toEqual(['Sawgrass', 'Taunting Scythe']);
        clock = now + VALEWALKER_OPENER.lastsMs + STUN_IMMUNE_MS + 1;
        expect((pick(parried) as string[])[0]).toBe('Stunning Blade');
    });
});
