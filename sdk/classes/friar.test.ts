import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { isGroupHeal } from './druid';
import { friar } from './friar';
import { reachOfBuild } from './reach';

const tuck = () => reachOfBuild(getBuild('Friar', 'Group support')!, 24);

describe('the friar kit', () => {
    test('Angelic Commendation is his group heal, and heal never picks it', () => {
        const r = tuck();
        const group = r.known.filter(k => isGroupHeal({ type: k.info.type, target: k.info.target, radius: k.info.radius ?? 0, pulse: !!k.info.pulse } as never));
        expect(group.map(k => k.name)).toEqual(['Angelic Commendation']);
        expect(r.heals.map(h => h.spell.name)).not.toContain('Angelic Commendation');
        expect(r.unused.map(u => u.name)).toContain('Angelic Commendation');
    });

    test('Saint\'s Vigor is the endurance song song() plays; he has no cc, nuke or instant heal', () => {
        const r = tuck();
        expect(r.songs.map(s => `${s.kind}:${s.spell.name}`)).toEqual(["endurance:Saint's Vigor"]);
        expect(r.cc).toBeNull();
        expect(r.nukes).toEqual([]);
        expect(r.heals.every(h => h.castTime > 0)).toBe(true);
    });

    test('in the RvR healer list: heal first, then the group heal, the walk and the chant', () => {
        const list = withCharacter(rvrBehaviors().healer, friar()).map(b => b.name);
        const at = (n: string) => list.indexOf(n);
        expect(at('heal')).toBeLessThan(at('groupHeal'));
        expect(at('groupHeal')).toBe(at('reachHurt') - 1);
        expect(at('reachHurt')).toBe(at('song') - 1);
        expect(at('song')).toBeLessThan(at('buff'));
        expect(withCharacter(rvrBehaviors().healer, friar({ chant: false })).map(b => b.name)).not.toContain('song');
    });

    test('in the pack\'s healer list too, below its heals', () => {
        const list = withCharacter(packBehaviors().healer, friar()).map(b => b.name);
        expect(list.indexOf('heal')).toBeLessThan(list.indexOf('groupHeal'));
        expect(list).toContain('song');
    });
});
