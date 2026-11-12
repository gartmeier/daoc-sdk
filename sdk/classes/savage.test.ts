import { describe, expect, test } from 'bun:test';
import { getSpell } from '../../data/index';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { STUN_IMMUNE_MS } from './hero';
import { kitStyle } from './hybrid';
import { reachOfBuild } from './reach';
import { KELGOR_TYPES, savage, SAVAGE_OPENER, savageStyle } from './savage';
import { FOE, KIT_WEAPONS, kitStyles, ME, seenBy, swing } from './style-fixtures';

const styles = kitStyles('Savage', 'Hand to Hand first');
const claws = KIT_WEAPONS.Savage;

describe('savage kit', () => {
    test('Clan\'s Call and Clan\'s Might are 4 s and 5 s stuns in reach at 24', () => {
        const reached = reachOfBuild(getBuild('Savage', 'Hand to Hand first')!, 24).styles;
        for (const [name, ms] of Object.entries({ [SAVAGE_OPENER.name]: SAVAGE_OPENER.lastsMs, ...SAVAGE_OPENER.others })) {
            const sp = getSpell(reached.find(s => s.name === name)!.procs![0]!.spellId)!;
            expect([sp.type, sp.duration * 1000]).toEqual(['StyleStun', ms]);
        }
    });

    test('the Kelgor buffs he keeps in a fight are attack speed and damage, both in reach at 24', () => {
        const r = reachOfBuild(getBuild('Savage', 'Hand to Hand first')!, 24);
        expect([...new Set(r.known.filter(k => KELGOR_TYPES.has(k.info.type)).map(k => k.info.type))].sort()).toEqual(['SavageCombatSpeedBuff', 'SavageDPSBuff']);
        // buff() keeps none of them up (Spellbook.buffs leaves Savage buffs out).
        expect(r.buffs.filter(b => /^Savage/.test(b.type))).toEqual([]);
    });

    test('a melee with kelgor above its fight, in every list', () => {
        expect(savage().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], savage()).map(b => b.name);
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
            expect(list.indexOf('kelgor')).toBeLessThan(list.indexOf('assistMelee'));
        }
    });

    test('at a player: Clan\'s Call first, Wild Call\'s damage behind it; after a parry the earned reaction is the backup', () => {
        expect(savageStyle(seenBy(styles, claws))).toEqual(["Clan's Call", 'Wild Call']);
        expect(savageStyle(seenBy(styles, claws, { events: [swing(FOE, ME, 'parry', Date.now())] }))).toEqual(["Clan's Call", 'Tribal Rage']);
    });

    test('after the stun landed: Clan\'s Might follows, and no Clan\'s Call for the immunity', () => {
        const now = Date.now();
        let clock = now;
        const landed = seenBy(styles, claws, { events: [swing(ME, FOE, 'styledHit', now)], messages: ["You perform your Clan's Call perfectly!"] });
        const fresh = kitStyle({ openers: [SAVAGE_OPENER], now: () => clock });
        expect(fresh(landed)).toEqual(["Clan's Might", 'Wild Call']);
        const later = seenBy(styles, claws, { events: [swing(ME, FOE, 'hit', now + 1000)] });
        clock = now + 30_000;
        expect((fresh(later) as string[])[0]).not.toBe("Clan's Call");
        clock = now + SAVAGE_OPENER.lastsMs + STUN_IMMUNE_MS + 1;
        expect((fresh(later) as string[])[0]).toBe("Clan's Call");
    });

    test('a monster gets the fighter\'s pick: no stun opener', () => {
        expect((savageStyle(seenBy(styles, claws, { kind: 'npc' })) as string[])[0]).not.toBe("Clan's Call");
    });
});
