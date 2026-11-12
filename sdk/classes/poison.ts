// Poisons for the assassins (Infiltrator, Nightshade, Shadowblade), as the user played a Nightshade (2026-11-12):
// a damage-over-time poison on the main hand, a debuff on the off hand, spare main-hand weapons in the bag poisoned too,
// swapped in during a fight, the snare only for a target that runs; and a trip to the realm's poison merchant when the
// bag runs low.
//
// Server code (GameServer, read 2026-11-12):
// - A poison dragged onto a weapon poisons that weapon (GamePlayerInventory.cs:678-686), in a hand or in the bag.
// - ApplyPoison (GamePlayer.cs:7243-7323): Envenom (with items) at least the poison's level, the character's level too,
//   not in combat (the server's 10 s: "You have been in combat recently and can't apply a poison yet!"), not mezzed.
//   Reapplying over a poison isn't refused (that check is commented out). Success: "You apply <poison> to <weapon>.".
// - Every poison row in the DB has one charge: the first landed hit with that weapon fires it and clears the weapon
//   (GameLiving.cs:807-828). Hence the spares: a second and third poisoned hit in one fight is a weapon swap.
// - A poisoned weapon's delve has "- N Charges" (DetailDisplayHandler.WritePoisonInfo.Charges) and the spell's own
//   description ("Inflicts damage ...", "Decreases target's Str.", "Reduces the target's movement speed.").
// - Which stat a target's melee damage comes from (GamePlayer.GetWeaponStat, GamePlayer.cs:5485-5512): Dexterity for
//   staves, bows, crossbows, thrown and shields; the average of Strength and Dexterity for thrust, piercing, spear,
//   flexible and hand to hand; Strength for everything else. So a Strength debuff (weakening, enervating) counts fully
//   against a sword, axe or hammer, half against a dagger or spear, and not at all against a bow or a staff.
// - Disease (infectious serum, DiseaseECSEffect): -15 % run speed, -7.5 % Strength, and every heal on the target does
//   half (HealSpellHandler.cs:82-86): the poison for a healer, a caster or an archer. Dexterity also shortens casting
//   (GameLiving.cs:298), but the Dexterity poison (inhibiting) isn't on any merchant's list, so it isn't carried.
// - The realms' poison merchants (merchants.json AlbPoison1, HibPoison, MidPoison2) sell lethal, weakening, imbalancing,
//   crippling, infectious and enervating; Thidranki has none. Albion's (Onyg) stands at Castle Sauvage, Hibernia's
//   (Riber) at Druim Ligen, by the portal keeps; Midgard's nearest (Gwaell) at Audliten, a port from Svasud Faste.

import { getClass } from '../../data/index';
import { enterBattleground, leaveBattleground } from '../group/battleground';
import type { Behavior, Member, MemberContext } from '../group/member';
import { EquipmentSlot, ObjectType, type GameMessage, type InventoryItem, type Realm } from '../types';

export type PoisonRole = 'dot' | 'debuff' | 'snare' | 'disease';
export interface PoisonRow { name: string; level: number; role: PoisonRole; price: number }
/**
 * Best first within each role (merchants.json prices, copper, for a pack of PACK: one buy gives PACK poisons, Mordred at Onyg
 * 2026-11-12). The id is the name with underscores and a realm suffix.
 */
export const POISONS: readonly PoisonRow[] = [
    { name: 'greater lethal poison', level: 20, role: 'dot', price: 770 },
    { name: 'major lethal poison', level: 15, role: 'dot', price: 560 },
    { name: 'lethal poison', level: 10, role: 'dot', price: 350 },
    { name: 'minor enervating poison', level: 22, role: 'debuff', price: 941 },
    { name: 'greater weakening poison', level: 17, role: 'debuff', price: 492 },
    { name: 'major weakening poison', level: 11, role: 'debuff', price: 330 },
    { name: 'greater imbalancing poison', level: 18, role: 'snare', price: 572 },
    { name: 'major imbalancing poison', level: 13, role: 'snare', price: 420 },
    { name: 'lesser infectious serum', level: 16, role: 'disease', price: 424 },
    { name: 'minor infectious serum', level: 4, role: 'disease', price: 120 },
];
const SUFFIX: Record<string, string> = { albion: '', midgard: '2', hibernia: '3' };

