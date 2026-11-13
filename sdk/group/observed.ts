// Observed members: group members with no member agent, such as a human playing alongside the bots.
//
// Nothing of theirs reaches the board on its own, so it is put together from what the bots' clients get:
// - health, power, endurance, dead and "in another region" from the server's group window, which every member's
//   client keeps (0x16/06 who is in it, 0x70 GroupMemberUpdate their status; client world-model.ts, BotWorldState.group);
// - where it stands from the member clients that have it in view (their nearbyPlayers entry);
// - what it fights from the combat events those clients see: its swings and hostile spells, as for an enemy player's target;
// - the concentration buffs bots hold on it, from each caster's own concentration list (0x75): the server sends no
//   one else's effects by name.
//
// It goes on the picture as a member report marked `observed`, after the bots' reports. So it is healed, buffed, rezzed
// and guarded like any member (before them: behaviors.ts), it holds a formation slot without being moved, and it counts
// where members are counted (outnumbered, retreat, wipes). It is never chosen to act: it has no capabilities, its
// activity is 'observed', and its role is never 'tank', so it is never the tank, the puller, a mezzer or the leader.
//
// With no observed member configured none of this runs: observeState reports nothing more and the picture is unchanged.

import type { BotWorldState, GroupMember } from '../types';
import { roleForClass } from './strategy';
import type { Capabilities, MemberReport, Role } from './types';

/** One observed member as group.json names it: its character name, and a role if the class's doesn't fit (never 'tank'). */
export interface ObservedEntry {
    name: string;
    role?: Exclude<Role, 'tank'>;
}

/** What one member's client knows of an observed groupmate in one snapshot (Observation.groupmates). */
export interface Groupmate {
    name: string;
    className: string;
    level: number;
    objectId: number;
    /** From the group window. */
    hp: number;
    mana: number;
    endurance: number;
    isDead: boolean;
    /** Not in this member's region, as the window says. */
    inOtherRegion: boolean;
    /** Where this member's client has it, absent out of view. `at` is the snapshot's: the entry is there while the server keeps it in view, moving or not. */
    seen?: { regionId: number; x: number; y: number; z: number; inCombat: boolean; isSitting: boolean; at: number };
    /** Its latest swing or hostile spell this member saw, at whom and when; absent with none in the aim window. */
    aim?: { targetId: number; at: number };
    /** Concentration buffs this member holds on it, by full spell name. Absent with none. */
    buffs?: string[];
    /** Its own pet as this member sees it: the nearest pet of our realm within OBSERVED_PET_NEAR of it that isn't ours. Absent with none. */
    pet?: { objectId: number; name: string; x: number; y: number; z: number; at: number };
}

/** No capabilities: nothing on the board asks an observed member to do anything. */
const NONE: Capabilities = { heal: false, cc: false, nuke: false, rez: false, buffs: [], buffSpells: [], pet: null };

/** A position nobody has refreshed for this long is no longer where it is: regionId reads OUT_OF_SIGHT. */
export const OBSERVED_STALE_MS = 5000;
/** The region of an observed member no member has in view: no region-scoped rule (heal reach, rez, formation counts) takes it. */
export const OUT_OF_SIGHT = -1;
/** An observed member hitting something this recently is fighting it (attacking, targetId). */
export const OBSERVED_AIM_MS = 6000;
/**
 * Bots leave a target an observed member is hitting to it at or below this % (TacticsSettings.observed.leaveBelow).
 * Off (-1: no target is ever that low): the user, playing Niamh on 2026-11-13, "Get rid of that. Kill everything" after
 * Conall stood idle 7 times leaving a Norseman to them. A strategy can still set its own leaveBelow.
 */
export const LEAVE_BELOW = -1;
/** A pet of our realm this near an observed member, no member's, is taken for its own (a charmed mob follows within ~100-300). */
export const OBSERVED_PET_NEAR = 400;

/** The role an observed member plays in targeting: group.json's, else its class's, a tank class read as melee. */
export function observedRole(className: string, role?: Role): Role {
    const r = role ?? roleForClass(className);
    return r === 'tank' ? 'melee' : r;
}

const lower = (s: string) => s.toLowerCase();

/**
 * What this member's client knows of the named groupmates (pure): the window's entry, the player entry in view, its
 * latest aim among `aims` (attacker id → target and time, from observeState's combat events) and the concentration
 * buffs we hold on it. `ownBuffs` names our buff spells in full: the 0x75 list cuts names to ~12 characters plus "..".
 */
