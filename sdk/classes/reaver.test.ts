import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { enemy } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { STUN_IMMUNE_MS } from './hero';
import { kitStyle } from './hybrid';
import { reachOfBuild } from './reach';
import { auraNow, reaver, REAVER_OPENER, reaverStyle } from './reaver';
import { FOE, KIT_WEAPONS, kitStyles, ME, seenBy, swing } from './style-fixtures';

const build = reachOfBuild(getBuild('Reaver', 'Flex, shield and tap')!, 24);
const styles = kitStyles('Reaver', 'Flex, shield and tap');
const flex = KIT_WEAPONS.Reaver;

describe('reaver kit', () => {
    test('every stun it counts is a StyleStun of that length in reach at 24', () => {
        for (const [name, ms] of Object.entries({ [REAVER_OPENER.name]: REAVER_OPENER.lastsMs, ...REAVER_OPENER.others })) {
            const sp = getSpell(build.styles.find(s => s.name === name)!.procs![0]!.spellId)!;
            expect([name, sp.type, sp.duration * 1000]).toEqual([name, 'StyleStun', ms]);
        }
    });

    test('Vitality Siphon is an instant single-target lifedrain; Surge stays out of buff(), Credit to Arawn has no slot there', () => {
        const siphon = build.known.filter(k => k.info.type === 'Lifedrain').at(-1)!;
        expect([siphon.name, siphon.info.castTime, siphon.info.radius ?? 0]).toEqual(['Vitality Siphon', 0, 0]);
        expect(build.buffs.some(b => /^Surge of/.test(b.spell.name))).toBe(false);
        expect(build.buffs.some(b => b.type === 'OffensiveProc')).toBe(false);
        expect(build.known.some(k => k.info.type === 'OffensiveProc')).toBe(true);
    });

    test('a melee: interrupt above flee, surge and aura above its fight, the proc below it, in every list', () => {
        expect(reaver().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], reaver()).map(b => b.name);
            const fight = list.indexOf('assistMelee');
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
            expect(list.indexOf('interrupt')).toBeLessThan(fight);
            const flee = list.indexOf('flee');
            if (flee >= 0) expect(list.indexOf('interrupt')).toBeLessThan(flee);
            expect(list.indexOf('surge')).toBeLessThan(fight);
            expect(list.indexOf('aura')).toBeLessThan(fight);
            expect(list.indexOf('keepProc')).toBeGreaterThan(fight);
        }
    });

    test("at a player: Disable from the side with Diamondback's damage behind; after a block Viper is the backup", () => {
        expect(reaverStyle(seenBy(styles, flex))).toEqual(['Disable', 'Diamondback']);
        expect(reaverStyle(seenBy(styles, flex, { events: [swing(FOE, ME, 'block', Date.now())] }))).toEqual(['Disable', 'Viper']);
    });

    test('a landed Viper starts the immunity: no Disable until it is over, Copperhead follows', () => {
        const now = Date.now();
        let clock = now;
        const pick = kitStyle({ openers: [REAVER_OPENER], now: () => clock });
        const landed = seenBy(styles, flex, { events: [swing(ME, FOE, 'styledHit', now)], messages: ['You perform your Viper perfectly!'] });
        expect(pick(landed)).toEqual(['Copperhead', 'Diamondback']);
        clock = now + 30_000;
        expect((pick(landed) as string[])[0]).not.toBe('Disable');
        clock = now + 5000 + STUN_IMMUNE_MS + 1;
        expect((pick(landed) as string[])[0]).toBe('Disable');
    });

    test('the aura only on two enemy players in reach, and never near crowd control', () => {
        const me = { x: 0, y: 0, regionId: 1 };
        const at = (id: number, x: number, over = {}) => enemy(id, 'midgard', { x, y: 0, regionId: 1, ...over });
        expect(auraNow(me, [at(1, 100), at(2, 200)])).toBe(true);
        expect(auraNow(me, [at(1, 100)])).toBe(false);
        expect(auraNow(me, [at(1, 100), at(2, 500)])).toBe(false);
        expect(auraNow(me, [at(1, 100), at(2, 200), at(3, 600, { cc: { by: 'x', kind: 'mezz', until: 9e12 } })])).toBe(false);
        expect(auraNow(me, [at(1, 100), at(2, 200, { isPet: true })])).toBe(false);
    });
});