/** The template id for a poison in a realm (itemtemplate Id_nb). */
export const poisonId = (name: string, realm: Realm) => `${name.replace(/ /g, '_')}${SUFFIX[realm] ?? ''}`;

/** The best poison of each role an Envenom level (with items) may use. */
export function poisonPlan(envenom: number): Record<PoisonRole, PoisonRow | null> {
    const best = (role: PoisonRole) => POISONS.find(p => p.role === role && p.level <= envenom) ?? null;
    return { dot: best('dot'), debuff: best('debuff'), snare: best('snare'), disease: best('disease') };
}

/** How many of each to carry, and below what to go and buy. A fight spends one per poisoned hit. */
export const STOCK: Readonly<Record<PoisonRole, { carry: number; low: number }>> = {
    dot: { carry: 10, low: 2 },
    debuff: { carry: 6, low: 1 },
    snare: { carry: 4, low: 0 },
    disease: { carry: 4, low: 0 },
};
/** Spare main-hand weapons in the bag: one with the snare, one with the disease, one with a second damage over time (it lasts 20 s). */
export const SPARES = 3;
/** One buy at a poison merchant gives this many. */
export const PACK = 20;

/** A delve's lines: the poison a weapon carries by its role, or null when clean (no charge left). */
export function poisonOn(lines: readonly string[]): PoisonRole | null {
    const charged = lines.some(l => { const m = /^\s*-\s*(\d+)\s+Charges\b/i.exec(l); return !!m && Number(m[1]) > 0; });
    if (!charged) return null;
    // The delve's spell lines, live (Mordred, 2026-11-12): "Inflicts 26 body damage every 4 seconds for 20 seconds.",
    // "Decreases the target's strength by 44 ...", "The target is slowed by 40% ...", "Inflicts a wasting disease ...".
    const text = lines.join(' ');
    if (/wasting disease|inhibits healing/i.test(text)) return 'disease';
    if (/is slowed by|movement speed|speed decrease/i.test(text)) return 'snare';
    if (/damage every|inflicts damage|damage over time/i.test(text)) return 'dot';
    return 'debuff';
}
/** Poisoned at all. */
export const isPoisoned = (lines: readonly string[]) => poisonOn(lines) !== null;

