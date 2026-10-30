// Behaviour library for group members. A role is a priority list of these;
// strategies reorder, drop, wrap or replace them, and add their own.
//
// The tactics come from live runs of a five-player Hibernian group: the tank
// body-pulls to a base, damage dealers wait until the tank has held the mob for
// ~1.5 s, casters stand 900-1400 back and healers 450-1000, whoever pulls aggro
// runs to the tank, and positions change only while the tank holds the mob.

import type { Behavior, MemberContext } from './member';
import { safePath } from './terrain';
import type { Point, Role } from './types';

/** Settings the behaviours read; strategies extend this. */
export interface TacticsSettings {
    /** The tank must hold the focus this long before damage dealers open (ms). */
    holdMs: number;
    /** ... unless the focus has been fighting this long without the tank holding it: then open anyway (ms). */
    assistAfterMs: number;
    /** Heal below these health percentages. outOfCombat applies only with ≥ 50 % mana. */
    heal: { tank: number; other: number; emergency: number; outOfCombat: number };
    /** Sit until these percentages while the group waits. */
    rest: { hp: number; mana: number };
    /** Distance band from the focus per role, kept while the tank holds it. */
    combatRange: Partial<Record<Role, [number, number]>>;
    /** Formation slot per role: distance behind the anchor and angle off the facing line (radians). */
    formation: Partial<Record<Role, { back: number; angle: number }>>;
    /** The puller walks a focus farther than this from the anchor back to it. */
    pullDistance: number;
    /** Buff only above this mana %. */
    buffMana: number;
    /** Allow area damage spells (they break mezz on nearby adds). */
    aoe: boolean;
    /** Damage dealers without power melee the focus (default false: cloth casters die in melee). */
    meleeWhenOom: boolean;
    /** shedLoad drops loot at this load % (encumbrance) so the member can keep walking; 0 turns it off. */
    shedLoadAt: number;
    /** ... never dropping items whose name matches this (case-insensitive regexp source). */
    keepItems: string;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const QUIET_PHASES = new Set(['recover', 'gather', 'idle']);

async function stopSwinging(ctx: MemberContext): Promise<void> {
    if (ctx.me().attacking) await ctx.sdk.sendAttack(false);
}

/** Members (by name) busy with `kind` on `targetId`, started within `withinMs`. */
function claimedBy(ctx: MemberContext, kind: string, targetId: number, withinMs: number): string[] {
    const now = Date.now();
    return ctx.members().filter(m => m.name !== ctx.name && m.activity.kind === kind && m.activity.targetId === targetId && now - m.activity.since < withinMs).map(m => m.name);
}

/** Our slot around `anchor`: `back` units away from `facing`, roles fanned out by angle, same-role members on alternating sides. */
export function formationSlot(ctx: MemberContext<TacticsSettings>, anchor: Point, facing: Point | null): Point {
    const f = ctx.settings.formation[ctx.role] ?? { back: 200, angle: 0 };
    const same = ctx.members().filter(m => m.role === ctx.role).map(m => m.name);
    const i = Math.max(0, same.indexOf(ctx.name));
    const spread = f.angle || (i ? 0.4 : 0);
    const angle = spread * (i % 2 ? -1 : 1) * (1 + Math.floor(i / 2) * 0.6);
    const away = facing && dist(anchor, facing) > 1 ? Math.atan2(anchor.y - facing.y, anchor.x - facing.x) : 0;
    return { x: Math.round(anchor.x + Math.cos(away + angle) * f.back), y: Math.round(anchor.y + Math.sin(away + angle) * f.back) };
}

/** Dead: release and respawn at the bind point (holdFormation walks back). */
export const release = (): Behavior => ({
    name: 'release',
    interruptible: false,
    async run(ctx) {
        if (!ctx.bot.isDead()) return false;
        ctx.doing('release');
        ctx.result('release', await ctx.bot.releaseAndRespawn());
        return true;
    },
});

/** Orders say retreat: run to our slot at the retreat point. */
export const retreat = (): Behavior<TacticsSettings> => ({
    name: 'retreat',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'retreat' || !o.retreatTo) return false;
        const me = ctx.me();
        const slot = formationSlot(ctx, o.retreatTo, { x: 2 * o.retreatTo.x - me.x, y: 2 * o.retreatTo.y - me.y });
        if (dist(me, slot) < 150) return ctx.skip('at the retreat point');
        await stopSwinging(ctx);
        ctx.doing('flee', null, 'retreat');
        const w = await ctx.bot.walkTo(slot.x, slot.y, { tolerance: 100, timeout: 20_000 });
        if (!w.success) ctx.result('retreat', w);
        return true;
    },
});

