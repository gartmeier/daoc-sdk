// How well the board read enemy players' classes (Contact.classGuess), scored against the truth: in the arena every
// enemy is one of our own bots, whose class its own client knows. The truth is for the report only and never reaches
// the board or a strategy: the runner polls it from the gateway (classTruthFromGateway) and hands it to the observer.

import { roleOfClass } from './class-read';
import type { GroupPicture } from './types';

/** One enemy player's read over a run. */
export interface ClassReadRow {
    /** "Dwarf #1234": what the group calls it. */
    enemy: string;
    /** Its real class, when the truth knew it. */
    truth: string | null;
    /** The last read: "Healer 0.81, Shaman 0.12". */
    read: string;
    /** The last read's role, and the truth's. */
    role: string | null;
    truthRole: string | null;
    /** Seconds from first sight to the read that stayed right to the end (top class = truth); null: never, or not known. */
    rightAfterS: number | null;
    /** The same from its first moment as a threat (its fight with us); 0 if right before it; null: never fought or never right. */
    rightInFightS: number | null;
    /** The last read's top class is the truth. */
    right: boolean;
    roleRight: boolean;
    /** What the last read went by. */
    basis: string;
    /** The top class each time it changed: "0s Warrior, 6s Healer". */
    path: string;
}

export interface ClassReads {
    /** Enemies with a read; those with a truth to score against. */
    enemies: number;
    scored: number;
    /** Of the scored: last read right; right and stayed so within 10 s of first sight; within 10 s of its fight; role right. */
    right: number;
    rightIn10s: number;
    fought: number;
    rightIn10sOfFight: number;
    roleRight: number;
    rows: ClassReadRow[];
}

interface Track {
    name: string;
    objectId: number;
    firstSeen: number;
    threatAt: number | null;
    /** Each change of the top class, and the last read. */
    changes: { at: number; top: string }[];
    last: NonNullable<GroupPicture['contacts'][number]['classGuess']>;
}

/** The truth: real class by "regionId:objectId". */
export type ClassTruth = () => ReadonlyMap<string, string>;

const RIGHT_WITHIN_S = 10;

export class ClassReadLog {
    private readonly tracks = new Map<string, Track>();

    sample(p: GroupPicture): void {
        for (const c of p.contacts) {
            if (c.kind !== 'player' || !c.classGuess) continue;
            const key = `${c.regionId}:${c.objectId}`;
            let t = this.tracks.get(key);
            const top = c.classGuess.classes[0] ?? '?';
            if (!t || t.name !== c.name) this.tracks.set(key, t = { name: c.name, objectId: c.objectId, firstSeen: Math.min(c.firstSeen, p.at), threatAt: null, changes: [], last: c.classGuess });
            if (c.threat && t.threatAt === null) t.threatAt = p.at;
            if (t.changes.at(-1)?.top !== top) t.changes.push({ at: p.at, top });
            t.last = c.classGuess;
        }
    }

    result(truth: ReadonlyMap<string, string> | null): ClassReads | null {
        if (!this.tracks.size) return null;
        const rows: ClassReadRow[] = [];
        const fought = new Set<ClassReadRow>();
        for (const [key, t] of this.tracks) {
            const real = truth?.get(key) ?? null;
            const last = t.changes.at(-1)!;
            // The read that stayed: the last change, if it names the truth.
            const stayedAt = real !== null && last.top === real ? last.at : null;
            const truthRole = real ? roleOfClass(real) ?? null : null;
            const row: ClassReadRow = {
                enemy: `${t.name} #${t.objectId}`, truth: real,
                read: t.last.classes.map((c, i) => `${c} ${t.last.p[i]}`).join(', '),
                role: t.last.role ?? null, truthRole,
                rightAfterS: stayedAt === null ? null : Math.max(0, Math.round((stayedAt - t.firstSeen) / 1000)),
                rightInFightS: stayedAt === null || t.threatAt === null ? null : Math.max(0, Math.round((stayedAt - t.threatAt) / 1000)),
                right: stayedAt !== null, roleRight: truthRole !== null && t.last.role === truthRole,
                basis: t.last.basis.join('; '),
                path: t.changes.map(ch => `${Math.round((ch.at - t.firstSeen) / 1000)}s ${ch.top}`).join(', '),
            };
            rows.push(row);
            if (real !== null && t.threatAt !== null) fought.add(row);
        }
        const scored = rows.filter(r => r.truth !== null);
        return {
            enemies: rows.length, scored: scored.length,
            right: scored.filter(r => r.right).length,
            rightIn10s: scored.filter(r => r.rightAfterS !== null && r.rightAfterS <= RIGHT_WITHIN_S).length,
            fought: fought.size,
            rightIn10sOfFight: [...fought].filter(r => r.rightInFightS !== null && r.rightInFightS <= RIGHT_WITHIN_S).length,
            roleRight: scored.filter(r => r.roleRight).length,
            rows: rows.sort((a, b) => a.enemy.localeCompare(b.enemy)),
        };
    }
}

/** The report's lines: a summary sentence and a table. */
export function formatClassReads(r: ClassReads): string[] {
    const lines = ['', '## Class reads', '',
        `Read ${r.enemies} enemy players; ${r.scored} against the truth: right at the end ${r.right}, right within 10 s of first sight ${r.rightIn10s}, within 10 s of their fight ${r.rightIn10sOfFight} of ${r.fought}, role right ${r.roleRight}.`,
        '', '| Enemy | Truth | Read | Role | Right after | In its fight | Path | Basis |', '|---|---|---|---|---|---|---|---|'];
    for (const x of r.rows) {
        const role = x.role ?? '-';
        lines.push(`| ${x.enemy} | ${x.truth ?? '?'} | ${x.read} | ${x.truthRole && x.truthRole !== x.role ? `${role} (is ${x.truthRole})` : role} | ${x.rightAfterS === null ? (x.truth ? 'never' : '-') : `${x.rightAfterS} s`} | ${x.rightInFightS === null ? '-' : `${x.rightInFightS} s`} | ${x.path} | ${x.basis} |`);
    }
    return lines;
}

/**
 * The truth for scoring, from the gateway: every bot outside `ours` that publishes state, by its own client's
 * className, objectId and region. Polls every `everyMs`; errors leave the last answer. For the observer only:
 * nothing here may feed the board or a strategy. DAOC_CLASS_TRUTH=0 turns it off.
 */
export function classTruthFromGateway(httpBase: string, ours: ReadonlySet<string>, everyMs = 15_000): { truth: ClassTruth; stop: () => void } {
    const known = new Map<string, string>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const get = async (path: string) => {
        const res = await fetch(`${httpBase}${path}`, { signal: AbortSignal.timeout(3000) });
        return res.ok ? res.json() as Promise<any> : null;
    };
    const poll = async () => {
        try {
            const status = await get('/status');
            for (const bot of Object.keys(status?.bots ?? {})) {
                if (stopped || ours.has(bot) || !status.bots[bot]?.inGame) continue;
                const p = (await get(`/state/${encodeURIComponent(bot)}`).catch(() => null))?.state?.player;
                if (p?.objectId && p.className) known.set(`${p.regionId}:${p.objectId}`, p.className);
            }
        } catch { /* gateway busy or gone: keep what we had */ }
        if (!stopped) timer = setTimeout(poll, everyMs);
    };
    if (process.env.DAOC_CLASS_TRUTH !== '0') void poll();
    return { truth: () => known, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
