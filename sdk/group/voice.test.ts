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
    test('an ambush says what for; the break home and how long', () => {
        const v = gv();
        // A Troll died, three more of its realm are known (out of sight now): lie in wait for them.
        const known = [enemy(2, 'midgard', { stale: true }), enemy(3, 'midgard', { stale: true }), enemy(4, 'midgard', { stale: true })];
        const wait = { phase: 'travel' as const, objective: 'lie in wait for 3 enemies', reason: 'lie in wait beside its way in, 100 % of its way in hidden from it, 150 s more' };
        expect(ticks(v, t => picture(team(), known, wait, t), 6000)).toEqual(['waiting here in ambush for the 3 mids, hold still']);
        const set = { phase: 'travel' as const, objective: 'lie in wait for 1 enemy (lost 2×)', reason: 'ambush: to a spot beside its way in, 80 % hidden, 900 away' };
        expect(ticks(gv(), t => picture(team(), [known[0]!], set, t), 6000)).toEqual(['setting an ambush for the mid, follow me']);
        const home = { phase: 'travel' as const, reason: 'quiet: back to the portal keep for a break (after a fight), 19922 away' };
        const w = gv();
        expect(ticks(w, t => picture(team(), [], home, t), 8000)).toEqual(['heading back to our PK for a short break']);
        const here = (t: number) => picture(team(), [], { phase: 'idle', reason: `quiet: a break at the portal keep, out again in ${200 - Math.floor(t / 1000)} s (after a fight)` }, 10_000 + t);
        const said: string[] = [];
        for (let t = 0; t <= 8000; t += 500) { const l = w.hear(here(t)); if (l) said.push(l.text); }
        expect(said).toEqual(['short break here, out again in about 3 min']);
    });
    test('a rez is promised to a human only with a rezzer near the corpse', () => {
        const out = { phase: 'travel' as const, reason: 'wave: out toward where our realm last saw enemies' };
        // The unit near our PK, Niamh dead at the Faste, 25000 off: release and catch up.
        const at = (m: ReturnType<typeof report>) => ({ ...m, regionId: 252, x: 37301, y: 50362 });
        const niamh = report('Niamh', { observed: true, isDead: true, regionId: 252, x: 33089, y: 30000 });
        const far = ticks(gv(), t => picture([...team().map(at), niamh], [], out, t), 6000);
        expect(far).toContain("Niamh, we can't get to you, release and catch up, we're at our PK");
        expect(far.some(l => l.includes('rez coming'))).toBe(false);
        // Out of sight: no promise either.
        const gone = ticks(gv(), t => picture([...team().map(at), { ...niamh, regionId: -1 }], [], out, t), 6000);
        expect(gone.some(l => l.includes('rez coming'))).toBe(false);
        // Beside her: the promise.
        const near = ticks(gv(), t => picture([...team().map(at), { ...niamh, x: 37800, y: 50362 }], [], out, t), 6000);
        expect(near).toContain("Niamh, don't release, rez coming");
    });
    test('half of us down and no rez coming: release and meet at our PK, once per wipe', () => {
        const v = gv();
        const out = { phase: 'travel' as const, reason: 'wave: out toward where our realm last saw enemies' };
        const half = 'half the group down, no rezzer coming: release, meet at our portal keep';
        const released = (m: ReturnType<typeof report>) => ({ ...m, isDead: true, activity: { kind: 'release', targetId: null, detail: half, since: 0 } });
        const niamh = report('Niamh', { observed: true, isDead: true, regionId: 252, x: 37400, y: 50362 });
        const [g, t, m] = team();
        const said = ticks(v, s => picture([g!, released(t!), released(m!), niamh], [], out, s), 6000);
        expect(said.filter(l => !l.startsWith('hi '))).toEqual(['half of us down and no rez coming, release and meet at our PK']);
        // The whole group dead a little later: the same wipe, not said again.
        const dead = team().map(x => ({ ...x, isDead: true }));
        for (let s = 7000; s <= 12_000; s += 500) expect(v.hear(picture([...dead, niamh], [], out, s))).toBeNull();
        // A plain release (not half down) says nothing of the sort.
        const plain = ticks(gv(), s => picture([g!, { ...released(t!), activity: { kind: 'release', targetId: null, detail: '', since: 0 } }, m!], [], out, s), 6000);
        expect(plain.some(l => l.includes('half of us'))).toBe(false);
    });
    test('the wipe', () => {
        const v = gv();
        const dead = team().map(m => ({ ...m, isDead: true }));
        v.hear(picture(dead, [], { phase: 'recover' }, 0));
        expect(v.hear(picture(dead, [], { phase: 'recover' }, 1600))?.text).toBe('wiped, release and meet at our PK');
    });
});

