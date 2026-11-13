// "lfg": a human of our realm asks for a group, and a unit of bots takes them in (pure; lfg-watch.ts does the IO).
//
//   ask      A whisper to any bot of the realm ("lfg", "lfg ment", "can I join?"), or "lfg" in /region. Its class comes
//            from the words if they name one, else the bot asks ("what class?") and the next whisper answers.
//   place    The realm's main groups (not the squads) whose run is up and who have no human yet: one missing the human's
//            role first, then the one with fewest of it, then the bigger. One bot of it steps out for them: of the
//            human's role if the unit has one, else of its most doubled role; never the leader, never a class the
//            group requires (Hibernia's Druid and Bard).
//   then     The unit's group.json names the human under `observed` (observed.ts), the bot logs off, the unit's run
//            winds down and the next sortie invites them. Once they have left the group, the bot comes back.

import type { Role } from './types';
import { CLASS_NAMES, roleForClass } from './strategy';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the words

/** A message that asks for a group. */
const ASK = /\b(lfg|lf\s?grp|lf\s?group|looking for (a )?group|need (a )?group|any room|room for (one|1|me)|can i join|inv(ite)? (me|pls|plz|please)|x\s?me)\b/i;

/** Short names players use for classes. */
const ALIASES: Record<string, string> = {
    ment: 'Mentalist', menta: 'Mentalist', ench: 'Enchanter', chanter: 'Enchanter', eld: 'Eldritch', eldy: 'Eldritch', ani: 'Animist',
    bm: 'Blademaster', champ: 'Champion', ns: 'Nightshade', vw: 'Valewalker', guard: 'Guardian',
    zerk: 'Berserker', sb: 'Shadowblade', rm: 'Runemaster', sm: 'Spiritmaster', bd: 'Bonedancer', warr: 'Warrior', hunt: 'Hunter',
    arms: 'Armsman', pally: 'Paladin', merc: 'Mercenary', inf: 'Infiltrator', infil: 'Infiltrator', wiz: 'Wizard', theu: 'Theurgist', theur: 'Theurgist',
    sorc: 'Sorcerer', cab: 'Cabalist', necro: 'Necromancer', mins: 'Minstrel', minst: 'Minstrel', cleri: 'Cleric',
};

/** The class a message names ("lfg ment", "I'm a druid", "mentalist"), or null. */
export function classOf(text: string): string | null {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    for (const w of words) {
        const exact = CLASS_NAMES.find(c => c.toLowerCase() === w);
        if (exact) return exact;
        if (ALIASES[w]) return ALIASES[w];
    }
    // A prefix of four or more letters that only one class has ("menta", "drui").
    for (const w of words) {
        if (w.length < 4) continue;
        const hits = CLASS_NAMES.filter(c => c.toLowerCase().startsWith(w));
        if (hits.length === 1) return hits[0]!;
    }
    return null;
}

/** What a message to us says: an ask for a group (with a class if named), a class alone (the answer to ours), or nothing. */
export function readLfg(text: string): { ask: boolean; className: string | null } {
    return { ask: ASK.test(text), className: classOf(text) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── where they go

export interface LfgMember { bot: string; className: string; role: Role }

export interface LfgUnit {
    unit: string;
    /** Bot of the leader (group.json leader, else the first member). */
    leader: string;
    members: LfgMember[];
    /** Observed members it has now (a unit takes one human). */
    observed: string[];
    /** group.json requires.classes: a list in it is any one of those. */
    requires?: (string | string[])[];
    /** Its run is up (a sortie running). */
    running: boolean;
    /** A small squad (groups/<realm>-s<n>): no place for a human. */
    squad: boolean;
}

export interface Placement { unit: string; stepOut: string | null; why: string }

/** The roles a placement counts by: a tank reads as melee, as observed.ts reads a human. */
const roleKey = (r: Role): Role => (r === 'tank' ? 'melee' : r);

/** A class the unit needs to keep: one entry of `requires` that only this member fills. */
function required(u: LfgUnit, m: LfgMember): boolean {
    for (const req of u.requires ?? []) {
        const any = (Array.isArray(req) ? req : [req]).map(s => s.toLowerCase());
        if (!any.includes(m.className.toLowerCase())) continue;
        const fillers = u.members.filter(x => any.includes(x.className.toLowerCase()));
        if (fillers.length <= 1) return true;
    }
    return false;
}

/** Who steps out of `u` for a human of `role`: null when nobody may (only the leader and required classes left). */
export function stepOutOf(u: LfgUnit, role: Role): LfgMember | null {
    const free = u.members.filter(m => m.bot !== u.leader && !required(u, m));
    if (!free.length) return null;
    const count = (r: Role) => u.members.filter(m => roleKey(m.role) === roleKey(r)).length;
    const same = free.filter(m => roleKey(m.role) === roleKey(role));
    if (same.length) return same.at(-1)!;
    // The most doubled role, the last such member (the line-up's own order puts its core first).
    const most = Math.max(...free.map(m => count(m.role)));
    return free.filter(m => count(m.role) === most).at(-1) ?? null;
}

/** The unit a human of `className` joins, and who steps out for them; null when no unit can take one. */
export function placeHuman(units: readonly LfgUnit[], className: string): Placement | null {
    const role = roleKey(roleForClass(className));
    const open = units.filter(u => !u.squad && u.running && u.observed.length === 0 && u.members.length >= 3);
    const has = (u: LfgUnit) => u.members.filter(m => roleKey(m.role) === role).length;
    const ranked = [...open].sort((a, b) => has(a) - has(b) || b.members.length - a.members.length || a.unit.localeCompare(b.unit));
    for (const u of ranked) {
        const out = stepOutOf(u, role);
        if (!out) continue;
        const n = has(u);
        return { unit: u.unit, stepOut: out.bot, why: `${n ? `${n} ${role}` : `no ${role}`} in ${u.unit} of ${u.members.length}; ${out.bot} (${out.className}) steps out` };
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── the answers

/** What the whispered bot answers, as a player would. `leader` is the unit leader's character name. */
export const LFG_SAY = {
    whatClass: 'sure, what class are you?',
    placed: (leader: string) => `inv coming from ${leader} in a minute, we're at our PK or on the way out`,
    full: 'sorry, all full right now, try again in a bit',
} as const;
