// One group member: publishes what its client sees to the blackboard and runs
// its behaviours, a priority list tried top to bottom every turn.
//
// Behaviours are where autonomy lives: reactions (release, flee, emergency heal)
// sit above order-following (pull, assist, hold formation) and idle chores
// (buff, rest). A material orders change interrupts an interruptible behaviour
// (walks, fights, rests) so the member re-decides at once; casts finish.
//
// A turn can last: a tank's killNpc goes to the mob's death, a nuker's walk and cast up to 12 s. What must not wait for
// that (petControl: it only sends) is marked `side` and runs on a clock of its own beside the turns, and once at the end of
// each turn that acted, with no turn announced: a healer's casts can follow each other in one macrotask.

import { isMezzEffect, MEZZED, type CcKind } from './cc';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import type { PlayerState } from '../types';
import { abortable, executionContext } from '../execution-context';
import { type Blackboard, observeState, SHADE_REFUSED, steppedInFront, UNATTACKABLE_MS } from './blackboard';
import type { Character } from './character';
import { petOrderedOn, petsAllowed } from './pets';
import { Spellbook } from './spells';
import { dryMoveGuard } from './water';
import type { Activity, Capabilities, Contact, GroupPicture, MemberCombat, MemberReport, Orders, Role } from './types';

export interface Behavior<S = any> {
    name: string;
    /** Return true when it acted (the loop starts over from the top), false to fall through. */
    run(ctx: MemberContext<S>): Promise<boolean> | boolean;
    /** false lets a material orders change wait until it finishes (casts are short). Default true. */
    interruptible?: boolean;
    /**
     * Runs on the side tick (MemberAgentOptions.sideTickMs), between and during turns, one at a time and never awaited by a turn (between two, for SIDE_SLOT_MS at most), instead of in the turn. For what never acts and only sends.
     * Its place on the list means nothing then, and it has no say in the turn: its ctx leaves the activity and the idle reason alone, and a failure it records doesn't pace the turn.
     */
    side?: boolean;
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

/** A member's own style and spell names: the server words a pet's styled hit and a pet's spell like its owner's. `pet`: its window pet's, to tell its interception from a groupmate's. */
export interface OwnNames {
    styles: ReadonlySet<string>;
    spells: ReadonlySet<string>;
    pet?: string;
}

/** The names from the member's skill list; undefined before that is in, when nothing tells them apart. */
function ownNames(sdk: BotSDK, pet: string | undefined): OwnNames | undefined {
    const { styles = [], spells = [] } = sdk.getSkills();
    return styles.length || spells.length ? { styles: new Set(styles.map(s => s.name)), spells: new Set(spells.map(s => s.name)), pet } : undefined;
}

/**
 * Count one server message into a member's combat record. A pet's lines go to `petDealt`, and with `own` also the two that
 * can't be told by their wording. Without `own`, those two count as the member's.
 */
export function countCombatMessage(text: string, combat: MemberCombat, own?: OwnNames): void {
    // A critical hit is its own message, on top of the hit.
    const hit = /^You (?:(?:attack|shoot) .+ (?:and|but) hit|hit .+) for (\d+)/.exec(text)
        ?? /^You critical(?:ly)? hit .*for an additional (\d+)/.exec(text);
    if (hit) { combat.dealt += Number(hit[1]); return; }
    // Always a pet's: its blow or shot (with "(+26)" or "(-6)" after the number), its crit (GameLiving.txt:34-35), and with 'hit', not 'hits', its proc or damage shield (Spells.txt:91, :94).
    const pet = /^Your .+ and hits for (\d+)/.exec(text)
        ?? /^Your .+ critically hits .+ for an additional (\d+)/.exec(text)
        ?? /^Your .+ hit .+ for (\d+)/.exec(text);
    if (pet) { combat.petDealt = (combat.petDealt ?? 0) + Number(pet[1]); return; }
    // A DoT's tick names the spell (DoTSpellHandler.cs:87), a pet's own spell or DoT the pet or that spell (SpellHandler.cs:3081).
    const spell = /^Your (.+?) hits .+ for (\d+)/.exec(text);
    if (spell) {
        if (!own || own.spells.has(spell[1]!)) combat.dealt += Number(spell[2]);
        else combat.petDealt = (combat.petDealt ?? 0) + Number(spell[2]);
        return;
    }
    // A pet's styled hit says this to its owner too (AttackComponent.cs:1785-1789). The same name on both counts as ours. A failed style reaches only the player who swung (StyleProcessor.cs:313).
    const landed = /^You perform your (.+?) perfectly/.exec(text);
    if (landed) {
        if (!own || own.styles.has(landed[1]!)) combat.styles[landed[1]!] = (combat.styles[landed[1]!] ?? 0) + 1;
        return;
    }
    if (/^You fail to execute your /.test(text)) combat.missedStyles++;
    // A blow at us that our pet took (Ability.txt:117, AttackComponent.cs:1900). A groupmate's reads the same with its own name.
    const stepped = steppedInFront(text);
    if (stepped && stepped.toLowerCase() === own?.pet?.toLowerCase()) combat.petIntercepts = (combat.petIntercepts ?? 0) + 1;
}

/**
 * How long the turn loop gives a side tick between two turns. Long enough for a stance and an attack order to go out, and a tick with nothing to send is over in microtasks. Past this the next turn goes on, and the tick reads its announcement like any other.
 */
const SIDE_SLOT_MS = 50;
/** An error in a side behaviour: no tick for this long. */
const SIDE_ERROR_PAUSE_MS = 1000;
/** A behaviour that threw sits out this long; the turn goes on down the list meanwhile. */
const BROKEN_PAUSE_MS = 5000;
/** A mezz's own end, to its target: the spell's Message3, two wordings in spell.sql. */
const MEZZ_OVER = /^You (?:are no longer entranced|recover from the mesmerize)\b/;
/** How often a mezzed member looks up. */
const MEZZ_LOOK_MS = 100;
/** A mezz that reads no time left is waited for this long at most. */
const MEZZ_WAIT_MAX_MS = 90_000;

class Interrupted extends Error {
    constructor(reason: string) { super(`interrupted: ${reason}`); this.name = 'Interrupted'; }
}

/** What a behaviour sees: its own character in full, everyone else through the shared picture. */
export class MemberContext<S = any> {
    readonly bot: BotActions;
    readonly sdk: BotSDK;
    readonly spells: Spellbook;

