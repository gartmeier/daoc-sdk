// A fake headless client speaking the gateway protocol: registers as a bot,
// publishes fabricated BotWorldState snapshots on a timer and answers actions.
// Used by the in-process smoke tests and as a stand-in client/runner.ts.

import type { ActionResult, BotAction, BotWorldState } from '../types';
import { makeMessage, makeState } from './fixtures';

export interface FakeClientOptions {
    publishMs?: number;
    maxMessageLength?: number;
    /** Custom action handling; default moves on moveTo, echoes chat, succeeds. */
    onAction?: (action: BotAction, client: FakeClient) => ActionResult | Promise<ActionResult> | null;
}

export class FakeClient {
    ws: WebSocket | null = null;
    state: BotWorldState;
    actions: BotAction[] = [];
    savedAndDisconnected = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private nextMessageId = 100;

    constructor(readonly url: string, readonly username: string, readonly options: FakeClientOptions = {}) {
        this.state = makeState({ tick: 0, gameMessages: [] });
        if (this.state.player) this.state.player.name = username[0]!.toUpperCase() + username.slice(1);
    }

    async start(): Promise<void> {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('fake client could not connect')); });
        ws.onmessage = event => this.onMessage(JSON.parse(String(event.data)));
        ws.send(JSON.stringify({ type: 'connected', username: this.username, password: 'pw', clientId: `${this.username}-fake-${Date.now()}`, maxMessageLength: this.options.maxMessageLength }));
        this.publish();
        this.timer = setInterval(() => this.publish(), this.options.publishMs ?? 100);
    }

    publish(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.state = { ...this.state, tick: this.state.tick + 1, revision: this.state.revision + 1, timestamp: Date.now() };
        this.ws.send(JSON.stringify({ type: 'state', state: this.state }));
    }

    addMessage(text: string, type: BotWorldState['gameMessages'][number]['type'] = 'system', sender: string | null = null): void {
        const msg = makeMessage(this.nextMessageId++, text, { type, sender });
        this.state = { ...this.state, gameMessages: [...this.state.gameMessages, msg].slice(-100) };
    }

    private async onMessage(msg: any): Promise<void> {
        if (msg.type === 'save_and_disconnect') {
            this.savedAndDisconnected = true;
            this.stop();
            return;
        }
        if (msg.type !== 'action') return;
        const action = msg.action as BotAction;
        this.actions.push(action);
        let result = this.options.onAction ? await this.options.onAction(action, this) : null;
        if (!result) result = this.defaultAction(action);
        if (result === undefined) return;
        this.ws?.send(JSON.stringify({ type: 'actionResult', actionId: msg.actionId, result }));
        this.publish();
    }

    private defaultAction(action: BotAction): ActionResult {
        const p = this.state.player;
        switch (action.type) {
            case 'moveTo':
                if (p) this.state = { ...this.state, player: { ...p, x: action.x, y: action.y, z: action.z ?? p.z } };
                return { success: true, message: `Moving to (${action.x}, ${action.y})` };
            case 'say':
                this.addMessage(`You say, "${action.text}"`, 'say');
                return { success: true, message: 'Said' };
            case 'send':
                this.addMessage(`You send, "${action.text}" to ${action.to}.`, 'send');
                return { success: true, message: 'Sent' };
            case 'wait':
                return { success: true, message: 'Waited' };
            default:
                return { success: true, message: `ok: ${action.type}` };
        }
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        try { this.ws?.close(); } catch {}
        this.ws = null;
    }
}