export function groupmatesOf(state: Pick<BotWorldState, 'group' | 'nearbyPlayers' | 'timestamp' | 'concentrationEffects' | 'player'> & Partial<Pick<BotWorldState, 'nearbyNpcs' | 'pet'>>, names: readonly string[],
    aims: ReadonlyMap<number, { targetId: number; at: number }>, ownBuffs: readonly string[] = []): Groupmate[] {
    const want = new Set(names.map(lower));
    const p = state.player;
    const out: Groupmate[] = [];
    for (const g of (state.group ?? []) as GroupMember[]) {
        if (!want.has(lower(g.name)) || (p && lower(g.name) === lower(p.name))) continue;
        const o = state.nearbyPlayers.find(x => x.objectId === g.objectId) ?? state.nearbyPlayers.find(x => lower(x.name) === lower(g.name));
        const aim = aims.get(o?.objectId ?? g.objectId);
        const buffs = (state.concentrationEffects ?? []).filter(c => lower(c.ownerName) === lower(g.name))
            .map(c => ownBuffs.find(full => sameSpellName(full, c.name)) ?? c.name);
        const pet = o && p ? (state.nearbyNpcs ?? [])
            .filter(n => n.isPet && n.realm === p.realm && n.objectId !== state.pet?.objectId && n.healthPercent > 0 && Math.hypot(n.x - o.x, n.y - o.y) <= OBSERVED_PET_NEAR)
            .sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0] : undefined;
        out.push({
            name: g.name, className: g.className, level: g.level, objectId: o?.objectId ?? g.objectId,
            hp: g.healthPercent, mana: g.manaPercent, endurance: g.endurancePercent, isDead: g.isDead, inOtherRegion: g.inOtherRegion,
            ...(o && p ? { seen: { regionId: p.regionId, x: o.x, y: o.y, z: o.z, inCombat: o.inCombat, isSitting: o.isSitting, at: state.timestamp } } : {}),
            ...(aim && state.timestamp - aim.at < OBSERVED_AIM_MS ? { aim: { ...aim } } : {}),
            ...(buffs.length ? { buffs } : {}),
            ...(pet ? { pet: { objectId: pet.objectId, name: pet.name, x: pet.x, y: pet.y, z: pet.z, at: state.timestamp } } : {}),
        });
    }
    return out;
}

/** A 0x75 name ("Strength of ..") against the full one. */
export const sameSpellName = (full: string, shown: string) => (shown.endsWith('..') ? full.startsWith(shown.slice(0, -2)) : full === shown);

/** What the board keeps of one observed member between reports. */
interface Kept {
    entry: ObservedEntry;
    /** The freshest window reading, from whichever member published last. */
    window: Groupmate | null;
    windowAt: number;
    seen: NonNullable<Groupmate['seen']> | null;
    aim: { targetId: number; at: number } | null;
    pet: NonNullable<Groupmate['pet']> | null;
    /** Concentration buffs on it, by the member holding them. */
    buffsBy: Map<string, string[]>;
    since: number;
}

/**
 * The board's observed members (Blackboard holds one). `merge` takes each member's groupmates as it publishes;
 * `reports` turns them into member reports for the picture, in group.json's order.
 */
export class ObservedMembers {
    private readonly kept = new Map<string, Kept>();
    /**
     * A human asked to be picked up (voice.ts readGroupAsk, the runner): until a member sees them or `until` passes, an
     * observed member nobody sees reads at `place` (our portal keep's arrival), so the group's regroup walks there
     * (rvr.ts holdObservedFar). Live 2026-11-13, Niamh: released to the PK, out of every bot's sight, never picked up.
     */
    private readonly pickups = new Map<string, { place: { regionId: number; x: number; y: number; z: number }; asked: number; until: number }>();

    /** Read `name`, while nobody sees them, at `place` until `until` (or until a member sees them after `asked`). */
    pickup(name: string, place: { regionId: number; x: number; y: number; z: number }, asked: number, until: number): boolean {
        if (!this.kept.has(lower(name))) return false;
        this.pickups.set(lower(name), { place: { ...place }, asked, until });
        return true;
    }

    /** The pickups still open, by name. */
    pickupsOpen(now: number): string[] {
        return [...this.pickups].filter(([, p]) => p.until > now).map(([n]) => this.kept.get(n)?.entry.name ?? n);
    }