    /**
     * @param memory Per-member scratch space, kept across turns (e.g. DoTs already on a mob).
     * @param onSide The side tick's context: the same member and memory, no say in the turn.
     */
    constructor(private readonly agent: MemberAgent<S>, readonly settings: S, readonly memory = new Map<string, any>(), private readonly onSide = false) {
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
    doing(kind: string, targetId: number | null = null, detail = ''): void {
        if (this.onSide) return;
        this.agent.turn = { kind, targetId };
        this.agent.setActivity(kind, targetId, detail);
    }
    /** What the behaviour running in the turn right now has announced; null between behaviours and before it has. The side tick reads this: a select of its own would take the turn's cast or swing. */
    turn(): { kind: string; targetId: number | null } | null { return this.agent.turn; }
    /** The rest of this turn is a cast, which finishes: an orders change no longer aborts it. */
    finishTurn(): void {
        if (!this.onSide) this.agent.finishTurn();
    }
    /** Why a behaviour did not act; shown as the idle reason when nothing acts. */
    skip(reason: string): false {
        if (!this.onSide) this.agent.lastSkip = reason;
        return false;
    }
    /** Record an action's outcome for the observer (casts, pulls, kills). A cast whose target died under it is none: nothing was paid or refused, and the fight went well. */
    result(kind: string, r: { success: boolean; reason?: string; message?: string; targetDied?: true }, targetId: number | null = null): void {
        if (r.targetDied) return;
        if (!r.success && !this.onSide) this.agent.stepFailed = true;
        if (r.reason === 'crowd_controlled' && !this.onSide) this.agent.noteHeld();
        // For the whole group, whatever the client knows of models: the order, the cast or the swing was at a shade.
        const region = this.sdk.getPlayer()?.regionId;
        if (targetId !== null && region !== undefined && r.message?.includes(SHADE_REFUSED)) this.agent.board.markUnattackable(targetId, region, UNATTACKABLE_MS);
        this.agent.board.emit({
            at: Date.now(), kind: 'result', member: this.name, targetId,
            text: `${kind}: ${r.success ? 'ok' : r.reason ?? 'failed'}${r.message ? ` (${r.message})` : ''}`,
            data: { action: kind, success: r.success, reason: r.reason ?? null },
        });
    }
    note(text: string): void { this.agent.board.emit({ at: Date.now(), kind: 'note', member: this.name, text }); }
    /** Tell the group our crowd control landed on it, for at most `durationMs`; `serverName` is the name in the server's line for that (CastResult.landedOn). */
    markCc(targetId: number, kind: CcKind, durationMs: number, serverName?: string): void {
        this.agent.board.markCc(targetId, this.me().regionId, this.name, kind, durationMs, Date.now(), serverName);
    }
    /** Tell the group this kind can't land on it for up to `durationMs` (the server answered so). */
    markCcImmune(targetId: number, kind: CcKind, durationMs: number): void {
        this.agent.board.markCcImmune(targetId, this.me().regionId, kind, durationMs);
    }
}

export interface MemberAgentOptions {
    /** Report monsters and enemy players within this distance (default 3000). */
    sightRadius?: number;
    /** Pause when no behaviour acts (default 300 ms). */
    idleMs?: number;
    /** Shortest turn: a behaviour that "acts" faster than this is paced, so none can spin (default 250 ms). */
    minTurnMs?: number;
    /**
     * Shortest turn that ended in a failed action (ctx.result). Plenty of refusals come back before any walk or send: castSpell's invalid_target,
     * not_attackable, no_target and already_dead, killNpc's refused with nothing to swing, a walk with no way there. Each turn would try again and log it, four times a second (default 1000 ms).
     */
    failedTurnMs?: number;
    /** How often the behaviours marked `side` run (default 250 ms, a snapshot). */
    sideTickMs?: number;
}

export class MemberAgent<S = any> {
    readonly spells: Spellbook;
    readonly ctx: MemberContext<S>;
    private readonly sideCtx: MemberContext<S>;
    lastSkip = '';
    /** The behaviour now running reported a failed action. */
    stepFailed = false;
    /** What the behaviour now running has announced (MemberContext.turn). */
    turn: { kind: string; targetId: number | null } | null = null;
    private activity: Activity = { kind: 'idle', targetId: null, detail: '', since: Date.now() };
    private capabilities: Capabilities;
    private capsAt = 0;
    private readonly combat: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 };
    private lastMessageId: number;
    private current: { controller: AbortController; interruptible: boolean } | null = null;
    private readonly unsubscribe: (() => void)[] = [];
    private readonly sideBehaviors: Behavior<S>[];
    /** The side tick now running: the clock's or a turn's end's, one at a time. */
    private sideTick: Promise<void> | null = null;
    private sidePausedUntil = 0;
    /** A mezz a turn was refused for, until the loop has waited it out: the last line then, and when its time is up. */
    private mezzed: { lastLine: number; until: number } | null = null;