describe('a human asks in group chat', () => {
    test('pick me up, where are you, and nothing else', async () => {
        const { readGroupAsk } = await import('./voice');
        for (const t of ['pick me up', 'can you pick me up?', 'pickup pls', 'come get me', 'wait for me', 'wait up', "i'm at the pk"]) expect(readGroupAsk(t)).toBe('pickup');
        for (const t of ['where are you?', 'where r u', 'where you at', 'where', 'loc?', 'where is everyone']) expect(readGroupAsk(t)).toBe('where');
        for (const t of ['nice', 'inc', 'omw', 'ty for the rez', 'where is the faste']) expect(readGroupAsk(t)).toBeNull();
    });
    test('the answer: where we are; a pickup taken, or why not', async () => {
        const { groupAnswer, pickupFree } = await import('./voice');
        const st = { realm: 'hibernia' as const, regionId: 252 };
        const team = [report('Fergus', { regionId: 252, x: 33000, y: 25000 }), report('Lugh', { regionId: 252, x: 33100, y: 25100 }), report('Niamh', { observed: true, regionId: -1 })];
        const out = picture(team, [], { phase: 'travel', reason: 'wave: out toward where our realm last saw enemies' });
        expect(groupAnswer('where', out, st, false)).toBe("we're north of the Faste, come to us");
        expect(pickupFree(out.orders)).toBe(true);
        expect(groupAnswer('pickup', out, st, true, false)).toBe('ok, coming to our PK for you, wait there');
        const fight = picture(team, [], { phase: 'engage' });
        expect(pickupFree(fight.orders)).toBe(false);
        expect(groupAnswer('pickup', fight, st, false)).toBe("we're fighting north of the Faste, come to us or ask again after the fight");
        expect(pickupFree(picture(team, [], { phase: 'travel', reason: 'call hibernia-4: help hibernia-2, 3000 away' }).orders)).toBe(false);
        const dead = picture(team.map(m => ({ ...m, isDead: !m.observed })), [], { phase: 'recover' });
        expect(groupAnswer('where', dead, st, false)).toBe('we are all dead, release and meet at our PK');
    });
    test('a pickup at or near our PK is never refused for a call, nor in the wait for everyone there', async () => {
        const { groupAnswer, pickupFree } = await import('./voice');
        const { homeOf } = await import('./keeps');
        const st = { realm: 'hibernia' as const, regionId: 252 };
        const pk = homeOf(252, 'hibernia')!.arrival;
        const at = (dx: number) => [report('Fergus', { regionId: 252, x: pk.x + dx, y: pk.y }), report('Lugh', { regionId: 252, x: pk.x + dx, y: pk.y + 100 }), report('Niamh', { observed: true, regionId: -1 })];
        const call = (team: ReturnType<typeof at>) => picture(team, [], { phase: 'travel', reason: 'call hibernia-4: help hibernia-2, 3000 away' });
        // On a call at our PK, and near it: taken, and "wait there".
        expect(pickupFree(call(at(200)).orders, "at our PK")).toBe(true);
        expect(groupAnswer('pickup', call(at(200)), st, true, false)).toBe("wait there, we're at our PK");
        expect(groupAnswer('pickup', call(at(200)), st, true, true)).toBe("wait there, we're at our PK, we'll buff you here");
        expect(groupAnswer('pickup', call(at(8000)), st, true)).toBe("wait there, we're near our PK, we'll buff you here");
        // The wait for everyone at our PK before the raid.
        const wait = picture(at(200), [], { phase: 'recover', reason: 'full force first: waiting at our portal keep for Niamh, 90 s at most', objective: 'wait for everyone at our portal keep before the raid' });
        expect(pickupFree(wait.orders)).toBe(true);
        // Far out on a call: still refused.
        expect(pickupFree(call(at(30_000)).orders, 'north of the Faste')).toBe(false);
    });
    test('a buff ask: the words, and a buff stop now or after the fight', async () => {
        const { buffFree, groupAnswer, readGroupAsk } = await import('./voice');
        for (const t of ['buff', 'buffs', 'buff me', 'buffs pls', 'need buffs', 'rebuff', 'no buffs', 'rebuff pls', 'can i get buffs?', 'BUFFS!']) expect(readGroupAsk(t)).toBe('buff');
        for (const t of ['ty for the buffs', 'nice buffs', 'buffed?']) expect(readGroupAsk(t)).toBeNull();
        const st = { realm: 'hibernia' as const, regionId: 252 };
        const team = [report('Fergus', { regionId: 252, x: 33000, y: 25000 }), report('Niamh', { observed: true, regionId: 252, x: 33100, y: 25000 })];
        const out = picture(team, [], { phase: 'travel', reason: 'wave: out toward where our realm last saw enemies' });
        const fight0 = () => picture(team, [], { phase: 'engage' });
        expect(buffFree(out.orders)).toBe(true);
        // No promise while no decide stops for it (BUFF_STOP_ON).
        expect(groupAnswer('buff', out, st, true, false)).toBeNull();
        expect(groupAnswer('buff', fight0(), st, false, false)).toBeNull();
        expect(groupAnswer('buff', out, st, true, true)).toBe('ok, buffing here, stay close');
        // A pickup ends in a buff stop, said once the stop is on.
        expect(groupAnswer('pickup', out, st, true, true)).toBe("ok, coming to our PK for you, we'll buff there");
        const fight = picture(team, [], { phase: 'engage' });
        expect(buffFree(fight.orders)).toBe(false);
        expect(groupAnswer('buff', fight, st, false, true)).toBe('after this fight');
    });
    test('the speaker holds the called focus for those who /assist it, unless on something of its own', async () => {
        const { assistTarget } = await import('./voice');
        const foe = enemy(425, 'midgard');
        const engage = { phase: 'engage' as const, focus: 425 };
        const me = { targetObjectId: null, isDead: false };
        // On the way in, no target yet: take the focus.
        expect(assistTarget(engage, [foe], me, { kind: 'move', targetId: null })).toBe(425);
        expect(assistTarget(engage, [foe], me, undefined)).toBe(425);
        // Already on it, dead, no fight, a monster, or out of sight: nothing.
        expect(assistTarget(engage, [foe], { ...me, targetObjectId: 425 }, undefined)).toBeNull();
        expect(assistTarget(engage, [foe], { ...me, isDead: true }, undefined)).toBeNull();
        expect(assistTarget({ phase: 'travel', focus: 425 }, [foe], me, undefined)).toBeNull();
        expect(assistTarget(engage, [{ ...foe, kind: 'npc' }], me, undefined)).toBeNull();
        expect(assistTarget(engage, [{ ...foe, stale: true }], me, undefined)).toBeNull();
        // A heal, a buff, a mezz or a peel onto another foe: left alone; back to the focus after.
        for (const kind of ['heal', 'buff', 'cc', 'song']) expect(assistTarget(engage, [foe], me, { kind, targetId: 7 })).toBeNull();
        expect(assistTarget(engage, [foe], me, { kind: 'melee', targetId: 9 })).toBeNull();
        expect(assistTarget(engage, [foe], { ...me, targetObjectId: 9 }, { kind: 'melee', targetId: 425 })).toBe(425);
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
    test('the go says why now; a call that got worse is said again', () => {
        const ev = (over: object) => regionClaims(base({ events: [{ kind: 'stage', call: 'hibernia-9', stage: 'go', ...over }] }))[0]?.text;
        expect(ev({ ownersAway: 4, owner: 'midgard', defenders: 6 })).toBe('go go, Faste! mids are busy elsewhere');
        expect(ev({ defenders: 2 })).toBe('go go, Faste! only 2 on it');
        const k = (why: string) => regionClaims(base({ calls: [help({ why })] }))[0]?.key;
        expect(k('sighted')).not.toBe(k('outnumbered'));
    });
    test('one fight, one call: again only when it got worse or grew by 3', () => {
        const v = new RegionVoice();
        const at = { x: 33000, y: 25000 };
        const mids = (n: number) => Array.from({ length: n }, () => ({ ...at, realm: 'midgard' }));
        const said: string[] = [];
        const step = (t: number, foes: number, why = 'caught', seen = foes) => { const l = v.hear(base({ calls: [help({ why, foes, at })], foes: mids(seen) }), t); if (l) said.push(l.text); };
        step(0, 5);
        step(6000, 2);
        step(12_000, 6, 'caught', 2);
        step(18_000, 8);
        expect(said).toEqual(['5 mids on us north of the Faste, help!', '8 mids on us north of the Faste, help!']);
    });
    test('two units in one fight: said once, again only when it got worse or grew by 3', () => {
        const v = new RegionVoice();
        const mids = (n: number, at: { x: number; y: number }) => Array.from({ length: n }, () => ({ ...at, realm: 'midgard' }));
        const a = { x: 33000, y: 25000 }, b = { x: 34500, y: 25800 }, far = { x: 45000, y: 30000 };
        const said: string[] = [];
        const step = (t: number, calls: object[]) => { const l = v.hear(base({ calls: calls as RegionInput['calls'], foes: mids(8, a) }), t); if (l) said.push(`${l.by}: ${l.text}`); };
        step(0, [help({ id: 'h-1', from: 'hib-1', why: 'sighted', foes: 8, at: a })]);
        step(6000, [help({ id: 'h-1', from: 'hib-1', why: 'sighted', foes: 8, at: a }), help({ id: 'h-2', from: 'hib-2', why: 'sighted', foes: 8, at: b })]);
        // The first caller's call closes; the other one of that fight stays quiet.
        step(12_000, [help({ id: 'h-2', from: 'hib-2', why: 'sighted', foes: 9, at: b })]);
        // Worse (caught): said again.
        step(18_000, [help({ id: 'h-2', from: 'hib-2', why: 'caught', foes: 8, at: b })]);
        // Another fight far off: its own line.
        step(24_000, [help({ id: 'h-2', from: 'hib-2', why: 'caught', foes: 8, at: b }), help({ id: 'h-3', from: 'hib-1', why: 'sighted', foes: 3, at: far })]);
        expect(said).toEqual(['hib-1: 8 mids coming north of the Faste, need help', 'hib-2: 8 mids on us north of the Faste, help!', 'hib-1: 3 coming north-east of the Faste, need help']);
    });
    test('a call that closes and opens again there is the same fight for a minute', () => {
        const v = new RegionVoice();
        const at = { x: 38347, y: 25873 };
        const said: string[] = [];
        const step = (t: number, calls: object[]) => { const l = v.hear(base({ calls: calls as RegionInput['calls'], foes: [] }), t); if (l) said.push(l.text); };
        step(0, [help({ id: 'h-1', from: 'hib-1', why: 'sighted', foes: 7, at })]);
        // Sighted to outnumbered: the same news.
        step(12_000, [help({ id: 'h-1', from: 'hib-1', why: 'outnumbered', foes: 7, at })]);
        step(28_000, []);
        step(34_000, [help({ id: 'h-2', from: 'hib-1', why: 'sighted', foes: 7, at: { x: 38313, y: 25755 } })]);
        step(56_000, [help({ id: 'h-3', from: 'hib-1', why: 'outnumbered', foes: 8, at: { x: 39524, y: 25491 } })]);
        step(74_000, [help({ id: 'h-3', from: 'hib-1', why: 'caught', foes: 8, at: { x: 39524, y: 25491 } })]);
        // Long after the last call there closed: a new fight.
        step(80_000, []);
        step(150_000, [help({ id: 'h-4', from: 'hib-1', why: 'sighted', foes: 4, at })]);
        expect(said).toEqual(['7 coming north-east of the Faste, need help', '8 on us north-east of the Faste, help!', '4 coming north-east of the Faste, need help']);
    });
    test('omw from a unit coming', () => {
        const c = regionClaims(base({ calls: [help()], events: [{ kind: 'answer', call: 'hibernia-7', unit: 'hib-2', state: 'coming' }] }));
        expect(c.find(x => x.text === 'omw')?.by).toBe('hib-2');
        // Never the caller (a stale answer after a director restart).
        const own = regionClaims(base({ calls: [help()], events: [{ kind: 'answer', call: 'hibernia-7', unit: 'hib-1', state: 'coming' }] }));
        expect(own.some(x => x.text === 'omw')).toBe(false);
    });
});