/** Not the tank and a monster is on us: run to the tank so it can take it back. */
export const flee = (): Behavior => ({
    name: 'flee',
    async run(ctx) {
        if (ctx.isTank()) return false;
        const tank = ctx.tank();
        if (!tank || !ctx.threats().some(t => t.target === ctx.name && !t.cc)) return false;
        const me = ctx.me();
        if (dist(me, tank) < 150) return ctx.skip('attacked, already at the tank');
        await stopSwinging(ctx);
        ctx.doing('flee', null, `to ${tank.name}`);
        await ctx.bot.walkTo(tank.x, tank.y, { z: tank.z, tolerance: 60, timeout: 6000 });
        return true;
    },
});

/**
 * Heal the most hurt member below its threshold. Skips a target another healer
 * is already casting on, unless it is below the emergency threshold.
 */
export const heal = (opts: { emergencyOnly?: boolean } = {}): Behavior<TacticsSettings> => ({
    name: opts.emergencyOnly ? 'emergencyHeal' : 'heal',
    interruptible: false,
    async run(ctx) {
        const s = ctx.settings.heal;
        const me = ctx.me();
        const o = ctx.orders();
        const fighting = ctx.threats().length > 0 || o.phase === 'engage' || o.phase === 'pull' || o.phase === 'retreat';
        const limit = (role: Role) => opts.emergencyOnly ? s.emergency
            : fighting ? (role === 'tank' ? s.tank : s.other)
            : me.manaPercent >= 50 ? s.outOfCombat : 0;
        const hurt = ctx.members()
            .filter(m => !m.isDead && m.regionId === me.regionId && dist(me, m) < 2000 && m.hp < limit(m.role))
            .filter(m => m.hp < s.emergency || !claimedBy(ctx, 'heal', m.objectId, 3500).length)
            .sort((a, b) => a.hp - b.hp)[0];
        if (!hurt) return false;
        const sp = ctx.spells.heal();
        if (!sp) return ctx.skip('heal: not enough power');
        await stopSwinging(ctx);
        ctx.doing('heal', hurt.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, hurt.objectId);
        ctx.result('heal', c, hurt.objectId);
        if (!c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        return true;
    },
});

/**
 * Mezz our crowd-control assignment; without `assignedOnly`, also any add (not
 * the focus) attacking the group that nobody controls or is mezzing yet.
 */
export const crowdControl = (opts: { assignedOnly?: boolean } = {}): Behavior<TacticsSettings> => ({
    name: 'crowdControl',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'pull' && o.phase !== 'retreat') return false;
        const live = (id: number) => { const c = ctx.contact(id); return c && !c.stale && c.hp > 0 && !c.cc ? c : undefined; };
        const assigned = o.cc.filter(a => a.by === ctx.name).map(a => live(a.targetId)).filter(c => !!c);
        const extra = opts.assignedOnly ? [] : ctx.threats()
            .filter(t => t.objectId !== o.focus && !t.cc && !o.cc.some(a => a.targetId === t.objectId) && !claimedBy(ctx, 'cc', t.objectId, 4000).length);
        const target = assigned[0] ?? extra[0];
        if (!target) return false;
        const sp = ctx.spells.mezz();
        if (!sp) return ctx.skip('cc: no mezz ready');
        await stopSwinging(ctx);
        ctx.doing('cc', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId);
        ctx.result('cc', c, target.objectId);
        if (c.success && !c.resisted) ctx.markCc(target.objectId, 'mezz', Math.max(3000, sp.duration * 900));
        else if (c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        return true;
    },
});

/**
 * Puller: hit the focus until it turns on us, then walk it back to the anchor
 * (body pull). A focus already near the anchor is just attacked.
 */
