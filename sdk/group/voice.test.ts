// The voice (voice.ts): the rate limits, the group's lines from its picture, the realm's from the director.
import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { countWords, foeLabel, GroupVoice, placeName, regionClaims, RegionVoice, Voice, type Claim, type RegionInput } from './voice';

/** Hear a picture every 500 ms up to `until`; the lines said. */
const ticks = (v: GroupVoice, at: (t: number) => ReturnType<typeof picture>, until: number) => {
    const out: string[] = [];
    for (let t = 0; t <= until; t += 500) { const l = v.hear(at(t)); if (l) out.push(l.text); }
    return out;
};
const claim = (key: string, over: Partial<Claim> = {}): Claim => ({ key, text: key, prio: 10, settleMs: 0, cooldownMs: 60_000, ...over });

describe('Voice', () => {
    test('says a claim once it has held its settle time', () => {
        const v = new Voice();
        const c = claim('a', { settleMs: 1500 });
        expect(v.offer([c], 0)).toBeNull();
        expect(v.offer([c], 1000)).toBeNull();
        expect(v.offer([c], 1600)?.text).toBe('a');
    });
    test('a claim that flickers away starts settling again', () => {
        const v = new Voice();
        const c = claim('a', { settleMs: 1500 });
        v.offer([c], 0);
        v.offer([], 3000);
        expect(v.offer([c], 3500)).toBeNull();
        expect(v.offer([c], 5100)?.text).toBe('a');
    });
    test('the gap, the cooldown and the same text', () => {
        const v = new Voice();
        expect(v.offer([claim('a')], 0)?.text).toBe('a');
        expect(v.offer([claim('a'), claim('b')], 1000)).toBeNull();
        expect(v.offer([claim('a'), claim('b')], 4000)?.text).toBe('b');
        // Another key, the same words: not within textMs.
        expect(v.offer([claim('c', { text: 'a' })], 8000)).toBeNull();
        expect(v.offer([claim('c', { text: 'a' })], 21_000)?.text).toBe('a');
    });
    test('highest priority first; urgent skips the cap and takes the short gap', () => {
        const v = new Voice();
        expect(v.offer([claim('low'), claim('high', { prio: 50 })], 0)?.text).toBe('high');
        expect(v.offer([claim('u', { urgent: true })], 1600)?.text).toBe('u');
        let t = 2000;
        for (let i = 0; i < 10; i++) v.offer([claim(`n${i}`)], t += 4000);
        expect(v.lines.filter(l => l.at > 2000 && l.at < 62_000).length).toBeLessThanOrEqual(6);
        expect(v.offer([claim('urgent2', { urgent: true })], t + 1600)?.text).toBe('urgent2');
    });
});

describe('words', () => {
    test('counts by realm', () => {
        expect(countWords({ midgard: 1 })).toBe('1 mid');
        expect(countWords({ midgard: 6 })).toBe('6 mids');
        expect(countWords({ albion: 2, midgard: 4 })).toBe('4 mids and 2 albs');
    });
    test('a foe by its class once the read agrees, else its race', () => {
        expect(foeLabel(enemy(1, 'hibernia'))).toBe('Celt');
        expect(foeLabel(enemy(1, 'albion', { classGuess: { classes: ['Cleric', 'Friar'], p: [0.7, 0.3], basis: [] } }))).toBe('Cleric');
        expect(foeLabel(enemy(1, 'albion', { classGuess: { classes: ['Cleric', 'Friar'], p: [0.5, 0.5], basis: [] } }))).toBe('Briton');
    });
    test('places in Thidranki', () => {
        expect(placeName({ x: 18362, y: 18257 }, 'hibernia')).toBe('at our PK');
        expect(placeName({ x: 54053, y: 24680 }, 'hibernia')).toBe('at the mid PK');
        expect(placeName({ x: 30400, y: 34750 }, 'hibernia')).toBe('at our bridge');
        expect(placeName({ x: 38600, y: 36125 }, 'hibernia')).toBe('at the mid bridge');
        expect(placeName({ x: 33089, y: 38271 }, 'albion')).toBe('at the Faste');
        expect(placeName({ x: 33000, y: 25000 }, 'albion')).toBe('north of the Faste');
        expect(placeName({ x: 21000, y: 45000 }, 'albion')).toBe("south-west of the Faste");
        expect(placeName({ x: 47000, y: 29000 }, 'albion')).toBe('near the mid PK');
    });
});

