import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { ChatHistory } from '../chat-history';
import { ATTACK_REFUSALS, CAST_REFUSALS, conColor, conLevel, diffInventory, experienceFromMessages, firstReasonLine, isCrowdControlled, isFatalAttackRefusal, isKillable, isPvpImmunity, isResistOf, isDeadLineOf, isFocusCaster, isServantCast, nameOf, worstPowerCost, isServantQueued, MessageWatch, parseMoneyText, PET_ANSWERS, PET_REFUSALS, PET_UNDER_CONTROL, petSpellKind, REPAIR_ANSWERS, REPAIR_OFFER, REPAIR_REFUSALS, RETRYABLE_ATTACK_REFUSALS, SUMMON_FAILURES, USE_ITEM_REFUSALS } from '../actions-helpers';
import { castFailureReason } from '../actions';
import { StraightLinePathProvider, getDefaultPathProvider, setDefaultPathProvider } from '../pathfinding';
import type { GameMessage, InventoryItem } from '../types';
import { makeMessage, makeNpc, makePlayer, makeState } from './fixtures';

const item = (slot: number, name: string, count = 1): InventoryItem => ({
    slot, name, count, level: 1, model: 1, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 1, value1: 0, value2: 0, hand: 0,
});

describe('parseMoneyText', () => {
    test.each([
        ['0 copper pieces', 0], ['48 silver', 4800], ['3 gold, 24 silver', 32_400], ['1 gold, 24 silver, 5 copper', 12_405],
        ['2 platinum, 1 gold', 20_010_000], ['1 mithril', 10_000_000_000],
    ])('%s is %i copper', (text, copper) => {
        expect(parseMoneyText(text)).toBe(copper);
    });
});

describe('repair lines', () => {
    test.each([
        ['It will cost 3 gold, 24 silver to repair the alloy axe. Do you accept?', '3 gold, 24 silver'],
        ['It will cost 0 copper pieces to repair the Matterbender Sword. Do you accept?', '0 copper pieces'],
        ['It will cost 1 silver, 44 copper to repair everything. Do you accept?', '1 silver, 44 copper'],
    ])('the price in %s', (text, price) => {
        expect(REPAIR_OFFER.exec(text)?.[1]).toBe(price);
    });

    test('speech can\'t pass for a refusal or an answer', () => {
        const refusal = (text: string) => firstReasonLine([{ text } as GameMessage], REPAIR_REFUSALS)?.reason;
        expect(refusal('Your alloy axe is already in perfect condition.')).toBe('no_need');
        expect(refusal('Morlin Caan says, "I can\'t repair that."')).toBe('not_repairable');
        expect(refusal('Otherguy says, "your alloy axe is already in perfect condition."')).toBeUndefined();
        const answer = (text: string) => firstReasonLine([{ text } as GameMessage], REPAIR_ANSWERS)?.reason;
        expect(answer('Morlin Caan says, "There, the alloy axe is ready for combat."')).toBe('done');
        expect(answer('Morlin Caan says, "Uhh, the alloy axe is rather old. I won\'t be able to repair it again, so be careful!"')).toBe('done');
        expect(answer('Morlin Caan says, "It costs 3 gold to repair the alloy axe. You don\'t have that much."')).toBe('insufficient_funds');
        // Repair all's broken text, placeholders and all (Blacksmith.cs:266-268).
        expect(answer('Morlin Caan says, "{0} says, "It costs {1} to repair {2}. You don\'t have that much.""')).toBe('insufficient_funds');
    });
});

