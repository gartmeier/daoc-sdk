// Read-only probe of a character for its kit (R7, 2026-11-12): the style details the server sent, what the kit's style pick
// returns at a player and at a monster in front of it, the spells the kit's behaviours look for, the buffs buff() keeps, and
// the effects on it. Nothing is cast or moved. Run through MCP: execute_code({ bot_name, script: 'sdk/test/live/kit-probe-r7.ts' }).

import { championStyle } from '../../classes/champion';
import { mercenaryStyle } from '../../classes/mercenary';
import { reaverStyle } from '../../classes/reaver';
import { savageStyle } from '../../classes/savage';
import { valewalkerStyle } from '../../classes/valewalker';
import { Spellbook } from '../../group/spells';
import { canWield } from '../../group/styles';
import type { BotActions } from '../../actions';
import type { BotSDK } from '../../index';

const PICKS: Record<string, typeof mercenaryStyle> = {
    Mercenary: mercenaryStyle, Reaver: reaverStyle, Savage: savageStyle, Champion: championStyle, Valewalker: valewalkerStyle,
};
const KIT_TYPES = ['Stun', 'SpeedDecrease', 'StrengthConstitutionDebuff', 'Lifedrain', 'DirectDamage', 'DamageAdd', 'CombatSpeedBuff', 'OffensiveProc', 'DefensiveProc', 'SavageCombatSpeedBuff', 'SavageDPSBuff', 'Confusion', 'Mesmerize'];

export default async ({ bot, sdk }: { bot: BotActions; sdk: BotSDK }) => {
    const p = sdk.getPlayer()!;
    const state = sdk.getState()!;
    const styles = sdk.getSkills()?.styles ?? [];
    const book = new Spellbook(sdk, bot);
    const pick = PICKS[p.className];
    const seen = (kind: 'player' | 'npc') => ({
        target: { objectId: -1, kind } as never, player: p, state: { ...state, combatEvents: [], gameMessages: [] }, styles,
    });
    return {
        who: `${p.name} ${p.className} L${p.level} ${p.healthPercent}% hp, mana ${p.mana}/${p.maxMana}, end ${p.endurancePercent}%`,
        hands: state.equipment.filter(e => [10, 11, 12].includes(e.slot)).map(e => `${e.slot}:${e.name}:${e.objectType}`),
        styles: styles.map(s => `${s.name} [${s.details ? `${s.details.opening}/${s.details.result ?? '-'}/${s.details.position ?? '-'}/after:${s.details.openingStyle ?? '-'}/w:${s.details.weapon}/proc:${s.details.procSpell?.description?.slice(0, 40) ?? s.details.procSpellId ?? '-'}` : 'no details'}]${canWield(s, state.equipment) ? '' : ' (not wieldable)'}`),
        pickAtPlayer: pick ? pick(seen('player') as never) : null,
        pickAtMonster: pick ? pick(seen('npc') as never) : null,
        kitSpells: book.all().filter(s => KIT_TYPES.includes(s.type)).map(s => `${s.spell.name} ${s.type} ${s.target} r${s.range}/rad${s.radius} cast${s.castTime} cd${s.spell.cooldownRemaining} pow${s.power} skill${s.spell.skillIndex ?? '-'}`),
        interrupts: book.interrupts().map(s => s.spell.name),
        mezz: book.mezz()?.spell.name ?? null,
        songs: book.songs().map(s => `${s.kind}=${s.spell.name}`),
        buffsKept: book.buffs().map(s => `${s.slot}:${s.spell.name}`),
        effects: state.effects.map(e => `${e.name}(${e.spellId},${e.remainingSeconds}s)`),
        region: p.regionId,
    };
};
