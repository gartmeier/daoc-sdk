// One group member: publishes what its client sees to the blackboard and runs
// its behaviours, a priority list tried top to bottom every turn.
//
// Behaviours are where autonomy lives: reactions (release, flee, emergency heal)
// sit above order-following (pull, assist, hold formation) and idle chores
// (buff, rest). A material orders change interrupts an interruptible behaviour
// (walks, fights, rests) so the member re-decides at once; casts finish.

import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import type { PlayerState } from '../types';
import { abortable, executionContext } from '../execution-context';
import { type Blackboard, observeState } from './blackboard';
import type { Character } from './character';
import { Spellbook } from './spells';
import type { Activity, Capabilities, Contact, GroupPicture, MemberCombat, MemberReport, Orders, Role } from './types';

export interface Behavior<S = any> {
    name: string;
    /** Return true when it acted (the loop starts over from the top), false to fall through. */
    run(ctx: MemberContext<S>): Promise<boolean> | boolean;
    /** false lets a material orders change wait until it finishes (casts are short). Default true. */
    interruptible?: boolean;
}

/** A connected bot taking part in the group. */
export interface Member {
    /** Bot folder name (bots/<bot>/). */
    bot: string;
    role: Role;
    sdk: BotSDK;
    actions: BotActions;
    /** bots/<bot>/character.ts, if it has one. */
    character?: Character | null;
}

/** Count one server message into a member's combat record. */
export function countCombatMessage(text: string, combat: MemberCombat): void {
    // A critical hit is its own message, on top of the hit. "Your X hits" is a DoT's tick (DoTSpellHandler.cs:87) or a pet's blow.
    const hit = /^You (?:(?:attack|shoot) .+ (?:and|but) hit|hit .+) for (\d+)/.exec(text)
        ?? /^You critical(?:ly)? hit .*for an additional (\d+)/.exec(text)
        ?? /^Your .+ hits .+ for (\d+)/.exec(text);
    if (hit) { combat.dealt += Number(hit[1]); return; }
    const landed = /^You perform your (.+?) perfectly/.exec(text);
    if (landed) { combat.styles[landed[1]!] = (combat.styles[landed[1]!] ?? 0) + 1; return; }
    if (/^You fail to execute your /.test(text)) combat.missedStyles++;
}

class Interrupted extends Error {
    constructor(reason: string) { super(`interrupted: ${reason}`); this.name = 'Interrupted'; }
}

/** What a behaviour sees: its own character in full, everyone else through the shared picture. */
export class MemberContext<S = any> {
    readonly bot: BotActions;
    readonly sdk: BotSDK;
    readonly spells: Spellbook;
    /** Per-member scratch space, kept across turns (e.g. DoTs already on a mob). */
    readonly memory = new Map<string, any>();

    constructor(private readonly agent: MemberAgent<S>, readonly settings: S) {
        this.bot = agent.member.actions;
        this.sdk = agent.member.sdk;
        this.spells = agent.spells;
    }

    get role(): Role { return this.agent.member.role; }
    get name(): string { return this.me()?.name ?? this.agent.member.bot; }
    me(): PlayerState { return this.sdk.getPlayer()!; }
    picture(): GroupPicture { return this.agent.board.picture(); }
    orders(): Orders { return this.agent.board.getOrders(); }
    members(): MemberReport[] { return this.picture().members; }
    member(name: string): MemberReport | undefined { return this.members().find(m => m.name === name); }
    /** The living tank, if the group has one. */
    tank(): MemberReport | undefined { return this.members().find(m => m.role === 'tank' && !m.isDead); }
    isTank(): boolean { return this.role === 'tank'; }
    contact(id: number | null | undefined): Contact | undefined {
        return id === null || id === undefined ? undefined : this.picture().contacts.find(c => c.objectId === id);
    }
    /** The orders' focus target, if the group knows it. */
    focus(): Contact | undefined { return this.contact(this.orders().focus); }
    /** Enemies fighting the group (see Contact.threat). */
    threats(): Contact[] { return this.picture().contacts.filter(c => c.threat); }

    /** Announce what we are doing (and on what): others see it as our claim. */
    doing(kind: string, targetId: number | null = null, detail = ''): void { this.agent.setActivity(kind, targetId, detail); }
    /** Why a behaviour did not act; shown as the idle reason when nothing acts. */
    skip(reason: string): false { this.agent.lastSkip = reason; return false; }
    /** Record an action's outcome for the observer (casts, pulls, kills). */
    result(kind: string, r: { success: boolean; reason?: string; message?: string }, targetId: number | null = null): void {
        this.agent.board.emit({
            at: Date.now(), kind: 'result', member: this.name, targetId,
            text: `${kind}: ${r.success ? 'ok' : r.reason ?? 'failed'}${r.message ? ` (${r.message})` : ''}`,
            data: { action: kind, success: r.success, reason: r.reason ?? null },
        });
    }
    note(text: string): void { this.agent.board.emit({ at: Date.now(), kind: 'note', member: this.name, text }); }
    /** Tell the group a mob is crowd-controlled for `durationMs`. */
    markCc(targetId: number, kind: string, durationMs: number): void {
        this.agent.board.markCc(targetId, this.me().regionId, this.name, kind, durationMs);
    }
    /** Tell the group crowd control can't land on it for `durationMs` (it answered "immune"). */
    markCcImmune(targetId: number, durationMs: number): void {
        this.agent.board.markCcImmune(targetId, this.me().regionId, durationMs);
    }
}

