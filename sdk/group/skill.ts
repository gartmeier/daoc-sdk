// A member's skill at the keyboard: how fast it reacts, how long it takes to change target, and how often it slips.
//
// Off by default: with no `skill` set, a member sees the board as it is and acts at once, as before.
// On, each member looks at the group's picture and orders through its own SkillLens (MemberContext.picture/orders):
//   - reaction: a contact new to its picture is acted on only reactionMs later (each one drawn ±25 %). Human vision's
//     notice delay (sdk/vision.ts, 800 ms) comes first: a contact is in the picture only once a member has noticed it.
//   - switch: a new focus from the coordinator is taken up switchMs after the order (±25 %), and only once reacted to.
//     Until then the member stays on the old focus while that one lives, else waits. Into a first focus only the
//     reaction counts; a focus dropped (none ordered) is dropped at once, so a retreat is never late.
//   - mistakes, each at mistakeRate per occasion: a switch that lands on the wrong enemy for a while (then switches
//     again, to the right one), a heal that comes late when a groupmate first drops under LATE_HEAL_BELOW, and a
//     style choice swapped for a positional style, wherever the member stands.
//
// The plan doc's guide: people read as human at about 200-500 ms of reaction.
//
// Set per run or per member, in a strategy's settings or by flag (runGroup puts unknown flags into the settings):
//   --skill=average                          every member
//   --skill.reactionMs=300                   average with this changed (a set without preset starts from average)
//   --skill.realms.midgard=sharp             the members of one realm (field mode passes its flags to every realm);
//                                            a realm by its name (albion) or its group's (camelot)
//   --skill.members.Thorgrim=novice          one member, by bot folder name
//   --skill=off                              none (also: no skill at all)
//   --skill.ab=20                            an A/B in one run: on only in every other 20-minute slot, by when the
//                                            run's process started (field mode starts one per sortie: a sortie is all on or all off)
// A member's own entry beats its realm's, which beats the group-wide one.

import type { Realm } from '../types';
import { isAlive } from './blackboard';
import type { Contact, GroupPicture, MemberReport, Orders } from './types';

export interface Skill {
    /** From a contact's first appearance in the member's picture to acting on it, ms. */
    reactionMs: number;
    /** From a new focus order to acting on it, ms (with reactionMs: whichever ends later). */
    switchMs: number;
    /** Chance of a slip per occasion (a switch, a fresh heal need, a style choice), 0..1. */
    mistakeRate: number;
}

export type SkillPreset = 'novice' | 'average' | 'sharp';

export const SKILL_PRESETS: Readonly<Record<SkillPreset, Readonly<Skill>>> = {
    novice: { reactionMs: 550, switchMs: 1200, mistakeRate: 0.08 },
    average: { reactionMs: 350, switchMs: 750, mistakeRate: 0.04 },
    sharp: { reactionMs: 220, switchMs: 450, mistakeRate: 0.015 },
};

/** One member's value: a preset, 'off', or numbers over a preset (default average). */
export type SkillValue = SkillPreset | 'off' | (Partial<Skill> & { preset?: SkillPreset | 'off' });

/** The setting: a value for everyone, with per-realm and per-member values over it. */
export type SkillSetting = SkillValue | (Partial<Skill> & {
    preset?: SkillPreset | 'off';
    realms?: Partial<Record<Realm, SkillValue>>;
    members?: Record<string, SkillValue>;
    /** Minutes: on only in the odd slots of this length (abSlot), for an A/B within one run. */
    ab?: number;
});

/** A realms key: the realm's name or its group's (groups/camelot is Albion's). */
const REALM_KEYS: Record<string, Realm> = { albion: 'albion', camelot: 'albion', midgard: 'midgard', hibernia: 'hibernia' };

const LIMITS: Record<keyof Skill, number> = { reactionMs: 3000, switchMs: 5000, mistakeRate: 1 };

function presetOf(name: unknown, where: string): Skill | null {
    if (name === 'off') return null;
    const p = SKILL_PRESETS[name as SkillPreset];
    if (!p) throw new Error(`${where}: expected novice, average, sharp or off, got ${String(name)}`);
    return { ...p };
}

