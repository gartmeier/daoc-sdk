// A group strategy: the coordinator's policy (decide) plus the members'
// behaviour lists per role, sharing one settings object. Strategies are plain
// objects so an agent can copy one and change a threshold, a rule or a role.

import { abortable } from '../execution-context';
import type { Blackboard, BlackboardOptions } from './blackboard';
import type { Behavior, MemberAgentOptions } from './member';
import type { GroupPicture, Orders, OrdersUpdate, Role } from './types';
import type { Finding, RunReport } from './observer';

export interface CoordinatorContext<S = any> {
    picture: GroupPicture;
    /** The orders in force (the last decide's result). */
    orders: Orders;
    /** Scratch space kept across ticks (camp, base, failed pulls, timers). */
    memory: Record<string, any>;
    settings: S;
    now: number;
    /** Time is up: finish the current fight, start nothing new. */
    windingDown: boolean;
}

export interface GroupStrategy<S = any> {
    name: string;
    description?: string;
    settings: S;
    /** Role for a member with none in group.json or its character.ts (default: roleForClass). */
    roleOf?(className: string): Role;
    behaviors: Record<Role, Behavior<S>[]>;
    /** Behaviour lists for single members by bot name, ahead of their character's and their role's: the group overriding someone (see character.ts). */
    memberBehaviors?: Record<string, Behavior<S>[]>;
    /** The coordinator's policy, called every tick with the shared picture. */
    decide(ctx: CoordinatorContext<S>): OrdersUpdate;
    /** Extra observer rules for this strategy. */
    findings?(report: RunReport, settings: S): Finding[];
    /** Blackboard timings for runs of this strategy (default: BlackboardOptions' defaults). */
    board?: BlackboardOptions;
    /** Member agent options for runs of this strategy (sightRadius: how far members report enemies). */
    agent?: MemberAgentOptions;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
    if (!over) return base;
    const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
    for (const [k, v] of Object.entries(over)) {
        const b = (base as any)[k];
        out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v as any) : v;
    }
    return out;
}

/** A new strategy from `base`: settings are merged deeply, behaviour lists per role (and per member) are replaced. */
export function defineStrategy<S>(base: GroupStrategy<S>, override: {
    name?: string;
    description?: string;
    settings?: DeepPartial<S>;
    behaviors?: Partial<Record<Role, Behavior<S>[]>>;
    memberBehaviors?: Record<string, Behavior<S>[]>;
    decide?: GroupStrategy<S>['decide'];
    roleOf?: GroupStrategy<S>['roleOf'];
    findings?: GroupStrategy<S>['findings'];
    board?: BlackboardOptions;
    agent?: MemberAgentOptions;
} = {}): GroupStrategy<S> {
    return {
        ...base,
        ...override,
        name: override.name ?? base.name,
        settings: merge(base.settings, override.settings),
        behaviors: { ...base.behaviors, ...override.behaviors } as Record<Role, Behavior<S>[]>,
        memberBehaviors: { ...base.memberBehaviors, ...override.memberBehaviors },
    };
}

export { merge as mergeSettings };

const CLASS_ROLES: Record<string, Role> = {
    // Albion
    Armsman: 'tank', Paladin: 'tank', Fighter: 'tank', Mercenary: 'melee', Reaver: 'melee', Scout: 'melee', Infiltrator: 'melee', Rogue: 'melee', Heretic: 'melee',
    Cleric: 'healer', Friar: 'healer', Acolyte: 'healer', Minstrel: 'support',
    Wizard: 'nuker', Theurgist: 'nuker', Sorcerer: 'nuker', Cabalist: 'nuker', Necromancer: 'nuker', Elementalist: 'nuker', Mage: 'nuker', Disciple: 'nuker',
    // Midgard
    Warrior: 'tank', Thane: 'tank', Viking: 'tank', Berserker: 'melee', Savage: 'melee', Hunter: 'melee', Shadowblade: 'melee', MidgardRogue: 'melee', Valkyrie: 'melee',
    Healer: 'healer', Shaman: 'healer', Seer: 'healer', Skald: 'support',
    Runemaster: 'nuker', Spiritmaster: 'nuker', Bonedancer: 'nuker', Mystic: 'nuker', Warlock: 'nuker',
    // Hibernia
    Hero: 'tank', Guardian: 'tank', Champion: 'melee', Blademaster: 'melee', Nightshade: 'melee', Ranger: 'melee', Stalker: 'melee', Valewalker: 'melee', Vampiir: 'melee',
    Druid: 'healer', Warden: 'healer', Bard: 'support', Naturalist: 'melee',
    Mentalist: 'nuker', Enchanter: 'nuker', Eldritch: 'nuker', Animist: 'nuker', Magician: 'nuker', Forester: 'nuker', Bainshee: 'nuker',
};

export function roleForClass(className: string): Role {
    return CLASS_ROLES[className] ?? 'melee';
}

/** Runs the strategy's decide() on a timer and writes the result to the blackboard. */
export class Coordinator<S = any> {
    readonly memory: Record<string, any> = {};
    windingDown = false;

    constructor(private readonly board: Blackboard, private readonly strategy: GroupStrategy<S>, private readonly settings: S, private readonly tickMs = 500) {}

    tick(now = Date.now()): Orders {
        const update = this.strategy.decide({ picture: this.board.picture(now), orders: this.board.getOrders(), memory: this.memory, settings: this.settings, now, windingDown: this.windingDown });
        this.board.setOrders(update, now);
        return this.board.getOrders();
    }

    async run(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                this.tick();
            } catch (error) {
                this.board.emit({ at: Date.now(), kind: 'note', text: `coordinator: ${(error as Error)?.stack ?? error}` });
            }
            await abortable(Bun.sleep(this.tickMs), signal).catch(() => {});
        }
    }
}