    constructor(readonly member: Member, readonly board: Blackboard, readonly behaviors: Behavior<S>[], settings: S, private readonly options: MemberAgentOptions = {}) {
        this.sideBehaviors = behaviors.filter(b => b.side);
        this.spells = new Spellbook(member.sdk, member.actions);
        this.ctx = new MemberContext(this, settings);
        this.sideCtx = new MemberContext(this, settings, this.ctx.memory, true);
        this.capabilities = this.ownCapabilities();
        this.lastMessageId = member.sdk.getGameMessages().at(-1)?.id ?? -1;
        this.unsubscribe.push(member.sdk.onStateUpdate(() => this.publish()));
        this.unsubscribe.push(board.onOrders((next, prev) => { if (this.affected(next, prev)) this.interrupt(`orders: ${next.phase}`); }));
        // With stayDry (RvR and the pack have it, PvE has none), no move of ours ends in the river: casts from the bank (water.ts dryMoveGuard).
        const unguard = (settings as { stayDry?: unknown }).stayDry === undefined ? null : member.sdk.setMoveGuard?.(dryMoveGuard(() => this.ctx.settings as { stayDry?: unknown }));
        if (unguard) this.unsubscribe.push(unguard);
        this.publish();
    }

    /**
     * What the group can count on, from the spell list. Rez only if our list also casts it, since corpses wait for whoever says it can, and
     * crowd control likewise, since an assignment keeps the others off its target (a Skald's shout, on a list with no crowdControl).
     * With pets off (pet.enabled, or its character's pet: false) a summon is a spell it won't cast: nobody waits on its power or its pet, and the report has none.
     */
    private ownCapabilities(): Capabilities {
        const can = this.spells.capabilities();
        const cc = can.cc && this.behaviors.some(b => b.name === 'crowdControl');
        const own = { ...can, cc, ccKinds: cc ? can.ccKinds : [], root: cc && can.root, rez: !!can.rez && this.behaviors.some(b => b.name === 'rez') };
        return petsAllowed(this.ctx.settings) && this.member.character?.pet !== false ? own : { ...own, pet: null };
    }

