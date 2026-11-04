// Crowd control as the server runs it, for the board and the behaviours (learnings/spells.md "Crowd control").
//
// A kind's immunity sits on the target, whoever cast it, and each kind has its own (EffectHelper.GetImmunityEffectFromSpell):
// a mezz says nothing about a root. Players: no shorter durations, but nothing of a kind lands while one is on or for 60 s
// after it ends. Monsters: mezz and stun halve instead, and a root has no limit at all.

import { getSpells } from '../../data/index';
import { spellMessagePattern } from '../actions-helpers';
import type { GameMessage } from '../types';
import type { Contact } from './types';

/** 'root' also stands for a snare: the same immunity. */
export type CcKind = 'mezz' | 'root' | 'stun';

/**
 * A player's immunity after a kind ends. A root's is the effect's default (ECSGameEffect.cs ImmunityDuration); a mezz's
 * and a stun's are the server property immunity_timer_flat_length, 60 by default, which reaches no client. An "immune"
 * answer is all a client hears of it, so a server with another length shows up as casts answered that way.
 */
/** How a crowd-control walk announces itself: `${CC_WALK}${spell}`. For the report, which counts other walks in a fight as positioning. */
export const CC_WALK = 'cc: into range for ';
export const CC_IMMUNE_MS = 60_000;
/** A monster's repeats of a mezz or stun shorten for this long after the first, however often it is hit again (NpcImmunityEffect). */
const NPC_CC_WINDOW_MS = 60_000;
/** A monster takes no mezz or stun that would last less than this (NpcImmunityEffect.CanApplyNewEffect). */
const NPC_CC_MIN_MS = 1000;

export function ccKindOfType(type: string): CcKind | null {
    switch (type) {
        case 'Mesmerize': return 'mezz';
        case 'Stun': return 'stun';
        case 'SpeedDecrease': case 'UnbreakableSpeedDecrease': return 'root';
    }
    return null;
}

/** Until when a kind can't land on it, by kind. */
export type CcImmunity = Partial<Record<CcKind, number>>;

export const ccImmuneTo = (c: Pick<Contact, 'ccImmune'>, kind: CcKind, now = Date.now()): boolean => (c.ccImmune?.[kind] ?? 0) > now;

/** The kinds that can't land on it now. */
export const immuneKinds = (c: Pick<Contact, 'ccImmune'>, now = Date.now()): CcKind[] =>
    (Object.keys(c.ccImmune ?? {}) as CcKind[]).filter(k => ccImmuneTo(c, k, now));

/** One of these kinds can land on it. A report from before `ccKinds` counts as a mezz or a root. */
export const canControl = (c: Pick<Contact, 'ccImmune'>, kinds: readonly CcKind[] | undefined, now = Date.now()): boolean =>
    (kinds ?? ['mezz', 'root']).some(k => !ccImmuneTo(c, k, now));

/** A monster's run of one kind: how many landed since the window opened. */
export interface NpcCcRun { count: number; since: number }

/**
 * A mezz or stun landing on a monster: how long it really lasts, the run after it, and whether the next would be too
 * short to take. The first lasts in full and each later one `duration / (2 * count)`, so a 7 s stun went 7, 3.5, 1.75,
 * 1.2, then immune, live (NpcImmunityEffect.CalculateNewEffectDuration, CrowdControlECSEffect.cs).
 */
export function npcCcLanded(run: NpcCcRun | undefined, baseMs: number, now: number): { durationMs: number; run: NpcCcRun; immuneUntil: number | null } {
    const current = run && now - run.since < NPC_CC_WINDOW_MS ? run : null;
    const count = current?.count ?? 0;
    const since = current?.since ?? now;
    const durationMs = count ? baseMs / (2 * count) : baseMs;
    const next = { count: count + 1, since };
    return { durationMs, run: next, immuneUntil: baseMs / (2 * next.count) < NPC_CC_MIN_MS ? since + NPC_CC_WINDOW_MS : null };
}

/** How the server names one in a message: an enemy player by its real name (never the race we see), a monster with its article. */
export const serverNameKey = (name: string): string => name.replace(/^(the|an?) /i, '').toLowerCase();

let endPatterns: { pattern: RegExp; kind: CcKind }[] | null = null;
function endsOf(): { pattern: RegExp; kind: CcKind }[] {
    if (endPatterns) return endPatterns;
    const seen = new Map<string, CcKind>();
    for (const s of getSpells()) {
        const kind = ccKindOfType(s.type);
        if (kind && s.effectEnds?.includes('{0}')) seen.set(s.effectEnds, kind);
    }
    endPatterns = [...seen].map(([template, kind]) => ({ pattern: spellMessagePattern(template), kind }));
    return endPatterns;
}

/** Someone's crowd control ended, as the server told everyone within 512 of it (WorldMgr.INFO_DISTANCE; the caster gets no copy of its own). Most roots have no such line. */
export interface CcEnd { name: string; kind: CcKind; at: number }

/** The ends among messages received after `since`. */
export function readCcEnds(messages: readonly GameMessage[], since: number): CcEnd[] {
    const out: CcEnd[] = [];
    for (const m of messages) {
        if (m.type !== 'spellExpires' || m.receivedAt <= since) continue;
        for (const { pattern, kind } of endsOf()) {
            const hit = pattern.exec(m.text);
            if (hit) { out.push({ name: hit[1]!, kind, at: m.receivedAt }); break; }
        }
    }
    return out;
}
