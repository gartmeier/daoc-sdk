import { describe, expect, test } from 'bun:test';
import { loopLagLine, startLoopLag } from '../loop-lag';

describe('loop lag', () => {
    test('a blocked loop shows as a late timer; take() starts a new window', async () => {
        const lag = startLoopLag(20);
        try {
            await Bun.sleep(60);
            const end = performance.now() + 250;
            while (performance.now() < end) { /* block the loop */ }
            await Bun.sleep(60);
            const w = lag.take();
            expect(w.samples).toBeGreaterThan(2);
            expect(w.maxMs).toBeGreaterThanOrEqual(150);
            expect(w.over100).toBeGreaterThanOrEqual(1);
            expect(w.rssMb).toBeGreaterThan(0);
            expect(loopLagLine(w)).toContain(`max ${w.maxMs} ms`);
            expect(lag.peek().maxMs).toBeLessThan(150);
        } finally {
            lag.stop();
        }
    });
});