export const pull = (): Behavior<TacticsSettings> => ({
    name: 'pull',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'pull' || o.puller !== ctx.name || o.focus === null) return false;
        const mob = ctx.focus();
        if (!mob) return ctx.skip('pull: focus unknown');
        const me = ctx.me();
        const far = !!o.anchor && dist(mob, o.anchor) > ctx.settings.pullDistance;
        if (mob.target === ctx.name) {
            if (!o.anchor || dist(me, o.anchor) < 120) return ctx.skip('pull: waiting for it at the anchor');
            await stopSwinging(ctx);
            ctx.doing('pull', mob.objectId, 'back to the anchor');
            await ctx.bot.walkTo(o.anchor.x, o.anchor.y, { tolerance: 80, timeout: 20_000 });
            return true;
        }
        if (!ctx.sdk.getNearbyNpc(mob.objectId)) {
            ctx.doing('pull', mob.objectId, 'to its last position');
            await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 300, timeout: 20_000 });
            return true;
        }
        ctx.doing('pull', mob.objectId, mob.name);
        const a = await ctx.bot.attack(mob.objectId, { timeout: 15_000 });
        ctx.result('pull', a, mob.objectId);
        if (!a.success) return true;
        await ctx.sdk.waitForCondition(() => ctx.sdk.getNearbyNpc(mob.objectId)?.targetObjectId === ctx.me().objectId, 6000).catch(() => null);
        if (far) await stopSwinging(ctx);
        return true;
    },
});

/** The highest anytime (no prerequisite) style; killNpc uses it every swing. */
export function anytimeStyles(ctx: MemberContext): string[] {
    return (ctx.sdk.getSkills().styles ?? []).filter(s => s.prerequisite === 256).sort((a, b) => b.specLevel - a.specLevel).slice(0, 1).map(s => s.name);
}

/** Tank: fight the focus to the death (an orders change switches targets). */
export const tank = (): Behavior<TacticsSettings> => ({
    name: 'tank',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const mob = ctx.focus();
        if (!mob) return ctx.skip('tank: focus unknown');
        if (!ctx.sdk.getNearbyNpc(mob.objectId)) {
            ctx.doing('move', mob.objectId, 'to the focus');
            await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 200, timeout: 10_000 });
            return true;
        }
        ctx.doing('melee', mob.objectId, 'tank');
        const k = await ctx.bot.killNpc(mob.objectId, { force: true, styles: anytimeStyles(ctx), timeout: 90_000, maxChaseDistance: 3000 });
        ctx.result('kill', k, mob.objectId);
        return true;
    },
});

/**
 * Damage dealer: once the tank has held the focus for holdMs (or opts.holdMs), nuke it (each DoT
 * once, then direct damage), or melee with `melee`. Never touches crowd-controlled mobs.
 */
export const assist = (opts: { melee?: boolean; holdMs?: number } = {}): Behavior<TacticsSettings> => ({
    name: opts.melee ? 'assistMelee' : 'assist',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const mob = ctx.focus();
        if (!mob || mob.hp <= 0) return ctx.skip('assist: focus unknown');
        if (mob.cc) return ctx.skip('assist: focus is crowd-controlled');
        // The picture can trail a death by a snapshot; our own client knows first.
        const seen = ctx.sdk.getNearbyNpc(mob.objectId);
        if (seen && seen.healthPercent <= 0) return ctx.skip('assist: focus just died');
        if (!seen) {
            // Others see it, we don't (beyond our view): close in on where the group last saw it.
            const me0 = ctx.me();
            const d = dist(me0, mob);
            const stop = (ctx.settings.combatRange[ctx.role]?.[1] ?? 1400) - 200;
            if (d <= stop) return ctx.skip('assist: focus not in view');
            const f = (d - stop) / d;
            ctx.doing('move', mob.objectId, 'toward the focus');
            await ctx.bot.walkTo(me0.x + (mob.x - me0.x) * f, me0.y + (mob.y - me0.y) * f, { tolerance: 100, timeout: 6000 });
            return true;
        }
        const tankM = ctx.tank();
        const now = Date.now();
        const held = !tankM || (mob.target === tankM.name && now - mob.targetSince >= (opts.holdMs ?? ctx.settings.holdMs))
            || (mob.hostileSince > 0 && now - mob.hostileSince >= ctx.settings.assistAfterMs);
        if (!held) return ctx.skip('assist: waiting for the tank to hold it');
        const me = ctx.me();
        if (!opts.melee) {
            const dotted: Set<string> = ctx.memory.get(`dotted:${mob.objectId}`) ?? new Set();
            const sp = ctx.spells.nuke({ dotted, targetHp: mob.hp, aoe: ctx.settings.aoe });
            if (sp) {
                await stopSwinging(ctx);
                ctx.doing('nuke', mob.objectId, sp.spell.name);
                const c = await ctx.bot.castSpell(sp.spell, mob.objectId);
                ctx.result('nuke', c, mob.objectId);
                if (c.success && sp.type === 'DamageOverTime') { dotted.add(sp.spell.name); ctx.memory.set(`dotted:${mob.objectId}`, dotted); }
                if (!c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
                return true;
            }
            if (!ctx.settings.meleeWhenOom || me.maxMana === 0) return ctx.skip('assist: no power');
        }
        const live = ctx.sdk.getNearbyNpc(mob.objectId);
        ctx.doing('melee', mob.objectId);
        if (!me.attacking || me.targetObjectId !== mob.objectId || !live || live.distance > 150) {
            const a = await ctx.bot.attack(mob.objectId, { timeout: 8000 });
            if (!a.success) ctx.result('melee', a, mob.objectId);
        }
        await Bun.sleep(400);
        return true;
    },
});

