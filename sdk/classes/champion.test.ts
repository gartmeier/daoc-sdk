import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { champion, CHAMPION_OPENER, championStyle } from './champion';
import { kitStyle } from './hybrid';
import { reachOfBuild } from './reach';
import { FOE, KIT_WEAPONS, kitStyles, ME, seenBy, swing } from './style-fixtures';

const build = reachOfBuild(getBuild('Champion', 'Valor and Large Weapons')!, 24);
const styles = kitStyles('Champion', 'Valor and Large Weapons');
const sword = KIT_WEAPONS.Champion;

describe('champion kit', () => {
    test('Frontal Assault is a 19 s snare in reach at 24; Blast of Defiance an instant the shared interrupt casts', () => {
        const sp = getSpell(build.styles.find(s => s.name === CHAMPION_OPENER.name)!.procs![0]!.spellId)!;
        expect([sp.type, sp.duration * 1000]).toEqual(['StyleSpeedDecrease', CHAMPION_OPENER.lastsMs]);
        expect(build.nukes.map(n => [n.spell.name, n.castTime])).toContainEqual(['Blast of Defiance', 0]);
        const snare = build.known.filter(k => k.info.type === 'SpeedDecrease').at(-1)!;
        expect([snare.name, snare.info.castTime]).toEqual(['Lumber', 0]);
        expect(build.known.filter(k => k.info.type === 'StrengthConstitutionDebuff').at(-1)!.name).toBe('Enervation');
    });

    test('a melee: interrupt above flee, snare and debuff above its fight, in every list', () => {
        expect(champion().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], champion()).map(b => b.name);
            const fight = list.indexOf('assistMelee');
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
            expect(list.indexOf('interrupt')).toBeLessThan(fight);
            const flee = list.indexOf('flee');
            if (flee >= 0) expect(list.indexOf('interrupt')).toBeLessThan(flee);
            expect(list.indexOf('snareFocus')).toBeLessThan(fight);
            expect(list.indexOf('enervate')).toBeLessThan(fight);
        }
    });

    test("at a player: Frontal Assault with Celtic Fury's damage behind; after a parry the earned Celtic Rage is the backup", () => {
        expect(championStyle(seenBy(styles, sword))).toEqual(['Frontal Assault', 'Celtic Fury']);
        expect(championStyle(seenBy(styles, sword, { events: [swing(FOE, ME, 'parry', Date.now())] }))).toEqual(['Frontal Assault', 'Celtic Rage']);
    });

    test('the snare again once it has run out, with no immunity in between', () => {
        const now = Date.now();
        let clock = now;
        const pick = kitStyle({ openers: [CHAMPION_OPENER], now: () => clock });
        const landed = seenBy(styles, sword, { events: [swing(ME, FOE, 'styledHit', now)], messages: ['You perform your Frontal Assault perfectly!'] });
        expect((pick(landed) as string[])[0]).not.toBe('Frontal Assault');
        clock = now + CHAMPION_OPENER.lastsMs + 1;
        expect((pick(landed) as string[])[0]).toBe('Frontal Assault');
    });

    test("a monster gets the fighter's pick", () => {
        expect((championStyle(seenBy(styles, sword, { kind: 'npc' })) as string[])[0]).toBe('Celtic Rage');
    });
});