/** A value on its own (no realms or members): the skill, or null for off. */
function resolveValue(v: unknown, where: string): Skill | null {
    if (v === undefined || v === null || v === false || v === 'false') return null;
    if (typeof v === 'string') return presetOf(v, where);
    if (typeof v !== 'object') throw new Error(`${where}: expected a preset or { reactionMs, switchMs, mistakeRate }, got ${String(v)}`);
    const o = v as Partial<Skill> & { preset?: unknown };
    const unknown = Object.keys(o).filter(k => k !== 'preset' && !(k in LIMITS));
    if (unknown.length) throw new Error(`${where}: unknown ${unknown.join(', ')} (expected preset, reactionMs, switchMs, mistakeRate)`);
    const base = o.preset === undefined ? { ...SKILL_PRESETS.average } : presetOf(o.preset, `${where}.preset`);
    if (!base) return null;
    for (const k of Object.keys(LIMITS) as (keyof Skill)[]) {
        if (o[k] === undefined) continue;
        const n = Number(o[k]);
        if (!(n >= 0 && n <= LIMITS[k])) throw new Error(`${where}.${k}: expected 0..${LIMITS[k]}, got ${String(o[k])}`);
        base[k] = n;
    }
    return base;
}

/**
 * One member's skill from a setting, or null (off): its own entry (by bot folder name, any case), else its realm's, else
 * the group-wide value. Throws on a value it can't read, so a typo in a flag stops the run at its start.
 */
export function resolveSkill(setting: unknown, bot: string, realm?: Realm | null, startedAt?: number): Skill | null {
    if (setting === undefined || setting === null || typeof setting !== 'object') return resolveValue(setting, '--skill');
    if (startedAt !== undefined && abSlot(setting, startedAt) === 'off') return null;
    const { realms, members, ab: _ab, ...rest } = setting as { realms?: Record<string, unknown>; members?: Record<string, unknown>; ab?: unknown };
    const own = members && Object.entries(members).find(([name]) => name.toLowerCase() === bot.toLowerCase());
    if (own) return resolveValue(own[1], `--skill.members.${own[0]}`);
    const mine = realm && realms ? Object.entries(realms).find(([key]) => REALM_KEYS[key.toLowerCase()] === realm) : undefined;
    if (mine) return resolveValue(mine[1], `--skill.realms.${mine[0]}`);
    return Object.keys(rest).length ? resolveValue(rest, '--skill') : null;
}

/**
 * With `ab` (minutes): 'on' in the odd slots of that length since the epoch, 'off' in the even ones, by `at` (a run's
 * process start); null without. Every member of one process lands in the same slot.
 */
export function abSlot(setting: unknown, at: number): 'on' | 'off' | null {
    const ab = setting && typeof setting === 'object' ? Number((setting as { ab?: unknown }).ab) : NaN;
    if (!(ab > 0)) return null;
    return Math.floor(at / (ab * 60_000)) % 2 === 1 ? 'on' : 'off';
}

/** Check a whole setting (every realm and member entry), for a run's start. */
export function checkSkillSetting(setting: unknown): void {
    if (setting === undefined || setting === null || typeof setting !== 'object') { resolveValue(setting, '--skill'); return; }
    const { realms, members, ab, ...rest } = setting as { realms?: Record<string, unknown>; members?: Record<string, unknown>; ab?: unknown };
    if (ab !== undefined && !(Number(ab) > 0)) throw new Error(`--skill.ab: expected minutes > 0, got ${String(ab)}`);
    for (const [r, v] of Object.entries(realms ?? {})) {
        if (!REALM_KEYS[r.toLowerCase()]) throw new Error(`--skill.realms.${r}: expected albion (camelot), midgard or hibernia`);
        resolveValue(v, `--skill.realms.${r}`);
    }
    for (const [m, v] of Object.entries(members ?? {})) resolveValue(v, `--skill.members.${m}`);
    if (Object.keys(rest).length) resolveValue(rest, '--skill');
}

/** "reaction 350 ms, switch 750 ms, mistakes 4 %", or "off". */
export function describeSkill(s: Skill | null): string {
    return s ? `reaction ${s.reactionMs} ms, switch ${s.switchMs} ms, mistakes ${+(s.mistakeRate * 100).toFixed(1)} %` : 'off';
}