    constructor(entries: readonly ObservedEntry[] = []) {
        for (const e of entries) this.kept.set(lower(e.name), { entry: e, window: null, windowAt: 0, seen: null, aim: null, pet: null, buffsBy: new Map(), since: 0 });
    }

    get size(): number { return this.kept.size; }
    names(): string[] { return [...this.kept.values()].map(k => k.entry.name); }
    has(name: string): boolean { return this.kept.has(lower(name)); }

    /** One member's view: the window and the position win by recency, the aim by its time. */
    merge(by: string, mates: readonly Groupmate[], at: number): void {
        const named = new Set<string>();
        for (const g of mates) {
            const k = this.kept.get(lower(g.name));
            if (!k) continue;
            named.add(lower(g.name));
            if (at >= k.windowAt) { k.window = g; k.windowAt = at; }
            if (g.seen && (!k.seen || g.seen.at >= k.seen.at)) k.seen = { ...g.seen };
            if (g.aim && (!k.aim || g.aim.at >= k.aim.at)) k.aim = { ...g.aim };
            if (g.pet && (!k.pet || g.pet.at >= k.pet.at)) k.pet = { ...g.pet };
            if (g.buffs?.length) k.buffsBy.set(by, [...g.buffs]); else k.buffsBy.delete(by);
            if (!k.since) k.since = at;
        }
        // Not in this member's window (it left the group, or this member did): what it held on it is gone with that.
        for (const [key, k] of this.kept) if (!named.has(key)) k.buffsBy.delete(by);
    }

    /** A member that stopped publishing (gone from the run) holds nothing on anyone. */
    forget(by: string): void {
        for (const k of this.kept.values()) k.buffsBy.delete(by);
    }

    /** Reports for those any member's window has shown, as of `now`. */
    reports(now: number): MemberReport[] {
        const out: MemberReport[] = [];
        for (const k of this.kept.values()) {
            const w = k.window;
            if (!w) continue;
            // Seen lately by anyone is here, whatever a window of a member elsewhere says of regions.
            const seen = k.seen && now - k.seen.at <= OBSERVED_STALE_MS ? k.seen : null;
            const aim = k.aim && now - k.aim.at < OBSERVED_AIM_MS && !w.isDead ? k.aim : null;
            const pet = k.pet && now - k.pet.at <= OBSERVED_STALE_MS && !w.isDead ? k.pet : null;
            // A pickup: ends once seen after the ask (then out of sight again reads as ever) or at its time.
            const key = lower(w.name);
            const pk = this.pickups.get(key);
            if (pk && (pk.until <= now || (k.seen && k.seen.at > pk.asked))) this.pickups.delete(key);
            const pick = !seen && !w.isDead ? this.pickups.get(key)?.place ?? null : null;
            out.push({
                name: w.name, bot: '', role: observedRole(w.className, k.entry.role), className: w.className, level: w.level, experience: 0,
                objectId: w.objectId, regionId: pick?.regionId ?? seen?.regionId ?? OUT_OF_SIGHT,
                x: pick?.x ?? k.seen?.x ?? 0, y: pick?.y ?? k.seen?.y ?? 0, z: pick?.z ?? k.seen?.z ?? 0,
                hp: w.hp, mana: w.mana, endurance: w.endurance, load: 0, isDead: w.isDead,
                isSitting: !!seen?.isSitting, inCombat: !!seen?.inCombat || !!aim, attacking: !!aim, targetId: aim?.targetId ?? null,
                effects: [...new Set([...k.buffsBy.values()].flat())],
                capabilities: { ...NONE, buffs: [], buffSpells: [] },
                activity: { kind: 'observed', targetId: aim?.targetId ?? null, detail: '', since: k.since },
                at: k.windowAt, observed: true,
                ...(pet ? { observedPet: { objectId: pet.objectId, name: pet.name, x: pet.x, y: pet.y, z: pet.z } } : {}),
            });
        }
        return out;
    }
}

/** The observed member (alive, hitting `c`) that bots leave `c` to, `c` being at or below `leaveBelow` %; undefined otherwise. */
export function finishedBy(members: readonly MemberReport[], c: { objectId: number; hp: number }, leaveBelow = LEAVE_BELOW): MemberReport | undefined {
    if (c.hp > leaveBelow) return undefined;
    return members.find(m => m.observed && !m.isDead && m.attacking && m.targetId === c.objectId);
}