    /** Push our latest snapshot (with the current activity) to the blackboard. */
    publish(): void {
        const state = this.member.sdk.getState();
        if (!state) return;
        if (Date.now() - this.capsAt > 30_000) { this.capabilities = this.ownCapabilities(); this.capsAt = Date.now(); }
        const fresh = state.gameMessages.filter(m => m.id > this.lastMessageId);
        if (fresh.length) {
            const own = ownNames(this.member.sdk, state.pet?.name);
            for (const m of fresh) countCombatMessage(m.text, this.combat, own);
        }
        this.lastMessageId = state.gameMessages.at(-1)?.id ?? this.lastMessageId;
        const petRecast = state.pet === null && this.capabilities.pet === 'main' && (this.spells.summon()?.spell.cooldownRemaining ?? 0) > 0;
        const obs = observeState(state, { bot: this.member.bot, role: this.member.role, activity: this.activity, capabilities: this.capabilities, combat: this.combat, petRecast, petOrderedOn: petOrderedOn(this.ctx) }, this.options.sightRadius);
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
        // Into a column or out of it: a walk to a slot or to a place behind the driver is the wrong one now.
        if ((next.column?.driver ?? null) !== (prev.column?.driver ?? null)) return true;
        const mine = (o: Orders) => o.cc.filter(c => c.by === this.ctx.name).map(c => c.targetId).join(',');
        const moved = (a: Orders['anchor'], b: Orders['anchor']) => !a !== !b || (!!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) > 300);
        return mine(next) !== mine(prev) || moved(next.retreatTo, prev.retreatTo) || (next.phase !== 'engage' && moved(next.anchor, prev.anchor));
    }

    finishTurn(): void {
        if (this.current) this.current.interruptible = false;
    }

    /** Abort the running behaviour if it may be interrupted. */
    interrupt(reason: string): void {
        if (this.current?.interruptible) this.current.controller.abort(new Interrupted(reason));
    }

    /** Run behaviours until `signal` aborts. The side tick has ended when this settles: the run's end sends its last orders after that. */
    async run(signal: AbortSignal): Promise<void> {
        const list = this.behaviors.filter(b => !b.side);
        const ended = new AbortController();
        const sideSignal = AbortSignal.any([signal, ended.signal]);
        const side = this.runSide(sideSignal);
        try {
            while (!signal.aborted) {
                // Out of the world (a relog): every behaviour reads `me` as there, and "petenc: healer threw: null is not an object (evaluating 'me.constitutionLost')".
                if (!this.member.sdk.getPlayer()) {
                    await abortable(Bun.sleep(this.options.idleMs ?? 300), signal).catch(() => {});
                    continue;
                }
                const turn = Date.now();
                let acted = false;
                for (const b of list) {
                    if (signal.aborted || !this.member.sdk.getPlayer()) break;
                    this.stepFailed = false;
                    if (await this.step(b, signal)) { acted = true; break; }
                }
                let spent = Date.now() - turn;
                // "petControl runs only between a member's turns" was the list's: with the turn on its clock, another cast in the same macrotask would leave a pet with no order until a healer's chain stops (selectFree).
                if (acted && !signal.aborted) await this.sideSlot(sideSignal);
                if (this.mezzed && !signal.aborted) {
                    // That was the pause: a refused turn's second, on the clock from before the wait, would come after the mezz has ended.
                    await this.waitOutMezz(signal);
                    spent = Date.now() - turn;
                    this.stepFailed = false;
                }
                const paced = acted ? (this.options.minTurnMs ?? 250) - spent : this.options.idleMs ?? 300;
                const pause = this.stepFailed ? Math.max(paced, (this.options.failedTurnMs ?? 1000) - spent) : paced;
                if (!acted && !signal.aborted) this.setActivity('idle', null, this.lastSkip);
                if (pause > 0 && !signal.aborted) await abortable(Bun.sleep(pause), signal).catch(() => {});
                this.lastSkip = '';
            }
        } finally {
            ended.abort(new Error('member stopped'));
            await side;
        }
    }

    /** A turn was refused for crowd control: if that's a mezz on us, the loop waits it out. A stun is short, and keeps its own retry. */
    noteHeld(): void {
        const state = this.member.sdk.getState();
        const mezz = state?.effects.find(e => isMezzEffect(e.name));
        if (!state || !mezz) return;
        this.mezzed = { lastLine: state.gameMessages.at(-1)?.id ?? -1, until: Date.now() + (mezz.remainingSeconds > 0 ? mezz.remainingSeconds * 1000 + 1000 : MEZZ_WAIT_MAX_MS) };
    }

