// Who buffs whom. Each role needs a list of buff slots in priority order; each
// (slot, target) gets one provider; each caster spends its concentration on its
// own assignments, most important first.
//
// The rules come from a Hibernia player (session 2 of groups/hibernia):
//  - Casters keep up their own self buffs (AF, later an absorb "bubble").
//  - A Bard or Warden (support) gives the base buffs (af, str, con, dex) to the
//    group, the Druid (healer) the spec buffs (strcon, dexqui, acuity, specaf).
//    Everyone who can buffs itself first, so the Druid keeps its own base buffs.
//  - Needs: the tank everything but acuity; healers af, con, dex, strcon, dexqui;
//    casters con, dex, strcon, dexqui, acuity, and af/absorb from their own spells.
//  - Priority comes in rounds: everyone's most important slot (tank, healers,
//    support, casters), then everyone's second, and so on, until the caster's
//    concentration runs out. Timed buffs (no concentration) always fit.
//  - A caster drops its concentration buffs that are not in its plan (the slot
//    moved to another provider, the target needs no such slot) when the pool is
//    short; buffs on dead or absent members end on their own.
//  - Leftover concentration goes on the group's window pets, as players do (the user, playing Niamh, 2026-11-13):
//    the last pass of the plan, concentration buffs only, never at the cost of a member's buff (nextBuff keeps
//    the room every member's buff needs, and surplusConcentration drops pet buffs first).

import type { BuffSlot, BuffSpell, MemberReport, Role } from './types';

/** Slots each role wants, most important first. */
export const BUFF_NEEDS: Record<Role, BuffSlot[]> = {
    tank: ['strcon', 'af', 'con', 'dexqui', 'specaf', 'str', 'dex', 'haste', 'dmgshield', 'absorb', 'dmgadd', 'resist', 'regen'],
    melee: ['strcon', 'af', 'con', 'dexqui', 'specaf', 'str', 'dex', 'haste', 'dmgshield', 'absorb', 'dmgadd', 'resist', 'regen'],
    healer: ['con', 'af', 'strcon', 'dex', 'dexqui', 'specaf', 'absorb', 'regen'],
    support: ['con', 'af', 'strcon', 'dex', 'dexqui', 'specaf', 'absorb', 'regen'],
    nuker: ['acuity', 'af', 'con', 'dexqui', 'dex', 'strcon', 'absorb', 'regen'],
};

/** Slots a role takes only from its own spells (casters: their self AF and bubble). */
export const BUFF_SELF_ONLY: Partial<Record<Role, BuffSlot[]>> = { nuker: ['af', 'absorb'] };

const BASE: ReadonlySet<BuffSlot> = new Set(['af', 'str', 'con', 'dex', 'qui']);
const SPEC: ReadonlySet<BuffSlot> = new Set(['strcon', 'dexqui', 'acuity', 'specaf']);
/** Who provides a slot to others, by role: base from the Bard/Warden, spec (and the rest) from the Druid. */
const PROVIDERS: Record<'base' | 'spec' | 'other', Role[]> = {
    base: ['support', 'healer', 'nuker', 'tank', 'melee'],
    spec: ['healer', 'support', 'nuker', 'tank', 'melee'],
    other: ['healer', 'support', 'nuker', 'tank', 'melee'],
};
const TARGET_ORDER: Role[] = ['tank', 'melee', 'healer', 'support', 'nuker'];

/** What a member's window pet takes from the leftover concentration, most important first: a fighter's. Off with []. */
export const PET_BUFF_NEEDS: BuffSlot[] = BUFF_NEEDS.melee;

export interface BuffOptions {
    needs?: Partial<Record<Role, BuffSlot[]>>;
    selfOnly?: Partial<Record<Role, BuffSlot[]>>;
    /** Slots for members' window pets (default PET_BUFF_NEEDS; [] for none). */
    petNeeds?: BuffSlot[];
    /** The caster's own concentration list (state.concentrationEffects): the only word on what is on a pet. */
    ownConc?: readonly Pick<ConcEntry, 'name' | 'ownerName'>[];
}

export interface BuffTask {
    spell: BuffSpell;
    /** Member name. */
    target: string;
    /** Position in the target's needs (0 = most important). */
    rank: number;
    /** The slot is already on the target (from anyone). */
    covered: boolean;
    /** ... and it is this very spell (so it is probably ours and ties up our concentration). */
    ours: boolean;
    /** A member's window pet, `target` being its name: the plan's last pass, from leftover concentration. */
    pet?: { owner: string; objectId: number };
}