/**
 * Keep our role's distance band from the focus, on the tank's side of it (the mob
 * never walks through us), spread sideways. Only while the tank holds the mob.
 */
export const position = (): Behavior<TacticsSettings> => ({
    name: 'position',
    async run(ctx) {
        const o = ctx.orders();
        const band = ctx.settings.combatRange[ctx.role];
        if (o.phase !== 'engage' || !band) return false;
        const mob = ctx.focus();
        const tankM = ctx.tank();
        if (!mob || !tankM || mob.target !== tankM.name) return false;
        const live = ctx.sdk.getNearbyNpc(mob.objectId) ?? mob;
        const me = ctx.me();
        const d = dist(me, live);
        if (d >= band[0] && d <= band[1]) return false;
        let dx = tankM.x - live.x, dy = tankM.y - live.y;
        if (Math.hypot(dx, dy) < 50) { dx = me.x - live.x; dy = me.y - live.y; }
        const len = Math.hypot(dx, dy) || 1;
        const others = ctx.members().filter(m => m.role !== 'tank').map(m => m.name);
        const side = others.length > 1 ? (others.indexOf(ctx.name) / (others.length - 1)) * 2 - 1 : 0;
        const want = (band[0] + band[1]) / 2;
        const px = live.x + (dx / len) * want - (dy / len) * side * 250;
        const py = live.y + (dy / len) * want + (dx / len) * side * 250;
        await stopSwinging(ctx);
        ctx.doing('move', mob.objectId, `position ${Math.round(d)}→${Math.round(want)}`);
        await ctx.bot.walkTo(px, py, { z: live.z, tolerance: 60, timeout: 8000 });
        return true;
    },
});

/**
 * Outside fights: stand in our formation slot at the anchor. Far away (after a
 * release, or travelling), walk there around known danger.
 */
export const holdFormation = (): Behavior<TacticsSettings> => ({
    name: 'holdFormation',
    async run(ctx) {
        const o = ctx.orders();
        if (!o.anchor || o.phase === 'engage' || o.phase === 'retreat') return false;
        if (o.phase === 'pull' && o.puller === ctx.name) return false;
        const me = ctx.me();
        const slot = formationSlot(ctx, o.anchor, o.facing);
        const d = dist(me, slot);
        if (d < (o.phase === 'travel' ? 250 : 120)) return false;
        await stopSwinging(ctx);
        let to: Point = slot;
        if (d > 2500) {
            const path = safePath(me.regionId, me.level, me, slot);
            const next = path[0] ?? slot;
            const f = Math.min(1, 2500 / dist(me, next));
            to = { x: me.x + (next.x - me.x) * f, y: me.y + (next.y - me.y) * f };
        }
        ctx.doing('move', null, o.phase);
        const w = await ctx.bot.walkTo(to.x, to.y, { tolerance: 80 });
        if (!w.success) { ctx.result('walk', w); await Bun.sleep(500); }
        return true;
    },
});

/** While the group waits: sit until rest.hp / rest.mana. */
export const rest = (): Behavior<TacticsSettings> => ({
    name: 'rest',
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length) return false;
        const me = ctx.me();
        const r = ctx.settings.rest;
        const caster = me.maxMana > 0;
        if (me.healthPercent >= r.hp && (!caster || me.manaPercent >= r.mana)) return false;
        // rest() refuses while any NPC in view targets us, even one leashing home far away.
        const on = ctx.bot.getAttackers()[0];
        if (on) return ctx.skip(`rest: ${on.name} targets us (${Math.round(on.distance)} away)`);
        ctx.doing('rest');
        const res = await ctx.bot.rest({ healthPercent: r.hp, manaPercent: caster ? r.mana : undefined, timeout: 120_000 });
        if (!res.success) { ctx.result('rest', res); return ctx.skip(`rest: ${res.reason}`); }
        return true;
    },
});

