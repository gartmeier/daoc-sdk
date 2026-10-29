import { describe, expect, test } from 'bun:test';
import { BotDisconnectedError, BotPreemptedError, runScript } from '../runner';
import { abortable, executionContext } from '../execution-context';

const stubSdk = () => ({ getState: () => null, getStateAge: () => 0, onConnectionStateChange: () => () => {} }) as any;

describe('runScript abort', () => {
    test('waits for the aborted script to finish its cleanup before returning', async () => {
        let cleanedUp = false;
        const run = await runScript(async () => {
            try {
                await abortable(Bun.sleep(5000));
            } finally {
                // Like ActionHelpers.cleanup: runs outside the aborted signal.
                await executionContext.exit(() => Bun.sleep(300));
                cleanedUp = true;
            }
        }, { connection: { bot: {} as any, sdk: stubSdk() }, timeout: 100, printState: false, onDisconnect: 'ignore' });
        expect(run.success).toBe(false);
        expect(run.error?.message).toContain('timeout');
        expect(cleanedUp).toBe(true);
    });

    test('a script that ignores the abort delays the runner by at most the settle window', async () => {
        const t0 = Date.now();
        const run = await runScript(() => Bun.sleep(10_000), {
            connection: { bot: {} as any, sdk: stubSdk() }, timeout: 50, printState: false, onDisconnect: 'ignore',
        });
        expect(run.success).toBe(false);
        expect(Date.now() - t0).toBeLessThan(4000);
    });
});

describe('runScript disconnects', () => {
    /** A connected SDK stub whose connection state the test drives. */
    const drivenSdk = (preempted: boolean) => {
        let listener: ((state: string) => void) | null = null;
        const sdk = {
            getState: () => null, getStateAge: () => 0, wasPreempted: () => preempted,
            onConnectionStateChange: (l: (state: string) => void) => { listener = l; return () => { listener = null; }; },
            waitForConnection: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('no reconnect')), 5000)),
        } as any;
        return { sdk, drop: () => listener?.('disconnected') };
    };
    const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
        const err = console.error;
        console.error = () => {};
        try { return await fn(); } finally { console.error = err; }
    };

    for (const onDisconnect of ['error', 'wait'] as const) {
        test(`a takeover by another controller aborts with BotPreemptedError at once (onDisconnect '${onDisconnect}')`, async () => {
            const { sdk, drop } = drivenSdk(true);
            setTimeout(drop, 30);
            const t0 = Date.now();
            const run = await quietly(() => runScript(() => abortable(Bun.sleep(10_000)), { connection: { bot: {} as any, sdk }, printState: false, onDisconnect }));
            expect(run.success).toBe(false);
            expect(run.error).toBeInstanceOf(BotPreemptedError);
            expect(run.error).toBeInstanceOf(BotDisconnectedError);
            expect(run.error?.message).toContain('another controller');
            expect(Date.now() - t0).toBeLessThan(3000);
        });
    }

    test('a real gateway loss is still a plain BotDisconnectedError', async () => {
        const { sdk, drop } = drivenSdk(false);
        setTimeout(drop, 30);
        const run = await quietly(() => runScript(() => abortable(Bun.sleep(10_000)), { connection: { bot: {} as any, sdk }, printState: false }));
        expect(run.error).toBeInstanceOf(BotDisconnectedError);
        expect(run.error).not.toBeInstanceOf(BotPreemptedError);
    });
});