const kind = (slot: BuffSlot) => (BASE.has(slot) ? 'base' : SPEC.has(slot) ? 'spec' : 'other');

/** A member's buff for `slot` usable on `target` (Self only on itself; Realm on anyone). */
function spellFor(m: MemberReport, slot: BuffSlot, onSelf: boolean): BuffSpell | undefined {
    const own = (m.capabilities.buffSpells ?? []).filter(s => s.slot === slot);
    return onSelf ? own.find(s => s.target === 'Self') ?? own.find(s => s.target === 'Realm') : own.find(s => s.target === 'Realm');
}

/** Who should keep `slot` up on `target`: the target itself when it can, else the first provider by role, or nobody. */
export function providerFor(slot: BuffSlot, target: MemberReport, members: MemberReport[], opts: BuffOptions = {}): MemberReport | null {
    if (!target.isDead && spellFor(target, slot, true)) return target;
    if ((opts.selfOnly ?? BUFF_SELF_ONLY)[target.role]?.includes(slot)) return null;
    for (const role of PROVIDERS[kind(slot)]) {
        const p = members.find(m => !m.isDead && m.role === role && m.name !== target.name && spellFor(m, slot, false));
        if (p) return p;
    }
    return null;
}

/** Slots on a member, from the names of its effects (known through everyone's buff lists). */
function slotsOn(m: MemberReport, bySpell: Map<string, BuffSlot>): Set<BuffSlot> {
    return new Set(m.effects.map(e => bySpell.get(e)).filter((s): s is BuffSlot => !!s));
}

/** The buffs `caster` is responsible for, in priority order (rounds over the targets' needs). */
export function planBuffs(caster: string, members: MemberReport[], opts: BuffOptions = {}): BuffTask[] {
    const me = members.find(m => m.name === caster);
    if (!me || me.isDead) return [];
    const needs = { ...BUFF_NEEDS, ...opts.needs };
    const bySpell = new Map<string, BuffSlot>();
    for (const m of members) for (const s of m.capabilities.buffSpells ?? []) bySpell.set(s.name, s.slot);
    const targets = members.filter(m => !m.isDead)
        .map((m, i) => ({ m, i }))
        // An observed member (a human, observed.ts) first: each round's first buff is its.
        .sort((a, b) => Number(!!b.m.observed) - Number(!!a.m.observed) || TARGET_ORDER.indexOf(a.m.role) - TARGET_ORDER.indexOf(b.m.role) || a.i - b.i)
        .map(x => x.m);
    // Each target's needs that someone in the group can provide, with that provider: a slot
    // nobody has yet (casters' acuity before the Druid gets it) doesn't hold up the next one.
    const wants = targets.map(t => (needs[t.role] ?? []).map(slot => ({ slot, by: providerFor(slot, t, members, opts) })).filter(w => w.by));
    const tasks: BuffTask[] = [];
    const longest = Math.max(0, ...wants.map(w => w.length));
    for (let rank = 0; rank < longest; rank++) {
        targets.forEach((t, i) => {
            const w = wants[i]![rank];
            if (!w || w.by!.name !== caster) return;
            // Group spells (songs) are cast once, below; a Group-only slot isn't a single-target task.
            const spell = spellFor(me, w.slot, t.name === caster);
            if (!spell) return;
            tasks.push({ spell, target: t.name, rank, covered: slotsOn(t, bySpell).has(w.slot), ours: t.effects.includes(spell.name) });
        });
    }
    // Group-wide buffs: the first member by role order who has one keeps it up.
    for (const s of me.capabilities.buffSpells ?? []) {
        if (s.target !== 'Group') continue;
        const owner = PROVIDERS.other.flatMap(r => members.filter(m => !m.isDead && m.role === r)).find(m => (m.capabilities.buffSpells ?? []).some(x => x.target === 'Group' && x.slot === s.slot));
        if (owner?.name !== caster) continue;
        tasks.push({ spell: s, target: caster, rank: 99, covered: me.effects.includes(s.name), ours: me.effects.includes(s.name) });
    }
    // Last, the window pets of living members, in the targets' order, rounds over their needs: concentration buffs from
    // the slot's provider by role (a pet casts none of its own). What is on one we know only from our own list.
    // A window pet, or an observed member's own (observedPet: a human's charmed mob), unless it is some member's window pet.
    const windowPets = new Set(members.map(m => m.pet?.objectId).filter(Boolean));
    const pets: { owner: string; pet: { objectId: number; name: string } }[] = [];
    for (const t of targets) {
        const pet = t.pet?.name && t.pet.objectId ? t.pet : t.observedPet && !windowPets.has(t.observedPet.objectId) ? t.observedPet : null;
        if (pet) pets.push({ owner: t.name, pet });
    }
    const petNeeds = opts.petNeeds ?? PET_BUFF_NEEDS;
    const own = opts.ownConc ?? [];
    for (let rank = 0; rank < petNeeds.length; rank++) {
        const slot = petNeeds[rank]!;
        for (const { owner, pet } of pets) {
            const spell = spellFor(me, slot, false);
            if (!spell || spell.concentration <= 0) continue;
            const by = PROVIDERS[kind(slot)].map(r => members.find(m => !m.isDead && m.role === r && spellFor(m, slot, false)?.concentration)).find(Boolean);
            if (by?.name !== caster) continue;
            const ours = own.some(c => c.ownerName === pet.name && sameSpell(spell.name, c.name));
            tasks.push({ spell, target: pet.name, rank: 100 + rank, covered: ours, ours, pet: { owner, objectId: pet.objectId } });
        }
    }
    return tasks;
}