export interface MemberAgentOptions {
    /** Report monsters and enemy players within this distance (default 3000). */
    sightRadius?: number;
    /** Pause when no behaviour acts (default 300 ms). */
    idleMs?: number;
    /** Shortest turn: a behaviour that "acts" faster than this is paced, so none can spin (default 250 ms). */
    minTurnMs?: number;
}

export class MemberAgent<S = any> {
    readonly spells: Spellbook;
    readonly ctx: MemberContext<S>;
    lastSkip = '';
    private activity: Activity = { kind: 'idle', targetId: null, detail: '', since: Date.now() };
    private capabilities: Capabilities;
    private capsAt = 0;
    private readonly combat: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 };
    private lastMessageId: number;
    private current: { controller: AbortController; interruptible: boolean } | null = null;
    private readonly unsubscribe: (() => void)[] = [];

    constructor(readonly member: Member, readonly board: Blackboard, readonly behaviors: Behavior<S>[], settings: S, private readonly options: MemberAgentOptions = {}) {
        this.spells = new Spellbook(member.sdk, member.actions);
        this.capabilities = this.currentCapabilities();
        this.ctx = new MemberContext(this, settings);
        this.lastMessageId = member.sdk.getGameMessages().at(-1)?.id ?? -1;
        this.unsubscribe.push(member.sdk.onStateUpdate(() => this.publish()));
        this.unsubscribe.push(board.onOrders((next, prev) => { if (this.affected(next, prev)) this.interrupt(`orders: ${next.phase}`); }));
        this.publish();
    }

    /** From the spell list; rez only if our list also casts it, since corpses wait for whoever says it can. */
    private currentCapabilities(): Capabilities {
        const caps = this.spells.capabilities();
        return { ...caps, rez: !!caps.rez && this.behaviors.some(b => b.name === 'rez') };
    }

    /** Push our latest snapshot (with the current activity) to the blackboard. */
    publish(): void {
        const state = this.member.sdk.getState();
        if (!state) return;
        if (Date.now() - this.capsAt > 30_000) { this.capabilities = this.currentCapabilities(); this.capsAt = Date.now(); }
        for (const m of state.gameMessages) if (m.id > this.lastMessageId) countCombatMessage(m.text, this.combat);
        this.lastMessageId = state.gameMessages.at(-1)?.id ?? this.lastMessageId;
        const obs = observeState(state, { bot: this.member.bot, role: this.member.role, activity: this.activity, capabilities: this.capabilities, combat: this.combat }, this.options.sightRadius);
        if (obs) this.board.publish(obs);
    }

    setActivity(kind: string, targetId: number | null, detail: string): void {
        const a = this.activity;
        if (a.kind === kind && a.targetId === targetId && a.detail === detail) return;
        this.activity = { kind, targetId, detail, since: Date.now() };
        if (kind !== 'idle') {
            this.board.emit({ at: Date.now(), kind: 'activity', member: this.ctx.name, targetId, text: `${kind}${detail ? ` ${detail}` : ''}`, data: { activity: kind, detail } });
        }
        this.publish();
    }

    /** Does this orders change concern us? (Another member's mezz assignment doesn't stop our fight.) */
    private affected(next: Orders, prev: Orders): boolean {
        if (next.phase !== prev.phase || next.focus !== prev.focus || next.puller !== prev.puller) return true;
        const mine = (o: Orders) => o.cc.filter(c => c.by === this.ctx.name).map(c => c.targetId).join(',');
        const moved = (a: Orders['anchor'], b: Orders['anchor']) => !a !== !b || (!!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) > 300);
        return mine(next) !== mine(prev) || moved(next.retreatTo, prev.retreatTo) || (next.phase !== 'engage' && moved(next.anchor, prev.anchor));
    }

    /** Abort the running behaviour if it may be interrupted. */
    interrupt(reason: string): void {
        if (this.current?.interruptible) this.current.controller.abort(new Interrupted(reason));
    }

    /** Run behaviours until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            const turn = Date.now();
            let acted = false;
            for (const b of this.behaviors) {
                if (signal.aborted) break;
                if (await this.step(b, signal)) { acted = true; break; }
            }
            const pause = acted ? (this.options.minTurnMs ?? 250) - (Date.now() - turn) : this.options.idleMs ?? 300;
            if (!acted && !signal.aborted) this.setActivity('idle', null, this.lastSkip);
            if (pause > 0 && !signal.aborted) await abortable(Bun.sleep(pause), signal).catch(() => {});
            this.lastSkip = '';
        }
    }

    private async step(b: Behavior<S>, signal: AbortSignal): Promise<boolean> {
        const controller = new AbortController();
        const onParent = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onParent, { once: true });
        this.current = { controller, interruptible: b.interruptible !== false };
        let raw: Promise<boolean> = Promise.resolve(false);
        try {
            const store = executionContext.getStore();
            return await executionContext.run({ ...store, signal: controller.signal }, () => {
                raw = Promise.resolve().then(() => b.run(this.ctx));
                return abortable(raw);
            });
        } catch (error) {
            if (signal.aborted) throw error;
            // Let the behaviour's own cleanup (attack off, stop) land before the next one starts.
            await Promise.race([raw.catch(() => {}), Bun.sleep(2000)]);
            if (controller.signal.reason instanceof Interrupted) return true;
            if (!this.member.sdk.isConnected()) throw error;
            this.board.emit({ at: Date.now(), kind: 'note', member: this.ctx.name, text: `${b.name} threw: ${(error as Error)?.message ?? error}` });
            await abortable(Bun.sleep(1000), signal).catch(() => {});
            return true;
        } finally {
            signal.removeEventListener('abort', onParent);
            this.current = null;
        }
    }

    dispose(): void {
        for (const u of this.unsubscribe) u();
        this.unsubscribe.length = 0;
    }
}