/**
 * While the group waits: keep our buffs up. Each buff has one owner (the first
 * member, healers first, whose spell list has it). Realm buffs go on us and the tank.
 */
export const buff = (): Behavior<TacticsSettings> => ({
    name: 'buff',
    interruptible: false,
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length) return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < ctx.settings.buffMana) return false;
        const order: Role[] = ['healer', 'support', 'nuker', 'tank', 'melee'];
        const members = [...ctx.members()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
        const self = ctx.member(me.name);
        const tankM = ctx.tank();
        const last: Map<string, number> = ctx.memory.get('buffs') ?? new Map();
        ctx.memory.set('buffs', last);
        for (const s of ctx.spells.buffs()) {
            if (members.find(m => m.capabilities.buffs.includes(s.spell.name))?.name !== me.name) continue;
            if (me.mana < s.power || s.spell.cooldownRemaining > 0) continue;
            const targets = s.target === 'Realm' ? [self, tankM] : [self];
            for (const t of new Set(targets)) {
                if (!t || t.isDead) continue;
                if (t.effects.includes(s.spell.name)) continue;
                const key = `${s.spell.name}:${t.name}`;
                const gap = s.concentration > 0 ? 600_000 : Math.max(60_000, s.duration * 800);
                if (Date.now() - (last.get(key) ?? 0) < gap) continue;
                last.set(key, Date.now());
                ctx.doing('buff', t.objectId, s.spell.name);
                const c = await ctx.bot.castSpell(s.spell, s.target === 'Realm' ? t.objectId : undefined);
                ctx.result('buff', c, t.objectId);
                return true;
            }
        }
        return false;
    },
});

/**
 * While the group waits: near the carry limit (shedLoadAt % load), drop the heaviest
 * backpack item not matching keepItems. Overloaded characters cannot move at all;
 * selling needs a town visit, which leveling strategies do not plan yet.
 */
export const shedLoad = (): Behavior<TacticsSettings> => ({
    name: 'shedLoad',
    interruptible: false,
    async run(ctx) {
        const limit = ctx.settings.shedLoadAt;
        const enc = ctx.me().encumbrance;
        if (!limit || !enc || enc.max <= 0 || 100 * enc.current / enc.max < limit) return false;
        const phase = ctx.orders().phase;
        if ((!QUIET_PHASES.has(phase) && phase !== 'travel') || ctx.threats().length) return ctx.skip('shedLoad: not now');
        const keep = new RegExp(ctx.settings.keepItems, 'i');
        const item = ctx.sdk.getInventory().filter(i => !keep.test(i.name)).sort((a, b) => b.weight * b.count - a.weight * a.count)[0];
        if (!item) return ctx.skip('shedLoad: nothing droppable');
        ctx.doing('drop', null, item.name);
        const r = await ctx.bot.dropItem(item);
        ctx.result('drop', { ...r, message: `${item.name} (load ${Math.round(100 * enc.current / enc.max)}%)` });
        return true;
    },
});

/** The behaviour lists the default strategies use, by role. */
export function defaultBehaviors(): Record<Role, Behavior<TacticsSettings>[]> {
    return {
        tank: [release(), retreat(), pull(), tank(), shedLoad(), holdFormation(), buff(), rest()],
        healer: [release(), retreat(), heal({ emergencyOnly: true }), flee(), heal(), crowdControl({ assignedOnly: true }), position(), shedLoad(), holdFormation(), buff(), rest()],
        support: [release(), retreat(), heal({ emergencyOnly: true }), flee(), crowdControl(), heal(), position(), shedLoad(), holdFormation(), buff(), rest()],
        nuker: [release(), retreat(), flee(), crowdControl({ assignedOnly: true }), heal({ emergencyOnly: true }), position(), assist(), shedLoad(), holdFormation(), buff(), rest()],
        melee: [release(), retreat(), assist({ melee: true }), shedLoad(), holdFormation(), buff(), rest()],
    };
}