/** A contact out of the picture this long is new again when it comes back (as the notice clock's grace, sdk/vision.ts). */
export const REACTION_GRACE_MS = 3000;
/** A groupmate dropping under this health % is a fresh heal need, where a late heal can happen. Back over it re-arms. */
export const LATE_HEAL_BELOW = 80;
/** Behaviours a late heal holds back, by name. */
export const HEAL_BEHAVIOR = /heal/i;

/**
 * A style choice is asked for on every snapshot while swinging, several times a second: at most one roll per this long,
 * about a swing (run B, 2026-11-12: one roll per call slipped Galahad 15 times in 30 s).
 */
export const STYLE_ROLL_MS = 3000;

/** What a slip did, for the run's log (MemberAgent emits it as a note). */
export interface Slip {
    kind: 'wrong target' | 'late heal' | 'off-position style';
    text: string;
}

/**
 * One member's view of the board through its skill. Pure but for the clock and the dice it is given: the agent calls view()
 * with the board's picture and orders (fresh copies each time) and gets back what the member acts on.
 */
export class SkillLens {
    /** Per contact id: when it was last in the picture, and from when the member acts on it. */
    private readonly seen = new Map<number, { last: number; after: number }>();
    /** The focus the member acts on now (null: none). */
    private current: number | null = null;
    /** The board's focus the member is switching to, and from when it may. */
    private pending: { target: number; at: number; correction: boolean } | null = null;
    /** A wrong target taken on a switch, until when. */
    private wrong: { target: number; until: number } | null = null;
    /** Groupmates under LATE_HEAL_BELOW at the last look. */
    private hurt = new Set<string>();
    private lateHealUntil = 0;
    private styleRollAt = -Infinity;
    readonly slips: Slip[] = [];

    constructor(readonly skill: Skill, private readonly rng: () => number = Math.random) {}

    /** base ±25 %. */
    private draw(base: number): number {
        return Math.round(base * (0.75 + 0.5 * this.rng()));
    }

    private slip(): boolean {
        return this.skill.mistakeRate > 0 && this.rng() < this.skill.mistakeRate;
    }

    private note(kind: Slip['kind'], text: string): void {
        this.slips.push({ kind, text });
        if (this.slips.length > 50) this.slips.shift();
    }

    /** Take the slips noted since the last call. */
    takeSlips(): Slip[] {
        return this.slips.splice(0);
    }

    /** Whether the member has reacted to this contact by `now` (one it has never seen: no). */
    reacted(id: number, now: number): boolean {
        const s = this.seen.get(id);
        return !!s && now >= s.after;
    }

    /**
     * The picture and orders the member acts on. `keep`: ids it acts on whatever (its own target, a contact hitting it is
     * not among them: that too waits for the reaction). Returns the same objects when nothing differs.
     */
    view(picture: GroupPicture, orders: Orders, now: number, keep: ReadonlySet<number> = new Set()): { picture: GroupPicture; orders: Orders } {
        for (const c of picture.contacts) {
            const s = this.seen.get(c.objectId);
            if (s && now - s.last <= REACTION_GRACE_MS) s.last = now;
            else this.seen.set(c.objectId, { last: now, after: now + this.draw(this.skill.reactionMs) });
        }
        for (const [id, s] of this.seen) if (now - s.last > REACTION_GRACE_MS) this.seen.delete(id);

        const visible = (c: Contact) => keep.has(c.objectId) || this.reacted(c.objectId, now) || c.objectId === this.current;
        const contacts = picture.contacts.every(visible) ? picture.contacts : picture.contacts.filter(visible);
        const focus = this.focusFor(orders, contacts, now);
        const seenOrders = focus === orders.focus ? orders : { ...orders, focus };
        if (contacts === picture.contacts && seenOrders === orders) return { picture, orders };
        return { picture: { ...picture, contacts, orders: seenOrders }, orders: seenOrders };
    }

