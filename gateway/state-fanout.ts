// Whether a bot's state frame can skip the fan-out to its SDK subscribers.
//
// Clients may publish a second frame for the same tick right after an action
// result. When the action hasn't changed anything visible yet, that frame
// repeats the previous one except for its revision and build timestamp.
// Subscribers learn nothing from it and get the next tick's frame instead.
// Frames from a new tick, or with any other difference, always go out.

import type { BotWorldState } from './types';

export function repeatsLastFanout(previous: BotWorldState | null, next: BotWorldState): boolean {
    if (!previous || previous === next || previous.tick !== next.tick) return false;
    return jsonIgnoringVolatile(previous) === jsonIgnoringVolatile(next);
}

function jsonIgnoringVolatile(state: BotWorldState): string {
    const s = state as BotWorldState & { revision?: number; timestamp?: number };
    const hasRevision = 'revision' in s;
    const hasTimestamp = 'timestamp' in s;
    const revision = s.revision;
    const timestamp = s.timestamp;
    if (hasRevision) s.revision = 0;
    if (hasTimestamp) s.timestamp = 0;
    try {
        return JSON.stringify(s);
    } finally {
        if (hasRevision) s.revision = revision;
        if (hasTimestamp) s.timestamp = timestamp;
    }
}
