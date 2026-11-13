// The voice's transport (voice.ts is the pure part).
//
// Group chat: the run (runner.ts) hears its board every tick and its leader says the line (`/group`).
// `/region`: the director's process hears each update (regionVoiceHook) and writes the line, naming the unit that says
// it, to <dir>/<realm>-voice.json; each unit's run reads that file (regionInbox) and its leader says the lines named
// for it (`/region`). Units run in their own processes and own their bots, so a file is the whole interface, as for
// the director's calls. DAOC_VOICE=off silences both.

import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTOR_DIR, type DirectorUpdate } from './director';
import type { PlayerRealm } from './keeps';
import { RegionVoice, type Line } from './voice';

export const voiceOn = () => (process.env.DAOC_VOICE ?? 'on') !== 'off';

/** <dir>/<realm>-voice.json */
export interface RegionVoiceFile {
    v: 1;
    realm: PlayerRealm;
    lines: { id: number; text: string; by: string; at: number }[];
}

export const regionVoicePath = (realm: PlayerRealm, dir = DIRECTOR_DIR) => join(dir, `${realm}-voice.json`);

/** A line older than this when a unit reads it is not said: a stale call is worse than none. */
export const REGION_LINE_STALE_MS = 12_000;

function readFile(path: string): RegionVoiceFile | null {
    try {
        const f = JSON.parse(readFileSync(path, 'utf8')) as RegionVoiceFile;
        return f && f.v === 1 && Array.isArray(f.lines) ? f : null;
    } catch { return null; }
}

/** Append one line for `by` to say (keeps the newest 20). */
export function writeRegionLine(realm: PlayerRealm, line: { text: string; by: string; at: number }, dir = DIRECTOR_DIR): void {
    const path = regionVoicePath(realm, dir);
    const f = readFile(path) ?? { v: 1, realm, lines: [] };
    const id = (f.lines.at(-1)?.id ?? 0) + 1;
    f.lines = [...f.lines, { id, ...line }].slice(-20);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f));
    renameSync(tmp, path);
}

/**
 * The director's side: call it with each update (field.ts's onUpdate). `enabled` is the director's switch (the calls
 * are published); off, nothing is said. Returns the line written, if any.
 */
export function regionVoiceHook(realm: PlayerRealm, enabled: () => boolean, opts: { dir?: string; regionId?: number; nearFoe?: number; log?: (s: string) => void } = {}) {
    const voice = new RegionVoice();
    return (out: DirectorUpdate, now = Date.now()): Line | null => {
        if (!voiceOn()) return null;
        try {
            const line = voice.hear({
                realm, regionId: opts.regionId, enabled: enabled(), calls: out.calls, foes: out.board.foes, events: out.events,
                running: out.board.units.filter(u => u.running).map(u => u.unit),
            }, now, opts.nearFoe);
            if (line?.by) {
                writeRegionLine(realm, { text: line.text, by: line.by, at: line.at }, opts.dir);
                opts.log?.(`region ${realm} (${line.by}): ${line.text}`);
            }
            return line;
        } catch (e) {
            opts.log?.(`region voice ${realm}: ${(e as Error).message}`);
            return null;
        }
    };
}

/** A unit's side: take() returns the lines named for `unit` it hasn't said yet, fresh ones only. */
export function regionInbox(unit: string, realm: PlayerRealm, dir = DIRECTOR_DIR) {
    const path = regionVoicePath(realm, dir);
    let mtime = 0;
    // Lines written before the run started are not ours to say.
    let lastId = readFile(path)?.lines.at(-1)?.id ?? 0;
    return {
        take(now = Date.now()): string[] {
            let m = 0;
            try { m = statSync(path).mtimeMs; } catch { return []; }
            if (m === mtime) return [];
            mtime = m;
            const f = readFile(path);
            if (!f) return [];
            // A file started over (the director's dir cleaned): ids from 1 again.
            if ((f.lines.at(-1)?.id ?? 0) < lastId) lastId = 0;
            const mine = f.lines.filter(l => l.id > lastId && l.by === unit && now - l.at <= REGION_LINE_STALE_MS).map(l => l.text);
            lastId = Math.max(lastId, f.lines.at(-1)?.id ?? 0);
            return mine;
        },
    };
}
