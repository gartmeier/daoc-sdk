#!/usr/bin/env bun
// End the log-watching pipeline processes (tail, grep, awk, sed, cut, tee) whose shell is gone. On Windows Git Bash they
// outlive the Monitor or shell that started them: 1,579 piled up over the 2026-11-13/14 stint, filled 71 of 74 GB and
// dropped the user's game client (memory note "monitor-pipelines-leak-on-windows"). Run by groups/supervisor-extra.json.
//
//   bun scripts/sweep-orphans.ts [--every=600] [--min-age=1800] [--dry-run] [--once]
//
// - Only the text tools in PIPE_TOOLS whose parent process is gone (or whose parent id was reused), older than
//   `--min-age` seconds: never a bun, a game client, a shell or the docker containers.
// - A line per round that found orphans, plus one an hour with the counts (pipeline tools, orphaned bash shells,
//   console hosts) and the machine's commit charge, so a slow leak shows in the log before it hurts.

import { listProcesses, orphans, type Proc } from './processes';

const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const EVERY_MS = Number(flag('every') ?? 600) * 1000;
const MIN_AGE_MS = Number(flag('min-age') ?? 1800) * 1000;
const DRY = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** Commit charge in GB (used / limit) on Windows; null elsewhere or when it can't be read. */
async function commitGb(): Promise<string | null> {
    if (process.platform !== 'win32') return null;
    const script = '$o = Get-CimInstance Win32_OperatingSystem; "{0:N1} of {1:N1}" -f (($o.TotalVirtualMemorySize - $o.FreeVirtualMemory) / 1MB), ($o.TotalVirtualMemorySize / 1MB)';
    const p = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { stdout: 'pipe', stderr: 'pipe' });
    const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? text.trim() : null;
}

export function summary(list: Proc[], now: number): string {
    const count = (names: string[]) => list.filter(p => names.includes(p.name)).length;
    const byPid = new Map(list.map(p => [p.pid, p]));
    const lostBash = list.filter(p => (p.name === 'bash.exe' || p.name === 'bash') && !byPid.has(p.ppid)).length;
    return `tail/grep/awk/sed/cut/tee ${count(['tail.exe', 'grep.exe', 'awk.exe', 'gawk.exe', 'sed.exe', 'cut.exe', 'tee.exe', 'tail', 'grep', 'awk', 'gawk', 'sed', 'cut', 'tee'])}`
        + `, orphaned bash ${lostBash}, conhost ${count(['conhost.exe'])}, orphans younger than the limit ${orphans(list, now, 0).length - orphans(list, now, MIN_AGE_MS).length}`;
}

async function round(lastSummary: number): Promise<number> {
    const now = Date.now();
    let list: Proc[];
    try {
        list = await listProcesses();
    } catch (e) {
        log(`process list failed: ${(e as Error).message}`);
        return lastSummary;
    }
    const found = orphans(list, now, MIN_AGE_MS);
    if (found.length) {
        const names = new Map<string, number>();
        for (const p of found) names.set(p.name, (names.get(p.name) ?? 0) + 1);
        let ended = 0;
        if (!DRY) for (const p of found) {
            try {
                process.kill(p.pid);
                ended++;
            } catch {
                // gone meanwhile
            }
        }
        log(`${DRY ? 'would end' : `ended ${ended} of`} ${found.length} orphaned pipeline processes: ${[...names].map(([n, c]) => `${n} ${c}`).join(', ')}`);
    }
    if (ONCE || now - lastSummary >= 3_600_000) {
        log(`${summary(list, now)}; commit ${(await commitGb()) ?? '?'} GB`);
        return now;
    }
    return lastSummary;
}

if (import.meta.main) {
    log(`sweep up: every ${EVERY_MS / 1000} s, orphans older than ${MIN_AGE_MS / 1000} s${DRY ? ', dry run' : ''}`);
    let last = 0;
    last = await round(last);
    if (!ONCE) for (;;) {
        await Bun.sleep(EVERY_MS);
        last = await round(last);
    }
}