describe('conLevel (ConLevelGrid.cs)', () => {
    test('level 1: level 0 is blue, 1 yellow, 2 orange, 3 red, 4+ purple', () => {
        expect([0, 1, 2, 3, 4, 10].map(l => conLevel(1, l))).toEqual([-1, 0, 1, 2, 3, 3]);
    });

    test('level 10 spans', () => {
        // [grey 7, green 1, blue 2, yellow 1, orange 1, red 2]
        expect([0, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(l => conLevel(10, l))).toEqual([-3, -3, -2, -1, -1, 0, 1, 2, 2, 3]);
    });

    test('level 50 and beyond', () => {
        expect(conLevel(50, 35)).toBe(-3);
        expect(conLevel(50, 36)).toBe(-2);
        expect(conLevel(50, 50)).toBe(0);
        expect(conLevel(55, 41)).toBe(-2);
        expect(conLevel(55, 40)).toBe(-3);
    });

    test('colors', () => {
        expect([-3, -2, -1, 0, 1, 2, 3].map(conColor)).toEqual(['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple']);
    });
});

describe('isKillable', () => {
    const p = makePlayer();
    test('monsters yes, townsfolk and realm NPCs no', () => {
        expect(isKillable(makeNpc(), p)).toBeTrue();
        expect(isKillable(makeNpc({ realm: 'albion' }), p)).toBeFalse();
        expect(isKillable(makeNpc({ name: 'Grizelda', role: 'merchant' }), p)).toBeFalse();
        expect(isKillable(makeNpc({ name: 'Guard Ulf', role: 'guard' }), p)).toBeFalse();
        // The role is guessed from the name: a monster called "... royal guard" is still a monster.
        expect(isKillable(makeNpc({ name: 'wood-eater royal guard', role: 'guard' }), p)).toBeTrue();
        expect(isKillable(makeNpc({ isPeaceful: true }), p)).toBeFalse();
        // A dead one leaves the list: at 0 % it is alive, the percent is truncated (GameLiving.cs:2621).
        expect(isKillable(makeNpc({ healthPercent: 0 }), p)).toBeTrue();
        expect(isKillable(makeNpc({ name: '' }), p)).toBeFalse();
    });

    test('no pet is killable, an enemy realm\'s neither: killing one is worth nothing', () => {
        const p = makePlayer();
        for (const realm of ['none', 'albion', 'midgard'] as const) expect(isKillable(makeNpc({ isPet: true, realm }), p)).toBeFalse();
    });
});

describe('pet lines', () => {
    const line = (text: string) => makeMessage(1, text);

    test('petSpellKind goes by the static type', () => {
        for (const type of ['SummonSimulacrum', 'SummonSpiritFighter', 'SummonUnderhill', 'SummonDruidPet', 'SummonHunterPet', 'SummonCommander', 'SummonNecroPet']) expect(petSpellKind(type)).toBe('main');
        expect(petSpellKind('SummonAnimistPet')).toBe('turret');
        for (const type of ['SummonTheurgistPet', 'SummonAnimistFnF']) expect(petSpellKind(type)).toBe('fnf');
        expect(petSpellKind('Bomber')).toBe('bomber');
        expect(petSpellKind('SummonMinion')).toBe('minion');
        expect(petSpellKind('Charm')).toBe('charm');
        for (const type of ['PetSpell', 'DirectDamage', 'SummonNoveltyPet', 'constructor']) expect(petSpellKind(type)).toBeNull();
    });

    test('each answer matches its own order only, and no speech (GameLiving.txt:54-62)', () => {
        const answers = {
            attack: 'You command the wolf cub to kill your target!',
            follow: 'You command the wolf cub to follow you!',
            stay: 'You command the wolf cub to stay in this position!',
            comeHere: 'You command the wolf cub to come to you.',
            goTarget: 'You command the wolf cub to go to your target.',
            passive: 'You command the wolf cub to disengage from combat!',
            aggressive: 'You command the wolf cub to attack all enemies!',
            defensive: 'You command the wolf cub to defend you!',
        };
        for (const [command, pattern] of Object.entries(PET_ANSWERS)) {
            for (const [other, text] of Object.entries(answers)) expect(pattern.test(text)).toBe(other === command);
            expect(pattern.test(`Otherguy says, "${answers[command as keyof typeof answers]}"`)).toBeFalse();
        }
    });

    test('refusals of a pet order carry their reasons, and immunity comes before "You can\'t attack"', () => {
        const cases: [string, string][] = [
            ['Your target is too far away to attack with your pet!', 'out_of_range'],
            ['Your target is too far away for your pet to reach!', 'out_of_range'],
            ['You must select a destination for your controlled creature.', 'no_target'],
            ["You can't attack players until your PvP invulnerability timer wears off!", 'immune'],
            ['Norseman is temporarily immune to PvP attacks!', 'immune'],
            ['Norseman is entering the game and cannot be attacked!', 'immune'],
            ["You can't attack a member of your realm!", 'not_attackable'],
            ["You can't attack yourself!", 'not_attackable'],
            ["You can't attack a shadowed necromancer!", 'not_attackable'],
        ];
        for (const [text, reason] of cases) expect(firstReasonLine([line(text)], PET_REFUSALS)).toEqual({ reason, text });
        expect(firstReasonLine([line('You command the wolf cub to follow you!')], PET_REFUSALS)).toBeNull();
    });

    test('the under-your-control line gives the name without its article', () => {
        expect(PET_UNDER_CONTROL.exec('The earth spirit is now under your control.')?.[1]).toBe('earth spirit');
        expect(PET_UNDER_CONTROL.exec('Slough serpent is now under your control.')?.[1]).toBe('Slough serpent');
        expect(PET_UNDER_CONTROL.exec('Otherguy says, "The wolf is now under your control."')).toBeNull();
    });

    test('after the cast only a charm can still fail', () => {
        expect(firstReasonLine([line('The serpent resists the charm! (12.5%)')], SUMMON_FAILURES)?.reason).toBe('resisted');
        expect(firstReasonLine([line('Your controlled creature is too far away!')], SUMMON_FAILURES)?.reason).toBe('out_of_range');
        expect(firstReasonLine([line('The serpent resists the effect!')], SUMMON_FAILURES)).toBeNull();
    });

    test('the too-far-with-your-pet line reads as no melee refusal, retryable or not (GameLiving.txt:36)', () => {
        const text = 'your target is too far away to attack with your pet!';
        expect(ATTACK_REFUSALS.some(r => text.includes(r))).toBeFalse();
        expect(RETRYABLE_ATTACK_REFUSALS.some(r => text.includes(r))).toBeFalse();
        expect(isFatalAttackRefusal('Your target is too far away to attack with your pet!')).toBeFalse();
        // The melee line itself still is one, and stays retryable (GamePlayer.txt:245).
        expect(RETRYABLE_ATTACK_REFUSALS.some(r => 'the rat is too far away to attack!'.includes(r))).toBeTrue();
    });

    test('the shade lines are fatal melee refusals (ClassDisciple.cs:91, GamePlayer.txt:39)', () => {
        expect(isFatalAttackRefusal('You cannot enter combat while in shade form!')).toBeTrue();
        expect(isFatalAttackRefusal('You cannot enter combat in shade mode!')).toBeTrue();
    });
});

describe('deltas', () => {
    test('diffInventory counts stacks by name', () => {
        const before = [item(40, 'rat tail', 2), item(41, 'sword')];
        const after = [item(40, 'rat tail', 5), item(42, 'bag')];
        const d = diffInventory(before, after);
        expect(d.gained.map(i => [i.name, i.count])).toEqual([['rat tail', 3], ['bag', 1]]);
        expect(d.lost.map(i => [i.name, i.count])).toEqual([['sword', 1]]);
    });

    test('experienceFromMessages sums "You get N experience points"', () => {
        expect(experienceFromMessages([
            makeMessage(1, 'You get 17 experience points. (2 camp bonus) '),
            makeMessage(2, 'You get 1,234 experience points.'),
            makeMessage(3, 'The rat dies!'),
        ])).toBe(1251);
    });

    test('castFailureReason', () => {
        expect(castFailureReason("You don't have enough power to cast that!")).toBe('no_power');
        expect(castFailureReason('The puny skeleton attacks you and your spell is interrupted!')).toBe('interrupted');
        expect(castFailureReason('You must wait 2 seconds to cast a spell!')).toBe('must_wait');
        expect(castFailureReason('That target is too far away!')).toBe('out_of_range');
        expect(castFailureReason('Your target is not visible!')).toBe('not_visible');
        expect(castFailureReason('You must select a target for this spell!')).toBe('no_target');
    });

    test('castFailureReason: a cast that only stopped its running pulse (CastingComponent.cs:349-366)', () => {
        expect(castFailureReason('You cancel your effect.')).toBe('pulse_cancelled');
        expect(castFailureReason('You stop playing your song.')).toBe('pulse_cancelled');
        expect(CAST_REFUSALS).toContain('you cancel your effect');
    });

    test('worstPowerCost: the pool without items, 120 % only for a focus caster (SpellHandler.cs:1190-1221)', () => {
        const stats = { strength: 50, dexterity: 60, constitution: 50, quickness: 50, intelligence: 60, piety: 50, empathy: 50, charisma: 50 };
        const who = (className: string, realm: 'albion' | 'midgard' | 'hibernia') => makePlayer({ className, realm, level: 20, maxMana: 300, statsWithoutItems: stats });
        expect(worstPowerCost(-25, who('Hunter', 'midgard'))).toBe(26); // live: 26 of 105
        expect(worstPowerCost(-25, who('Huntress', 'midgard'))).toBe(26);
        expect(worstPowerCost(-25, who('Necromancer', 'albion'))).toBe(31);
        expect(worstPowerCost(-25, who('Disciple', 'albion'))).toBe(31);
        expect(worstPowerCost(-25, who('Valewalker', 'hibernia'))).toBe(26); // ClassValewalker.cs:24
        expect(worstPowerCost(10, who('Hunter', 'midgard'))).toBe(10);
        expect(worstPowerCost(10, who('Necromancer', 'albion'))).toBe(12); // live: a flat 10 costs an Animist 12
        // Nothing to read, older clients and the moment before the first 0xFB: maxMana, the most the pool can be: it has the items in it.
        for (const statsWithoutItems of [undefined, null]) {
            expect(worstPowerCost(-25, makePlayer({ className: 'Hunter', realm: 'midgard', level: 20, maxMana: 200, statsWithoutItems }))).toBe(50);
        }
    });

    test('isFocusCaster goes by the base class', () => {
        expect(isFocusCaster(makePlayer({ className: 'Necromancer', realm: 'albion' }))).toBeTrue();
        expect(isFocusCaster(makePlayer({ className: 'Hunter', realm: 'midgard' }))).toBeFalse();
        expect(isFocusCaster(makePlayer({ className: 'Valewalker', realm: 'hibernia' }))).toBeFalse();
    });

    test('isDeadLineOf: a line naming our target (SpellHandler.cs:783), with its article; null for a target whose real name we don\'t have', () => {
        expect(isDeadLineOf('The young wolf is dead!', 'young wolf')).toBeTrue();
        expect(isDeadLineOf('Pettan is dead!', 'Pettan')).toBeTrue();
        expect(isDeadLineOf('The rat is dead!', 'young wolf')).toBeFalse();
        expect(isDeadLineOf('Anyone is dead!', null)).toBeTrue();
        expect(isDeadLineOf('Pettan says, "the wolf is dead!"', null)).toBeFalse();
        expect(isDeadLineOf('You are dead', null)).toBeFalse();
    });

    test('USE_ITEM_REFUSALS has the line a stone gives in combat (GatewayPersonalBind.cs:105)', () => {
        expect(USE_ITEM_REFUSALS.some(x => 'you have been in combat recently and cannot use this item!'.includes(x))).toBeTrue();
    });

    test('nameOf: an empty name reads #id', () => {
        expect(nameOf({ name: 'young wolf', objectId: 7 })).toBe('young wolf');
        expect(nameOf({ name: '', objectId: 7 })).toBe('#7');
    });

    test('isResistOf: only a line about our target (SpellHandler.cs:2383-2390)', () => {
        expect(isResistOf('The young wolf resists the effect! (12.0%)', 'young wolf')).toBe(true);
        expect(isResistOf('Aidan resists the effect! (3.0%)', 'Aidan')).toBe(true);
        expect(isResistOf('The slough serpent resists the charm! (12.5%)', 'slough serpent')).toBe(true);
        // Not a resist: a mezz can't take an NPC under 75 % (CCSpellHandler.cs:174-178), and castSpell reports it with effectImmune.
        expect(isResistOf('Your target is enraged and resists the spell!', 'young wolf')).toBe(false);
        expect(isResistOf('The goblin resists the effect! (12.0%)', 'young wolf')).toBe(false);
        expect(isResistOf('Your wolf cub resists the effect!', 'young wolf')).toBe(false);
        expect(isResistOf('You resist the effect!', 'young wolf')).toBe(false);
        expect(isResistOf('You hit the young wolf for 5 damage!', 'young wolf')).toBe(false);
        // No target named: an area spell's, whoever it is, but never the ones about us or ours.
        expect(isResistOf('The goblin resists the effect! (12.0%)', null)).toBe(true);
        expect(isResistOf('Your wolf cub resists the effect!', null)).toBe(false);
        expect(isResistOf('You resist the effect!', null)).toBe(false);
    });

    test('isServantCast: the servant\'s lines for this spell, not speech or another spell (Spells.txt:7-8, AI.txt:4, :7)', () => {
        const name = 'Glimpse of Fate';
        expect(isServantCast('The zombie servant begins casting a Glimpse of Fate spell!', name)).toBe(true);
        expect(isServantCast('The zombie servant cast a Glimpse of Fate spell!', name)).toBe(true);
        expect(isServantCast('The zombie servant begins casting the spell!', name)).toBe(true);
        expect(isServantCast('The zombie servant will begin casting this spell after its current action is finished.', name)).toBe(false);
        expect(isServantCast('The zombie servant cast a Visions of Fate spell!', name)).toBe(false);
        expect(isServantCast('You begin casting a Glimpse of Fate spell!', name)).toBe(false);
        expect(isServantCast('Otherguy says, "the zombie cast a Glimpse of Fate spell!"', name)).toBe(false);
    });

    test('isServantQueued: the line that promises nothing, not speech (AI.txt:4)', () => {
        expect(isServantQueued('The zombie servant will begin casting this spell after its current action is finished.')).toBe(true);
        expect(isServantQueued('The zombie servant begins casting the spell!')).toBe(false);
        expect(isServantQueued('Otherguy says, "the zombie will begin casting this spell after lunch"')).toBe(false);
    });

    test('castFailureReason: pet lines keep their reason after the whole cast too, whatever a mob is called', () => {
        const cases: [string, string][] = [
            ['You already have a charmed creature, release it first!', 'pet_exists'],
            ['You must cast this spell on a creature you are controlling.', 'no_pet'],
            ['You must have a pet summoned to cast this spell!', 'no_pet'],
            ["You can't do that here!", 'refused'],
            ['You have too many controlled creatures!', 'refused'],
            ["You can't charm that target!", 'refused'],
            ['This spell does not charm that type of monster!', 'refused'],
            ['The power wraith is too strong for you to charm!', 'refused'],
            ['The interrupting sprite is currently being controlled.', 'refused'],
            ["You can't charm the power wraith while it is in combat!", 'in_combat'],
            ["You can't charm the interrupting sprite while its is in combat!", 'in_combat'],
            ["The power wraith can't be charmed!", 'refused'],
            ['You have to set a ground target for this Spell.', 'no_ground_target'],
            ['Your ground target is not visible!', 'refused'],
            ['Your ground target is not in view.', 'refused'],
            ['You have to select a closer ground target.', 'out_of_range'],
            ["You can't summon a turret without a ground target !", 'no_ground_target'],
            ["You can't summon any more turrets in this area!", 'refused'],
            ['You cannot control any more turrets!', 'refused'],
            ['Cannot summon a turret this high near a keep!', 'refused'],
            ['You must have a controlled leader monster to summon into a group!', 'refused'],
            ['Your general already has as many followers as he can command!', 'refused'],
            ['Your commander is not powerful enough to control a minion of this level.', 'refused'],
            ['You are already a shade!', 'refused'],
            ['Your servant is too far away from your target to cast that spell!', 'out_of_range'],
            ['You cannot transfer power to yourself!', 'invalid_target'],
            ["Your controlled necroservant can't see its target!", 'out_of_range'],
        ];
        for (const [text, reason] of cases) {
            expect(CAST_REFUSALS.some(r => text.toLowerCase().includes(r))).toBeTrue();
            // Past the start of a cast, an unknown refusal reads as an interrupt.
            expect(castFailureReason(text, 'interrupted')).toBe(reason);
        }
    });

    test('PvP immunity is its own reason, though ours also reads like a fatal refusal (AbstractServerRules.cs:350-375)', () => {
        const ours = "You can't attack players until your PvP invulnerability timer wears off!";
        const theirs = ['Norseman is temporarily immune to PvP attacks!', 'Norseman is entering the game and cannot be attacked!'];
        for (const text of [ours, ...theirs]) {
            expect(isPvpImmunity(text)).toBeTrue();
            expect(castFailureReason(text)).toBe('immune');
            expect(ATTACK_REFUSALS.some(r => text.toLowerCase().includes(r))).toBeTrue();
        }
        expect(isPvpImmunity("You can't attack a friendly NPC!")).toBeFalse();
    });

    test('a mezz, stun or silence on us is reason crowd_controlled, for melee and spells (GamePlayer.txt:36-37, Spells.txt:18-20)', () => {
        const melee = ["You can't attack when you are mesmerized!", "You can't attack when you are stunned!"];
        const cast = ["You can't cast while mesmerized!", "You can't cast while stunned!", 'You are fumbling for your words, and cannot cast!'];
        for (const text of [...melee, ...cast]) {
            expect(isCrowdControlled(text)).toBeTrue();
            expect(castFailureReason(text)).toBe('crowd_controlled');
        }
        for (const text of melee) expect(isFatalAttackRefusal(text)).toBeTrue();
        // Before this, castSpell waited 3 s for these and reported no_response.
        for (const text of cast) expect(CAST_REFUSALS.some(r => text.toLowerCase().includes(r))).toBeTrue();
        // Our mezz on someone else, and its immunity, are no refusals of ours.
        for (const text of ['Norseman is mesmerized!', 'Your target is immune to this effect!', "You can't rest when you are stunned!"]) {
            expect(isCrowdControlled(text)).toBeFalse();
        }
    });

    test('the notice that our immunity ended matches no refusal (AbstractServerRules.cs:301)', () => {
        const notice = 'Your temporary PvP invulnerability timer has expired.';
        expect(isPvpImmunity(notice)).toBeFalse();
        expect(castFailureReason(notice)).toBe('refused');
        for (const list of [ATTACK_REFUSALS, CAST_REFUSALS, USE_ITEM_REFUSALS]) {
            expect(list.some(r => notice.toLowerCase().includes(r))).toBeFalse();
        }
    });

    test('range and view refusals are retryable, the rest of ATTACK_REFUSALS fatal', () => {
        for (const text of ['Norseman is too far away to attack!', 'Norseman is not in view!', "You can't see your target!"]) {
            expect(isFatalAttackRefusal(text)).toBeFalse();
        }
        for (const text of ["You can't attack when you are stunned!", 'Norseman is already dead!', "You can't attack players until your PvP invulnerability timer wears off!"]) {
            expect(isFatalAttackRefusal(text)).toBeTrue();
        }
        expect(isFatalAttackRefusal('You hit Norseman for 12 damage!')).toBeFalse();
    });
});

describe('MessageWatch', () => {
    test('collects only messages after the baseline, across snapshots', () => {
        const sdk = Object.create(BotSDK.prototype) as BotSDK;
        (sdk as any).config = { showChat: true };
        (sdk as any).stateListeners = new Set();
        (sdk as any).chatHistory = new ChatHistory();
        const feed = (ids: number[]) => (sdk as any).handleMessage(JSON.stringify({
            type: 'sdk_state', state: makeState({ gameMessages: ids.map(id => makeMessage(id, `msg ${id} ${id === 7 ? 'You can\'t see your target!' : ''}`)) }),
        }));
        feed([1, 2, 3]);
        const watch = new MessageWatch(sdk);
        feed([2, 3, 4, 5]);
        feed([6, 7]); // 4 and 5 scrolled out of this snapshot but were collected
        expect(watch.messages().map(m => m.id)).toEqual([4, 5, 6, 7]);
        expect(watch.find(["can't see your target"])?.id).toBe(7);
        expect(watch.findText([/msg 5/])).toContain('msg 5');
        watch.dispose();
        feed([8]);
        expect(watch.messages().map(m => m.id)).toEqual([4, 5, 6, 7]);
        expect((sdk as any).stateListeners.size).toBe(0);
    });
});

describe('path providers', () => {
    test('straight line splits long legs and interpolates z', () => {
        const provider = new StraightLinePathProvider({ maxSegment: 500, estimateZ: null });
        const r = provider.findPath({ regionId: 1, from: { x: 0, y: 0, z: 100 }, to: { x: 1500, y: 0, z: 400 } });
        expect(r.success).toBeTrue();
        expect(r.waypoints).toEqual([{ x: 500, y: 0, z: 200 }, { x: 1000, y: 0, z: 300 }, { x: 1500, y: 0, z: 400 }]);
    });

    test('estimator fills z, outliers fall back to interpolation', () => {
        const provider = new StraightLinePathProvider({ maxSegment: 500, estimateZ: (_r, x) => (x === 500 ? 5000 : 150), maxZDeviation: 600 });
        const r = provider.findPath({ regionId: 1, from: { x: 0, y: 0, z: 100 }, to: { x: 1500, y: 0 } });
        // x=500: 5000 is an outlier, so the 100→150 interpolation (117) is used.
        expect(r.waypoints.map(w => w.z)).toEqual([117, 150, 150]);
    });

    test('data estimator answers for Camelot Hills', () => {
        const r = new StraightLinePathProvider().findPath({ regionId: 1, from: { x: 574797, y: 530161, z: 2896 }, to: { x: 576200, y: 528250 } });
        expect(r.success).toBeTrue();
        const end = r.waypoints.at(-1)!;
        expect(Math.abs(end.z - 2179)).toBeLessThan(300);
    });

    test('default provider is swappable (navmesh tests: navmesh.test.ts)', () => {
        const custom = new StraightLinePathProvider({ estimateZ: null });
        setDefaultPathProvider(custom);
        expect(getDefaultPathProvider()).toBe(custom);
        setDefaultPathProvider(null);
        expect(getDefaultPathProvider()).not.toBe(custom);
    });
});