describe('group chat', () => {
    const team = () => [report('Gawain', { role: 'tank' }), report('Tuck', { role: 'healer', capabilities: { heal: true, cc: false, nuke: false, rez: true, buffs: [], buffSpells: [] } }), report('Merlin')];
    const gv = () => new GroupVoice({ speaker: 'Gawain', realm: 'albion' });

    test('going in names the focus, and only once the decision holds', () => {
        const v = gv();
        const foe = enemy(425, 'hibernia', { classGuess: { classes: ['Druid'], p: [0.8], basis: [] } });
        expect(v.hear(picture(team(), [foe], { phase: 'engage', focus: 425 }, 0))).toBeNull();
        expect(v.hear(picture(team(), [foe], { phase: 'engage', focus: 425 }, 1000))).toBeNull();
        expect(v.hear(picture(team(), [foe], { phase: 'engage', focus: 425 }, 1600))?.text).toBe('going in, focus the Druid');
        // Held: not again.
        expect(v.hear(picture(team(), [foe], { phase: 'engage', focus: 425 }, 9000))).toBeNull();
    });
    test('a switch while in the fight; a flicker is never said', () => {
        const v = gv();
        const a = enemy(1, 'hibernia'), b = enemy(2, 'hibernia', { name: 'Lurikeen' });
        v.hear(picture(team(), [a, b], { phase: 'engage', focus: 1 }, 0));
        expect(v.hear(picture(team(), [a, b], { phase: 'engage', focus: 1 }, 1600))?.text).toBe('going in, focus the Celt');
        // b for one second, back to a: nothing.
        expect(v.hear(picture(team(), [a, b], { phase: 'engage', focus: 2 }, 5000))).toBeNull();
        expect(v.hear(picture(team(), [a, b], { phase: 'engage', focus: 1 }, 6000))).toBeNull();
        v.hear(picture(team(), [a, b], { phase: 'engage', focus: 2 }, 8000));
        expect(v.hear(picture(team(), [a, b], { phase: 'engage', focus: 2 }, 9600))?.text).toBe('switch, focus the Lurikeen');
    });
    test('pulling back comes first and fast', () => {
        const v = gv();
        const a = enemy(1, 'midgard');
        v.hear(picture(team(), [a], { phase: 'retreat', retreatTo: { x: 37301, y: 52362, z: 0 } }, 0));
        expect(v.hear(picture(team(), [a], { phase: 'retreat', retreatTo: { x: 37301, y: 52362, z: 0 } }, 900))?.text).toBe('pulling back to our PK, stay with me');
        // A compass place is no place to run to.
        const w = gv();
        w.hear(picture(team(), [a], { phase: 'retreat', retreatTo: { x: 40000, y: 30000, z: 0 } }, 0));
        expect(w.hear(picture(team(), [a], { phase: 'retreat', retreatTo: { x: 40000, y: 30000, z: 0 } }, 900))?.text).toBe('pulling back, stay with me');
    });
    test('inc once per new count in an encounter, not in the fight', () => {
        const v = gv();
        const foes = [enemy(1, 'midgard', { x: 33000, y: 25000 }), enemy(2, 'midgard', { x: 33000, y: 25000 })];
        v.hear(picture(team(), foes, { phase: 'travel' }, 0));
        expect(v.hear(picture(team(), foes, { phase: 'travel' }, 1100))?.text).toBe('inc 2 mids north of the Faste');
        expect(v.hear(picture(team(), foes, { phase: 'travel' }, 6000))).toBeNull();
        // One more is not worth a line; two more are.
        const three = [...foes, enemy(3, 'hibernia', { x: 33000, y: 25000 })];
        v.hear(picture(team(), three, { phase: 'travel' }, 7000));
        expect(v.hear(picture(team(), three, { phase: 'travel' }, 8200))).toBeNull();
        const four = [...three, enemy(4, 'hibernia', { x: 33000, y: 25000 })];
        v.hear(picture(team(), four, { phase: 'travel' }, 9000));
        expect(v.hear(picture(team(), four, { phase: 'travel' }, 10_200))?.text).toBe('inc 2 mids and 2 hibs north of the Faste');
    });
    test('mezz on someone', () => {
        const v = gv();
        const t = enemy(9, 'midgard', { name: 'Troll', cc: { by: 'Merlin', kind: 'mezz', until: 60_000 } });
        expect(v.hear(picture(team(), [t], { phase: 'engage', focus: null }, 100))?.text).toBe('mezz on the Troll, leave it');
    });
    test('rez after the fight; the human told to wait', () => {
        const v = gv();
        const human = report('Niamh', { bot: '', observed: true, isDead: true });
        const members = [...team().map(m => (m.name === 'Merlin' ? { ...m, isDead: true } : m)), human];
        // The human's rez (settled first) and the welcome go before Merlin's.
        expect(ticks(v, t => picture(members, [], { phase: 'recover' }, t), 12_000)).toEqual([
            "Niamh, don't release, rez coming", 'hi Niamh, stick with us and /assist Gawain, I call the targets here', 'rez Merlin',
        ]);
        // Nothing of rez during the fight.
        const w = gv();
        expect(ticks(w, t => picture(members, [], { phase: 'engage', focus: null }, t), 12_000)).toEqual(['hi Niamh, stick with us and /assist Gawain, I call the targets here']);
    });
    test('the dead in one rez line; a solo says nothing', () => {
        const v = gv();
        const members = team().map(m => (m.name !== 'Tuck' ? { ...m, isDead: true } : m));
        expect(ticks(v, t => picture(members, [], { phase: 'recover' }, t), 6000)).toEqual(['rez Gawain and Merlin']);
        const solo = gv();
        expect(ticks(solo, t => picture([report('Gawain', { isDead: false })], [enemy(1)], { phase: 'travel' }, t), 6000)).toEqual([]);
    });
    test('next one of the same', () => {
        const v = gv();
        const a = enemy(1, 'hibernia'), b = enemy(2, 'hibernia');
        expect(ticks(v, t => picture(team(), [a, b], { phase: 'engage', focus: t < 5000 ? 1 : 2 }, t), 8000)).toEqual(['going in, focus the Celt', 'next Celt']);
    });
    test('the wipe', () => {
        const v = gv();
        const dead = team().map(m => ({ ...m, isDead: true }));
        v.hear(picture(dead, [], { phase: 'recover' }, 0));
        expect(v.hear(picture(dead, [], { phase: 'recover' }, 1600))?.text).toBe('wiped, release and meet at our PK');
    });
});

