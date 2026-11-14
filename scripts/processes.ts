// The machine's processes with their parents, for scripts/watch.ts (end with the shell that started it) and
// scripts/sweep-orphans.ts (end the pipeline processes whose shell is gone). On Windows Git Bash, a pipeline's tail, grep
// and awk outlive the shell that started them (memory note "monitor-pipelines-leak-on-windows").

export interface Proc {
    pid: number;
    ppid: number;
    name: string;
    /** Start time, ms since the epoch. */
    created: number;
}

/** Every process now: one PowerShell CIM query on Windows (about 0.8 s), `ps` elsewhere. */
export async function listProcesses(): Promise<Proc[]> {
    if (process.platform === 'win32') {
        const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,'
            + '@{n="Created";e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }}}'
            + ' | ConvertTo-Json -Compress';
        const p = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { stdout: 'pipe', stderr: 'pipe' });
        const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        if (code !== 0) throw new Error(`process list: powershell exited ${code}`);
        const rows = JSON.parse(text) as { ProcessId: number; ParentProcessId: number; Name: string; Created: number }[];
        return rows.map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name.toLowerCase(), created: r.Created }));
    }
    const p = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,etimes=,comm='], { stdout: 'pipe', stderr: 'pipe' });
    const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(`process list: ps exited ${code}`);
    const now = Date.now();
    return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [pid, ppid, etimes, ...rest] = l.split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), created: now - Number(etimes) * 1000, name: rest.join(' ').replace(/^.*\//, '').toLowerCase() };
    });
}

/** Wrappers between a command and whatever started it: shells, the mise shims, console hosts. */
export const SHELLS = new Set(['bash.exe', 'sh.exe', 'dash.exe', 'zsh.exe', 'cmd.exe', 'mise.exe', 'conhost.exe', 'bash', 'sh', 'dash', 'zsh', 'mise']);

/**
 * The processes a command lives for, from its parent up: every shell or wrapper on the way (Git's bash.exe starts an inner
 * bash, a mise shim starts the real bun), and the first process above them that is none of these (a Claude session, a
 * terminal, the supervisor). When any of them is gone, whoever wanted the command is gone. `self` is the command's own
 * process; a bun started through a shim has a bun parent, which counts as a wrapper too.
 */
export function guardians(list: Proc[], self: number): Proc[] {
    const byPid = new Map(list.map(p => [p.pid, p]));
    const me = byPid.get(self);
    const out: Proc[] = [];
    let cur = me ? byPid.get(me.ppid) : undefined;
    const seen = new Set<number>([self]);
    while (cur && !seen.has(cur.pid)) {
        seen.add(cur.pid);
        // A parent that started after its child is a reused id: the real parent is already gone.
        const child = out.at(-1) ?? me;
        if (child && cur.created > child.created + 1000) break;
        out.push(cur);
        const wrapper = SHELLS.has(cur.name) || (me && cur.name === me.name);
        if (!wrapper) break;
        cur = byPid.get(cur.ppid);
    }
    return out;
}

/** Whether the process with this id exists (signal 0 checks without sending anything). */
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The text tools a log-watching pipeline is made of: these never belong to a game client or a supervised process. */
export const PIPE_TOOLS = new Set(['tail.exe', 'grep.exe', 'awk.exe', 'gawk.exe', 'sed.exe', 'cut.exe', 'tee.exe', 'tail', 'grep', 'awk', 'gawk', 'sed', 'cut', 'tee']);

/**
 * Pipeline processes whose parent is gone (no process with that id, or one that started after them: the id was reused),
 * older than minAgeMs. Only PIPE_TOOLS: a bun, a game client or a shell is never picked.
 */
export function orphans(list: Proc[], now: number, minAgeMs: number): Proc[] {
    const byPid = new Map(list.map(p => [p.pid, p]));
    return list.filter(p => {
        if (!PIPE_TOOLS.has(p.name)) return false;
        if (now - p.created < minAgeMs) return false;
        const parent = byPid.get(p.ppid);
        return !parent || parent.created > p.created + 1000;
    });
}
