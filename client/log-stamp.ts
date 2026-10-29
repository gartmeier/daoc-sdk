// Log line timestamps for the runner and the swarm.

/**
 * Local wall-clock time `HH:MM:SS.mmm`, the same clock the viewer shows for message times
 * (gateway/viewer/app.ts formats `receivedAt` with getHours()). Message times are the client's own
 * Date.now() at receipt, not server time.
 */
export function logStamp(d: Date = new Date()): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