describe('/region', () => {
    const base = (over: Partial<RegionInput> = {}): RegionInput => ({ realm: 'hibernia', enabled: true, calls: [], foes: [], events: [], running: ['hib-1', 'hib-2'], ...over });
    const help = (over: Partial<RegionInput['calls'][number]> = {}) => ({ id: 'hibernia-7', kind: 'help', from: 'hib-1', why: 'outnumbered', at: { x: 38600, y: 36125 }, foes: 6, asked: [], coming: [], ...over });

    test('help with place and count, by the caller', () => {
        const foes = Array.from({ length: 6 }, () => ({ x: 38600, y: 36125, realm: 'midgard' }));
        const c = regionClaims(base({ calls: [help()], foes }));
        expect(c[0]).toMatchObject({ text: '6 mids at the mid bridge, need help', by: 'hib-1' });
    });
    test('nothing while the director is off', () => {
        expect(regionClaims(base({ enabled: false, calls: [help()] }))).toEqual([]);
    });
    test('the muster: gather, then go', () => {
        const rally = { id: 'hibernia-9', kind: 'muster', from: 'director', why: 'raid', at: { x: 30400, y: 34750 }, stage: 'rally' as const, foes: 0, asked: ['hib-2', 'hib-1'], coming: [] };
        expect(regionClaims(base({ calls: [rally] }))[0]).toMatchObject({ text: 'Faste raid, gather at our bridge', by: 'hib-1' });
        expect(regionClaims(base({ calls: [{ ...rally, stage: 'go' }] }))[0]).toMatchObject({ text: 'go go, Faste!' });
    });
    test('a raid that ended is still said when the voice was busy', () => {
        const v = new RegionVoice();
        const foes = Array.from({ length: 6 }, () => ({ x: 38600, y: 36125, realm: 'midgard' }));
        expect(v.hear(base({ calls: [help()], foes }), 0)?.text).toBe('6 mids at the mid bridge, need help');
        // The close comes 1 s later, inside the gap: held, then said.
        expect(v.hear(base({ events: [{ kind: 'close', call: 'hibernia-9', why: 'raid', end: 'captured' }] }), 1000)).toBeNull();
        expect(v.hear(base(), 5100)?.text).toBe('Faste is ours!');
    });
    test('sighted, and the defence of our keep', () => {
        const foes = Array.from({ length: 5 }, () => ({ x: 33089, y: 38271, realm: 'albion' }));
        expect(regionClaims(base({ calls: [help({ why: 'sighted', at: { x: 33000, y: 25000 } })], foes: [] }))[0]?.text).toBe('6 coming north of the Faste, need help');
        const defend = { id: 'hibernia-12', kind: 'defend', from: 'director', why: 'keep', at: { x: 33089, y: 38271 }, foes: 5, asked: ['hib-2'], coming: [] };
        expect(regionClaims(base({ calls: [defend], foes }))[0]).toMatchObject({ text: 'Faste under attack, 5 albs there, defend!', by: 'hib-2', urgent: true });
        expect(regionClaims(base({ events: [{ kind: 'close', call: 'hibernia-12', why: 'keep', end: 'quiet' }] }))[0]?.text).toBe('Faste holds, nice');
    });
    test('omw from a unit coming', () => {
        const c = regionClaims(base({ calls: [help()], events: [{ kind: 'answer', call: 'hibernia-7', unit: 'hib-2', state: 'coming' }] }));
        expect(c.find(x => x.text === 'omw')?.by).toBe('hib-2');
    });
});
