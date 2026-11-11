// Event-loop lag, measured passively: a timer asks to run every `everyMs` and records how late it ran. A process
// whose loop is blocked runs it late by the length of the block. A bot client that goes ~5 s without sending position
// updates goes link-dead, so this is the first number to watch when many bots share one process (client/swarm.ts) and
// for the gateway that carries them all.

export interface LoopLagWindow {
    /** Timer runs in the window. */
    samples: number;
    /** How late the timer ran, at most and on average (ms). */
    maxMs: number;
    meanMs: number;
    /** Runs that were more than 100 ms / 1 s late. */
    over100: number;
    over1000: number;
    /** Resident memory now (MB). */
    rssMb: number;
}

export interface LoopLag {
    /** The window since the last take(), then start a new one. */
    take(): LoopLagWindow;
    /** The window so far, without starting a new one. */
    peek(): LoopLagWindow;
    stop(): void;
}

/** Start sampling. The timer is unref'd: it never keeps a process alive. */
export function startLoopLag(everyMs = 100, now: () => number = () => performance.now()): LoopLag {
    let samples = 0, sum = 0, max = 0, over100 = 0, over1000 = 0;
    let expected = now() + everyMs;
    const timer = setInterval(() => {
        const t = now();
        const late = Math.max(0, t - expected);
        expected = t + everyMs;
        samples++;
        sum += late;
        if (late > max) max = late;
        if (late > 100) over100++;
        if (late > 1000) over1000++;
    }, everyMs);
    (timer as { unref?: () => void }).unref?.();
    const view = (): LoopLagWindow => ({
        samples, maxMs: Math.round(max), meanMs: samples ? Math.round((sum / samples) * 10) / 10 : 0, over100, over1000,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
    });
    return {
        peek: view,
        take() {
            const w = view();
            samples = 0; sum = 0; max = 0; over100 = 0; over1000 = 0;
            return w;
        },
        stop() { clearInterval(timer); },
    };
}

/** One line for a status log: "loop lag max 12 ms, mean 0.4 ms, 0 over 100 ms, rss 210 MB". */
export function loopLagLine(w: LoopLagWindow): string {
    return `loop lag max ${w.maxMs} ms, mean ${w.meanMs} ms, ${w.over100} over 100 ms${w.over1000 ? ` (${w.over1000} over 1 s)` : ''}, rss ${w.rssMb} MB`;
}