export type PoisonApplyReason = 'applied' | 'in_combat' | 'cant_use' | 'cant_poison' | 'no_answer';
/** The server's answer to an application. */
export function applyAnswer(texts: readonly string[]): PoisonApplyReason | null {
    for (const t of texts) {
        if (/^You apply .+ to .+\.$/i.test(t)) return 'applied';
        if (/combat recently and can't apply a poison/i.test(t)) return 'in_combat';
        if (/can't use (this poison|poisons)/i.test(t)) return 'cant_use';
        if (/can't poison this weapon|Poisons can be applied only to weapons/i.test(t)) return 'cant_poison';
    }
    return null;
}

/** What each poisoned weapon should carry: the main hand the damage over time, the off hand the Strength debuff, the spares the snare, the disease, then the damage over time. */
export function wantedRoles(spares: number): { main: PoisonRole; off: PoisonRole; spares: PoisonRole[] } {
    const order: PoisonRole[] = ['snare', 'disease'];
    return { main: 'dot', off: 'debuff', spares: Array.from({ length: spares }, (_, i) => order[i] ?? 'dot') };
}

export type DamageStat = 'str' | 'strdex' | 'dex';
const DEX_FAMILIES = new Set(['bow', 'crossbow', 'staff', 'thrown', 'instrument', 'shield']);
const STRDEX_FAMILIES = new Set(['thrust', 'flex', 'h2h']);
/** By class when nothing was seen held: the archers shoot (Dexterity), these stab or flail (Strength and Dexterity). */
const DEX_CLASSES = /^(Scout|Ranger|Hunter|Huntress)$/;
const STRDEX_CLASSES = /^(Infiltrator|Nightshade|Reaver|Savage|Minstrel)$/;

/**
 * The stat a target's melee damage comes from: by the weapon families the class read saw it hold or swing
 * ("weapons thrust slash|crush"), else by its likeliest class. Unknown: Strength, the most common.
 */
export function damageStatOf(c: { classGuess?: { classes: string[]; basis: string[] } }): DamageStat {
    const seen = c.classGuess?.basis.find(b => b.startsWith('weapons '));
    if (seen) {
        const families = seen.slice(8).split(/[ |]/).filter(Boolean);
        if (families.every(f => DEX_FAMILIES.has(f))) return 'dex';
        const melee = families.filter(f => !DEX_FAMILIES.has(f));
        if (melee.every(f => STRDEX_FAMILIES.has(f))) return 'strdex';
        return 'str';
    }
    const cls = c.classGuess?.classes[0] ?? '';
    return DEX_CLASSES.test(cls) ? 'dex' : STRDEX_CLASSES.test(cls) ? 'strdex' : 'str';
}

/** What weakens this target most: the disease on a healer, caster or crowd controller (heals on it halved) or one whose damage is Dexterity's; else the Strength debuff. */
export function debuffFor(c: { classGuess?: { classes: string[]; basis: string[]; role?: string }; healer?: boolean; caster?: boolean }): 'debuff' | 'disease' {
    const role = c.classGuess?.role ?? (c.healer ? 'healer' : c.caster ? 'caster' : undefined);
    if (role === 'healer' || role === 'caster' || role === 'cc') return 'disease';
    return damageStatOf(c) === 'dex' ? 'disease' : 'debuff';
}

/** What to buy, in packs (a count of buys): enough packs for STOCK.carry of each role's best, cheapest roles last if the purse runs short. */
export function shoppingList(plan: Record<PoisonRole, PoisonRow | null>, have: Record<PoisonRole, number>, copper: number): { row: PoisonRow; count: number }[] {
    const out: { row: PoisonRow; count: number }[] = [];
    let left = copper;
    for (const role of ['dot', 'debuff', 'disease', 'snare'] as const) {
        const row = plan[role];
        if (!row) continue;
        const count = Math.min(Math.ceil(Math.max(0, STOCK[role].carry - have[role]) / PACK), Math.floor(left / row.price));
        if (count > 0) { out.push({ row, count }); left -= count * row.price; }
    }
    return out;
}

/** Below the low mark for the damage over time or the debuff: time to buy. */
export function needsRestock(plan: Record<PoisonRole, PoisonRow | null>, have: Record<PoisonRole, number>): boolean {
    return (['dot', 'debuff'] as const).some(r => plan[r] !== null && have[r] < STOCK[r].low);
}

/** Fleeing: out of melee, further than at the last look by FLEE_STEP within FLEE_WINDOW_MS. */
export function isFleeing(prev: { distance: number; at: number } | undefined, now: { distance: number; at: number }): boolean {
    if (!prev || now.distance <= FLEE_MIN) return false;
    return now.at - prev.at <= FLEE_WINDOW_MS && now.distance - prev.distance >= FLEE_STEP;
}
const FLEE_MIN = 200;
const FLEE_STEP = 60;
const FLEE_WINDOW_MS = 2500;

// ── Live ────────────────────────────────────────────────────────────────────

const inBag = (i: InventoryItem) => i.slot >= EquipmentSlot.FirstBackpack && i.slot <= EquipmentSlot.LastBackpack;
const RIGHT = EquipmentSlot.RightHand, LEFT = EquipmentSlot.LeftHand;
/** After a refusal, the next try no sooner. */
const RETRY_MS = 4000;
const ANSWER_MS = 3000;
/** The damage over time runs 20 s: a fresh one goes on no sooner than this after the last fired. */
const DOT_AGAIN_MS = 18_000;
/** In a fight, look at the main hand at most this often. */
const LOOK_MS = 2500;

const envenomOf = (ctx: Pick<MemberContext, 'sdk'>) => { const s = ctx.sdk.findSpecialization('Envenom'); return s ? s.level + (s.bonus ?? 0) : 0; };
const poisonsInBag = (ctx: Pick<MemberContext, 'sdk'>) => ctx.sdk.getInventory().filter(i => inBag(i) && i.objectType === ObjectType.Poison);
/** Spare main-hand weapons: in the bag, the main hand's own name (the gear template's piece). */
const sparesOf = (ctx: Pick<MemberContext, 'sdk'>) => {
    const main = ctx.sdk.getEquipment().find(e => e.slot === RIGHT);
    return main ? ctx.sdk.getInventory().filter(i => inBag(i) && i.name === main.name) : [];
};
function countByRole(ctx: Pick<MemberContext, 'sdk'>, plan: Record<PoisonRole, PoisonRow | null>): Record<PoisonRole, number> {
    const bag = poisonsInBag(ctx);
    const n = (role: PoisonRole) => bag.filter(i => i.name.toLowerCase() === plan[role]?.name).reduce((s, i) => s + i.count, 0);
    return { dot: n('dot'), debuff: n('debuff'), snare: n('snare'), disease: n('disease') };
}

/** Drag a poison from the bag onto a weapon (hand or bag slot) and read the server's answer. */
export async function applyPoison(ctx: Pick<MemberContext, 'sdk'>, poison: InventoryItem, weaponSlot: number): Promise<PoisonApplyReason> {
    const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
    const said = () => ctx.sdk.getGameMessages().filter((m: GameMessage) => m.id > since).map(m => m.text);
    await ctx.sdk.sendMoveItem(poison.slot, weaponSlot);
    await ctx.sdk.waitForCondition(() => applyAnswer(said()) !== null, ANSWER_MS).catch(() => null);
    return applyAnswer(said()) ?? 'no_answer';
}

/** The poison a weapon carries, by delve. Unread: undefined. */
async function look(ctx: MemberContext, slot: number): Promise<PoisonRole | null | undefined> {
    const item = [...ctx.sdk.getEquipment(), ...ctx.sdk.getInventory()].find(i => i.slot === slot);
    if (!item) return undefined;
    const d = await ctx.bot.delveItem(item);
    return d.success ? poisonOn(d.lines) : undefined;
}

/** Out of combat this long (the server's 10 s, from the client's 8 s, plus slack). */
function outOfCombat(ctx: MemberContext, key: string, ms = 2500): boolean {
    const me = ctx.me();
    const now = Date.now();
    if (me.inCombat || me.attacking) { ctx.memory.set(key, now); return false; }
    return now - (ctx.memory.get(key) ?? 0) >= ms;
}

/**
 * Out of combat, after a fight (or every 5 minutes): every weapon carries its poison. The main hand the damage over
 * time (a spare that has it comes into the hand first if the main hand holds the snare), the off hand the debuff, one
 * spare the snare and the rest the damage over time. Each look is a delve; each application one poison from the bag.
 */
export const envenom = (): Behavior => ({
    name: 'envenom',
    interruptible: false,
    async run(ctx) {
        if (ctx.me().isDead || !outOfCombat(ctx, 'poisonFightAt')) return false;
        const now = Date.now();
        if (now < (ctx.memory.get('poisonRetryAt') ?? 0)) return false;
        const fought = (ctx.memory.get('poisonFightAt') ?? 0) > (ctx.memory.get('poisonCheckAt') ?? 0);
        if (!fought && now - (ctx.memory.get('poisonCheckAt') ?? 0) < 5 * 60_000) return false;
        const plan = poisonPlan(envenomOf(ctx));
        if (!plan.dot && !plan.debuff) return false;
        ctx.memory.set('poisonCheckAt', now);
        const roles = wantedRoles(SPARES);
        const kinds = new Map<number, PoisonRole | null>();
        for (const slot of [RIGHT, LEFT, ...sparesOf(ctx).map(s => s.slot)]) {
            const k = await look(ctx, slot);
            if (k !== undefined) kinds.set(slot, k);
        }
        // The main hand holds the snare (swapped in last fight) and a spare holds the damage over time: swap them back.
        const spareDot = sparesOf(ctx).find(s => kinds.get(s.slot) === 'dot');
        if (kinds.get(RIGHT) === 'snare' && spareDot) {
            const was = spareDot.slot;
            await ctx.bot.equipItem(spareDot, { slot: RIGHT });
            kinds.set(was, 'snare');
            kinds.set(RIGHT, 'dot');
        }
        const left = ctx.sdk.getEquipment().find(e => e.slot === LEFT);
        const wanted: [number, PoisonRole][] = [[RIGHT, roles.main]];
        if (left && left.objectType !== ObjectType.Shield) wanted.push([LEFT, roles.off]);
        // The spares: whichever of the snare and the disease none of them holds yet, then the damage over time.
        const spares = sparesOf(ctx);
        const missing = wantedRoles(spares.length).spares.filter(r => r !== 'dot' && !spares.some(s => kinds.get(s.slot) === r));
        for (const s of spares) {
            if (kinds.get(s.slot)) continue;
            wanted.push([s.slot, missing.shift() ?? 'dot']);
        }
        let acted = false;
        for (const [slot, role] of wanted) {
            if (kinds.get(slot) || !kinds.has(slot)) continue;
            const row = plan[role] ?? plan.dot;
            const poison = row && poisonsInBag(ctx).find(i => i.name.toLowerCase() === row.name);
            if (!poison) continue;
            ctx.doing('poison', null, `${row.name} on slot ${slot}`);
            const r = await applyPoison(ctx, poison, slot);
            ctx.result('poison', { success: r === 'applied', reason: r, message: `${row.name} on slot ${slot}: ${r}` });
            acted = true;
            if (r === 'in_combat' || r === 'no_answer') { ctx.memory.set('poisonRetryAt', Date.now() + RETRY_MS); ctx.memory.set('poisonCheckAt', 0); break; }
        }
        return acted;
    },
});

/**
 * In a fight, after the opener: a spare comes into the main hand when its poison would land. The snare one when the
 * focus runs; a fresh damage over time once the main hand's has fired and run most of its 20 s. An instant: a look
 * (a delve) at most every LOOK_MS, a swap one move.
 */
export const swapPoison = (): Behavior => ({
    name: 'swapPoison',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || typeof o.focus !== 'number' || ctx.sdk.isStealthed() || ctx.me().isDead) return false;
        const focus = ctx.sdk.getNearbyPlayer(o.focus) ?? ctx.sdk.getNearbyNpc(o.focus);
        if (!focus || focus.distance > 600) return false;
        const now = Date.now();
        const prev = ctx.memory.get('swapFocus') as { id: number; distance: number; at: number } | undefined;
        const seen = { id: focus.objectId, distance: focus.distance, at: now };
        ctx.memory.set('swapFocus', seen);
        const fleeing = isFleeing(prev?.id === focus.objectId ? prev : undefined, seen);
        if (!fleeing && now - (ctx.memory.get('swapLookAt') ?? 0) < LOOK_MS) return false;
        ctx.memory.set('swapLookAt', now);
        const main = await look(ctx, RIGHT);
        if (main === undefined) return false;
        if (main === 'dot') ctx.memory.set('dotHeldAt', now);
        const kinds: Map<number, PoisonRole | null> = ctx.memory.get('spareKinds') ?? new Map();
        const spares = sparesOf(ctx);
        const spareWith = async (role: PoisonRole) => {
            for (const s of spares) {
                if (!kinds.has(s.slot)) kinds.set(s.slot, (await look(ctx, s.slot)) ?? null);
                if (kinds.get(s.slot) === role) return s;
            }
            return undefined;
        };
        let pick: InventoryItem | undefined;
        let why = '';
        // A healer, caster or archer gets the disease, once a focus, right after the opener's damage over time has fired.
        const contact = ctx.focus();
        const diseased: Set<number> = ctx.memory.get('diseasedFoci') ?? new Set();
        ctx.memory.set('diseasedFoci', diseased);
        const wantsDisease = !!contact && debuffFor(contact) === 'disease' && !diseased.has(focus.objectId);
        if (fleeing && main !== 'snare') { pick = await spareWith('snare'); why = 'the focus runs: the snare'; }
        else if (main === null && wantsDisease) { pick = await spareWith('disease'); why = 'a healer, caster or archer: the disease'; if (pick) diseased.add(focus.objectId); }
        // The main hand's damage over time fired (it was there, now it's clean) long enough ago.
        else if (main === null && now - (ctx.memory.get('dotHeldAt') ?? 0) >= DOT_AGAIN_MS) { pick = await spareWith('dot'); why = 'a fresh damage over time'; }
        ctx.memory.set('spareKinds', kinds);
        if (!pick) return false;
        ctx.doing('swap', focus.objectId, why);
        const from = pick.slot;
        const r = await ctx.bot.equipItem(pick, { slot: RIGHT });
        ctx.result('swap', r, focus.objectId);
        if (r.success) {
            kinds.set(from, main);
            if (why.includes('damage over time')) ctx.memory.set('dotHeldAt', Date.now());
        }
        return false;
    },
});

/** Where each realm buys: the merchant, and for Midgard the port there from the portal keep. */
export const POISON_SHOPS: Readonly<Record<string, { merchant: string; regionId: number; x: number; y: number; port?: { teleporter: string; keyword: string } }>> = {
    albion: { merchant: 'Onyg', regionId: 1, x: 584478, y: 477657 },
    hibernia: { merchant: 'Riber', regionId: 200, x: 334704, y: 419739 },
    midgard: { merchant: 'Gwaell', regionId: 100, x: 730154, y: 760955, port: { teleporter: 'Young Gothi', keyword: 'Audliten' } },
};
/** A trip costs about this; with less in the purse it doesn't go. */
const TRIP_MIN_COPPER = 3000;

/**
 * Low on poisons, out of combat, alone (a solo squad: nobody waits for us): out of the battleground, to the realm's
 * poison merchant, buy up to STOCK.carry of each, and back in (enterBattleground: teleporter, bind, medallion). Some
 * minutes; nothing else runs meanwhile.
 */
export const restock = (): Behavior => ({
    name: 'restock',
    interruptible: false,
    async run(ctx) {
        const me = ctx.me();
        if (me.isDead || me.regionId !== 252 || ctx.members().filter(m => !m.isDead).length > 1) return false;
        if (!outOfCombat(ctx, 'restockFightAt', 12_000)) return false;
        const now = Date.now();
        if (now < (ctx.memory.get('restockRetryAt') ?? 0)) return false;
        const plan = poisonPlan(envenomOf(ctx));
        if (!needsRestock(plan, countByRole(ctx, plan))) return false;
        const shop = POISON_SHOPS[me.realm];
        if (!shop || (me.money?.totalCopper ?? 0) < TRIP_MIN_COPPER) { ctx.memory.set('restockRetryAt', now + 10 * 60_000); return false; }
        ctx.memory.set('restockRetryAt', now + 15 * 60_000);
        const member: Member = { bot: me.name.toLowerCase(), role: ctx.role, sdk: ctx.sdk, actions: ctx.bot };
        const log = (line: string) => ctx.note(`restock: ${line}`);
        ctx.doing('restock', null, `to ${shop.merchant}`);
        const out = await leaveBattleground([member], { log });
        if (!out.success) { ctx.result('restock', { success: false, message: `out: ${out.message}` }); return true; }
        if (shop.port) {
            await ctx.bot.walkToObject(shop.port.teleporter, { range: 200 });
            await ctx.bot.whisper(shop.port.teleporter, shop.port.keyword);
            await ctx.sdk.waitForCondition(s => !!s.player && Math.hypot(s.player.x - shop.x, s.player.y - shop.y) < 4000, 20_000).catch(() => null);
        }
        await ctx.bot.walkTo(shop.x, shop.y, { tolerance: 300, timeout: 60_000 });
        const bought: string[] = [];
        const list = shoppingList(plan, countByRole(ctx, plan), ctx.me().money?.totalCopper ?? 0);
        for (const { row, count } of list) {
            const b = await ctx.bot.buyItem(shop.merchant, row.name, count);
            bought.push(`${row.name} x${b.count}${b.success ? '' : ` (${b.reason})`}`);
        }
        log(`bought ${bought.join(', ') || 'nothing'}`);
        const back = await enterBattleground([member], { log });
        ctx.result('restock', { success: back.success, message: `${bought.join(', ')}; back: ${back.message}` });
        return true;
    },
});

/** A class with Envenom: the poison behaviours are for it. */
export const usesPoison = (className: string) => !!getClass(className) && /Infiltrator|Nightshade|Shadowblade/.test(className);