/**
 * The server's cap on a caster's concentration effects, whatever its pool has left: "You can only cast up to 20 simultaneous
 * concentration spells!" (SpellHandler.cs:31 MAX_CONC_SPELLS, :836-839). A Cleric with ~32 planned hit it every round (arena
 * round 26, 2026-11-10). `effects`: how many it holds now (state.concentrationEffects).
 */
export const MAX_CONC_EFFECTS = 20;

/**
 * The next buff to cast within the caster's concentration (and its MAX_CONC_EFFECTS): walk the plan in order,
 * counting what our own active buffs tie up, and reserving room for buffs that
 * wait out a retry delay. Null when everything that fits is up.
 */
export function nextBuff(tasks: BuffTask[], conc: { current: number; max: number; effects?: number }, waiting: (t: BuffTask) => boolean = () => false): BuffTask | null {
    let budget = conc.max;
    const capped = (conc.effects ?? 0) >= MAX_CONC_EFFECTS;
    // A member's buff that fits the pool but not what is free now, or that waits, keeps its room from the pets: and a
    // pet buff never takes the last of the 20 effects while a member's still has to go up.
    let heldPool = 0, heldNow = 0, memberDue = 0;
    for (const t of tasks) {
        const cost = t.spell.concentration;
        if (t.pet && !t.covered && (cost > budget - heldPool || cost > conc.current - heldNow || (memberDue && (conc.effects ?? 0) + memberDue >= MAX_CONC_EFFECTS))) continue;
        if (t.covered) { if (t.ours) budget -= cost; continue; }
        if (cost > budget || (capped && cost > 0)) continue;
        if (waiting(t)) { budget -= cost; if (!t.pet && cost > 0) { heldNow += cost; memberDue++; } continue; }
        if (cost > conc.current) { if (!t.pet && cost > 0) { heldPool += cost; heldNow += cost; memberDue++; } continue; }
        return t;
    }
    return null;
}

/** One entry of the caster's concentration list (server 0x75): the server cuts names to ~12 characters plus "..". */
export interface ConcEntry { index: number; concentration: number; name: string; ownerName: string }

const sameSpell = (full: string, shown: string) => (shown.endsWith('..') ? full.startsWith(shown.slice(0, -2)) : full === shown);

/**
 * Our concentration buffs to drop: on a living member, but not one of our tasks
 * there, while some task of ours lacks the concentration to go up, or we hold MAX_CONC_EFFECTS already. Pulsing songs
 * (no concentration) are never dropped.
 */
export function surplusConcentration(tasks: BuffTask[], active: ConcEntry[], conc: { current: number }, members: MemberReport[]): ConcEntry[] {
    const missing = tasks.filter(t => !t.covered && t.spell.concentration > 0);
    const short = (list: BuffTask[]) => list.some(t => t.spell.concentration > conc.current) || (list.length > 0 && active.length >= MAX_CONC_EFFECTS);
    // A member's buff short of room: our buffs on pets go first, planned or not (they were the leftover).
    const petNames = new Set(members.flatMap(m => [m.pet?.name, m.observedPet?.name]).filter((n): n is string => !!n));
    const onPets = active.filter(a => a.concentration > 0 && petNames.has(a.ownerName));
    if (onPets.length && short(missing.filter(t => !t.pet))) return onPets;
    if (!short(missing)) return [];
    const living = new Set(members.filter(m => !m.isDead).map(m => m.name));
    return active.filter(a => a.concentration > 0 && living.has(a.ownerName)
        && !tasks.some(t => t.target === a.ownerName && sameSpell(t.spell.name, a.name)));
}