    /**
     * Nothing on the list can go while mezzed, so no turn until "You are no longer entranced.", the effect gone, or its time up: every behaviour tried again every 2 s, one failure each (20261104-050645: heal:crowd_controlled (15) for one 42 s mezz). A death or a relog ends it, and the side tick goes on.
     */
    private async waitOutMezz(signal: AbortSignal): Promise<void> {
        const { lastLine, until } = this.mezzed!;
        this.mezzed = null;
        this.setActivity('idle', null, MEZZED);
        const over = () => {
            const state = this.member.sdk.getState();
            return !state?.player || state.player.isDead || Date.now() >= until || !state.effects.some(e => isMezzEffect(e.name)) || state.gameMessages.some(m => m.id > lastLine && MEZZ_OVER.test(m.text));
        };
        while (!signal.aborted && !over()) await abortable(Bun.sleep(MEZZ_LOOK_MS), signal).catch(() => {});
    }

    /** The behaviours marked `side`, every sideTickMs, between and during turns. No player (a relog): no tick. Ends with no tick running. */
    private async runSide(signal: AbortSignal): Promise<void> {
        if (!this.sideBehaviors.length) return;
        const every = this.options.sideTickMs ?? 250;
        while (!signal.aborted) {
            const tick = Date.now();
            await this.sideTickNow(signal);
            await abortable(Bun.sleep(Math.max(1, every - (Date.now() - tick))), signal).catch(() => {});
        }
        await this.sideTick;
    }

    /** One tick: the one running, if any. */
    private sideTickNow(signal: AbortSignal): Promise<void> {
        if (this.sideTick) return this.sideTick;
        const tick = this.sideSteps(signal).finally(() => { if (this.sideTick === tick) this.sideTick = null; });
        return this.sideTick = tick;
    }

    private async sideSteps(signal: AbortSignal): Promise<void> {
        for (const b of this.sideBehaviors) {
            if (signal.aborted || Date.now() < this.sidePausedUntil || !this.member.sdk.getPlayer()) break;
            await this.sideStep(b, signal);
        }
    }

    /** A tick between two turns, with none announced (MemberContext.turn). One running may have read the turn that just ended, so this one comes after it. Bounded: the next turn doesn't wait on it (SIDE_SLOT_MS). */
    private async sideSlot(signal: AbortSignal): Promise<void> {
        if (!this.sideBehaviors.length) return;
        const running = this.sideTick;
        const tick = running ? running.then(() => this.sideTickNow(signal)) : this.sideTickNow(signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([tick, new Promise<void>(resolve => { timer = setTimeout(resolve, SIDE_SLOT_MS); })]);
        clearTimeout(timer);
    }

    /** One side behaviour, in the run's execution and not the turn's: an orders change that aborts the turn leaves it be. An error is caught as a turn's is. */
    private async sideStep(b: Behavior<S>, signal: AbortSignal): Promise<void> {
        try {
            await executionContext.run({ ...executionContext.getStore(), signal }, () => abortable(Promise.resolve().then(() => b.run(this.sideCtx))));
        } catch (error) {
            // A lost connection is the turn's to report: that ends the run.
            if (signal.aborted || !this.member.sdk.isConnected()) return;
            this.board.emit({ at: Date.now(), kind: 'note', member: this.ctx.name, text: `${b.name} threw: ${(error as Error)?.message ?? error}` });
            this.sidePausedUntil = Date.now() + SIDE_ERROR_PAUSE_MS;
        }
    }

    /** Behaviours that threw, by name, left out until then (BROKEN_PAUSE_MS). */
    private readonly brokenUntil = new Map<string, number>();

    private async step(b: Behavior<S>, signal: AbortSignal): Promise<boolean> {
        if ((this.brokenUntil.get(b.name) ?? 0) > Date.now()) return false;
        const controller = new AbortController();
        const onParent = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onParent, { once: true });
        this.current = { controller, interruptible: b.interruptible !== false };
        this.turn = null;
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
            // The turn goes on down the list, and this one sits out a while. It used to spend the turn plus a second: a cure above
            // heal that threw every time (arena round 9, 2026-11-09, a file loaded mid-edit) left Sigrid 5 heals in a round.
            this.board.emit({ at: Date.now(), kind: 'note', member: this.ctx.name, text: `${b.name} threw: ${(error as Error)?.message ?? error}` });
            this.brokenUntil.set(b.name, Date.now() + BROKEN_PAUSE_MS);
            return false;
        } finally {
            signal.removeEventListener('abort', onParent);
            this.current = null;
            this.turn = null;
        }
    }

    dispose(): void {
        for (const u of this.unsubscribe) u();
        this.unsubscribe.length = 0;
    }
}