    private focusFor(orders: Orders, contacts: Contact[], now: number): number | null {
        const target = orders.focus;
        if (target === null || target === undefined) {
            this.current = null; this.pending = null; this.wrong = null;
            return null;
        }
        const live = (id: number | null) => id !== null && contacts.some(c => c.objectId === id && isAlive(c));
        if (this.wrong) {
            if (now < this.wrong.until && live(this.wrong.target) && target !== this.wrong.target) return this.wrong.target;
            // Seen it: off the wrong one, onto the right one, in a switch's time.
            this.current = this.wrong.target;
            this.wrong = null;
            this.pending = target === this.current ? null : { target, at: now + this.draw(this.skill.switchMs), correction: true };
        }
        if (target === this.current) { this.pending = null; return target; }
        if (!this.pending || this.pending.target !== target) {
            // From no focus (or a dead one's grace): only the reaction. From a live one: the switch as well.
            const from = this.current !== null;
            this.pending = { target, at: from ? now + this.draw(this.skill.switchMs) : now, correction: false };
        }
        if (now < this.pending.at || !this.reacted(target, now)) return live(this.current) ? this.current : null;
        const correction = this.pending.correction;
        const switched = this.current !== null;
        this.pending = null;
        if (switched && !correction && this.slip()) {
            // One of its kind that the member could mistake for it: alive, fighting us or a player, not held by our crowd control.
            const kind = contacts.find(f => f.objectId === target)?.kind;
            const others = contacts.filter(c => c.objectId !== target && isAlive(c) && (!kind || c.kind === kind) && (c.threat || c.kind === 'player') && !c.cc && !c.isShade);
            const wrong = others.length ? others[Math.floor(this.rng() * others.length)]! : null;
            if (wrong) {
                const hold = this.draw(this.skill.switchMs * 2 + 1000);
                this.wrong = { target: wrong.objectId, until: now + hold };
                this.current = wrong.objectId;
                this.note('wrong target', `wrong target: ${wrong.name} (${wrong.objectId}) for ${(hold / 1000).toFixed(1)} s instead of ${target}`);
                return wrong.objectId;
            }
        }
        this.current = target;
        return target;
    }

    /**
     * Once a turn: a groupmate newly under LATE_HEAL_BELOW starts a late heal at mistakeRate, for about a switch's time and
     * a second (holdBack).
     */
    watchHealth(members: readonly Pick<MemberReport, 'name' | 'isDead' | 'hp'>[], now: number): void {
        const hurtNow = new Set(members.filter(m => !m.isDead && m.hp < LATE_HEAL_BELOW).map(m => m.name));
        for (const name of hurtNow) {
            if (this.hurt.has(name) || now < this.lateHealUntil || !this.slip()) continue;
            const late = this.draw(this.skill.switchMs + 1000);
            this.lateHealUntil = now + late;
            this.note('late heal', `late heal: ${name} under ${LATE_HEAL_BELOW} %, ${(late / 1000).toFixed(1)} s late`);
        }
        this.hurt = hurtNow;
    }

    /** Whether a behaviour by this name sits this turn out: heals (HEAL_BEHAVIOR) while a late heal runs. */
    holdBack(behavior: string, now: number): boolean {
        return now < this.lateHealUntil && HEAL_BEHAVIOR.test(behavior);
    }

    /**
     * A style choice, now and then (mistakeRate) swapped for the member's best positional style, wherever it stands.
     * `positional`: the member's positional style names. The choice as it came when there is none or no slip. At most one
     * roll per STYLE_ROLL_MS, and a slip changes that one choice.
     */
    styleSlip<T extends string | readonly string[] | null | undefined>(choice: T, positional: readonly string[], now = Date.now()): T | string[] {
        if (!positional.length || choice === null || choice === undefined || (Array.isArray(choice) && !choice.length)) return choice;
        const queue = typeof choice === 'string' ? [choice] : [...(choice as readonly string[])];
        const pick = positional.find(p => p !== queue[0]);
        if (!pick || now - this.styleRollAt < STYLE_ROLL_MS) return choice;
        this.styleRollAt = now;
        if (!this.slip()) return choice;
        this.note('off-position style', `off-position style: ${pick} instead of ${queue[0]}`);
        return [pick, ...queue.slice(1)];
    }
}
