// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
// formatter.ts: world state as text (CLI, runner, MCP) and as a structured
// WorldSummary (MCP execute_code structuredContent).

import type { BotWorldState, GameMessage, InventoryItem, NearbyNpc, NearbyObject, NearbyPlayer, PlayerState } from './types';
import { isOwnMessage, isPlayerChat } from './chat-history';

function formatAge(ms: number): string {
    if (ms < 1000) return 'just now';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
}

const r = (n: number) => Math.round(n);

/** "2g 15s 3c" style money string from a copper total. */
export function formatMoney(totalCopper: number): string {
    if (!totalCopper) return '0c';
    const parts: string[] = [];
    let rest = Math.floor(totalCopper);
    const units: [string, number][] = [['p', 100 * 100 * 1000 * 1000], ['m', 100 * 100 * 1000], ['g', 100 * 100], ['s', 100], ['c', 1]];
    for (const [label, size] of units) {
        const n = Math.floor(rest / size);
        if (n > 0) parts.push(`${n}${label}`);
        rest -= n * size;
    }
    return parts.join(' ');
}

function capitalize(s: string): string {
    return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function targetOf(state: BotWorldState): NearbyNpc | NearbyPlayer | NearbyObject | null {
    const id = state.player?.targetObjectId;
    if (id === null || id === undefined) return null;
    return state.nearbyNpcs.find(o => o.objectId === id)
        ?? state.nearbyPlayers.find(o => o.objectId === id)
        ?? state.nearbyObjects.find(o => o.objectId === id)
        ?? null;
}

function vitals(p: PlayerState): string {
    const parts = [`HP ${p.health}/${p.maxHealth}`];
    if (p.maxMana > 0) parts.push(`Mana ${p.mana}/${p.maxMana}`);
    parts.push(`End ${p.endurance}/${p.maxEndurance}`);
    if (p.maxConcentration > 0) parts.push(`Conc ${p.concentration}/${p.maxConcentration}`);
    return parts.join(' | ');
}

function messageLine(m: GameMessage): string {
    if (m.type === 'send' && m.sender) return `[PM ${m.sender}] ${m.text}`;
    return m.text;
}

function itemLabel(item: InventoryItem): string {
    return item.count > 1 ? `${item.name} x${item.count}` : item.name;
}

function blockers(state: BotWorldState): string[] {
    const out: string[] = [];
    if (state.dialog?.isOpen) out.push(`dialog open (code ${state.dialog.code}${state.dialog.type === 1 ? ', yes/no' : ''}): "${state.dialog.text.slice(0, 60)}"`);
    if (state.merchant?.isOpen) out.push(`merchant open (${state.merchant.items.length} items)`);
    if (state.trainer?.isOpen) out.push('trainer open');
    if (state.player?.isDead) out.push('DEAD - sendRelease() to return to bind');
    return out;
}

export interface SummaryBaseline {
    level?: number;
    experience?: number;
    realmPoints?: number;
    totalCopper?: number;
}

/**
 * A handful of lines for the post-script snapshot: position, vitals, progress
 * since `baseline`, inventory, target, anything blocking, last few messages.
 */
export function formatWorldStateSummary(state: BotWorldState, stateAgeMs?: number, options?: { baseline?: SummaryBaseline }): string {
    const lines: string[] = [];
    const stale = stateAgeMs !== undefined && stateAgeMs > 5000 ? ` | state ${formatAge(stateAgeMs)}` : '';
    const p = state.player;
    if (p) {
        const combat = p.inCombat ? ' | IN COMBAT' : '';
        lines.push(`${p.name} L${p.level} ${p.className} @ ${p.zoneName || `zone ${p.zoneId}`} (r${p.regionId} ${r(p.x)}, ${r(p.y)}, ${r(p.z)})${combat}${stale}`);
        lines.push(vitals(p) + (p.isDead ? ' | DEAD' : '') + (p.isSitting ? ' | sitting' : ''));
        const b = options?.baseline;
        if (b) {
            const gains: string[] = [];
            if (b.level !== undefined && p.level > b.level) gains.push(`level +${p.level - b.level}`);
            if (b.experience !== undefined && p.experience !== b.experience) gains.push(`xp ${p.experience > b.experience ? '+' : ''}${(p.experience - b.experience).toLocaleString()}`);
            if (b.realmPoints !== undefined && p.realmPoints > b.realmPoints) gains.push(`rp +${p.realmPoints - b.realmPoints}`);
            if (b.totalCopper !== undefined && p.money.totalCopper !== b.totalCopper) {
                const delta = p.money.totalCopper - b.totalCopper;
                gains.push(`money ${delta > 0 ? '+' : '-'}${formatMoney(Math.abs(delta))}`);
            }
            lines.push(gains.length ? `Progress: ${gains.join(', ')}` : 'Progress: none');
        }
    } else {
        lines.push(`Not in game (${state.connection?.phase ?? 'unknown'}, tick ${state.tick})${stale}`);
    }

    const target = targetOf(state);
    if (target) {
        const hp = 'healthPercent' in target ? ` ${target.healthPercent}%` : '';
        lines.push(`Target: ${target.name}${hp} (${r(target.distance)}u)`);
    }

    const inv = state.inventory ?? [];
    const entries = inv.map(itemLabel);
    lines.push(`Inv ${inv.length}/40: ${entries.length ? entries.slice(0, 8).join(', ') + (entries.length > 8 ? `, +${entries.length - 8} more` : '') : '(empty)'}`);

    const nearbyLine = (label: string, items: { name: string; distance: number }[], limit = 5): string | null => {
        if (items.length === 0) return null;
        const byName = new Map<string, { count: number; distance: number }>();
        for (const e of items) {
            const existing = byName.get(e.name);
            if (existing) { existing.count++; existing.distance = Math.min(existing.distance, e.distance); }
            else byName.set(e.name, { count: 1, distance: e.distance });
        }
        const sorted = [...byName].sort((a, b) => a[1].distance - b[1].distance);
        const shown = sorted.slice(0, limit).map(([name, d]) => `${name}${d.count > 1 ? ` x${d.count}` : ''} (${r(d.distance)}u)`);
        return `${label}: ${shown.join(', ')}${sorted.length > limit ? ` +${sorted.length - limit} more` : ''}`;
    };
    lines.push(...[
        nearbyLine('NPCs', state.nearbyNpcs ?? []),
        nearbyLine('Players', state.nearbyPlayers ?? [], 3),
        nearbyLine('Objects', state.nearbyObjects ?? [], 4),
    ].filter((l): l is string => l !== null));

    const blocking = blockers(state);
    if (blocking.length) lines.push(`[!] ${blocking.join(', ')}`);
    if (state.npcDialog?.keywords.length) lines.push(`NPC ${state.npcDialog.npcName ?? '?'} keywords: ${state.npcDialog.keywords.map(k => `[${k}]`).join(' ')}`);

    const collapsed: { text: string; count: number }[] = [];
    for (const m of (state.gameMessages ?? []).slice(-40)) {
        if (isOwnMessage(m, p?.name)) continue;
        const text = messageLine(m);
        const last = collapsed[collapsed.length - 1];
        if (last && last.text === text) last.count++;
        else collapsed.push({ text, count: 1 });
    }
    for (const m of collapsed.slice(-3)) lines.push(`> ${m.text}${m.count > 1 ? ` (x${m.count})` : ''}`);
    return lines.join('\n');
}

/**
 * World state as readable markdown.
 * `options.sinceMessageId`: only render gameMessages with id > this (the MCP
 * server uses it to avoid re-showing chat). `options.brief` trims lists.
 */
export function formatWorldState(state: BotWorldState, stateAgeMs?: number, options?: { sinceMessageId?: number; brief?: boolean }): string {
    const brief = options?.brief ?? false;
    const lines: string[] = [];
    lines.push('# World State');
    const ageStr = stateAgeMs !== undefined ? ` | Updated: ${formatAge(stateAgeMs)}` : '';
    lines.push(`Tick: ${state.tick} | In Game: ${state.inGame} | Phase: ${state.connection?.phase ?? 'unknown'}${ageStr}`);
    if (state.connection?.lastError) lines.push(`Last error: ${state.connection.lastError}`);

    const p = state.player;
    if (p) {
        lines.push('', '## Player');
        lines.push(`${p.name}${p.lastName ? ` ${p.lastName}` : ''}${p.guildName ? ` <${p.guildName}>` : ''} - level ${p.level} ${p.raceName} ${p.className} (${capitalize(p.realm)})`);
        lines.push(`Position: region ${p.regionId}, ${p.zoneName || `zone ${p.zoneId}`} (${r(p.x)}, ${r(p.y)}, ${r(p.z)}) heading ${p.heading}`);
        lines.push(vitals(p));
        lines.push(`XP: ${p.experience.toLocaleString()} / ${p.experienceForNextLevel.toLocaleString()} (${(p.levelPermill / 10).toFixed(1)}%) | RP ${p.realmPoints} | Money ${formatMoney(p.money.totalCopper)}`);
        if (p.specPoints || p.realmSpecPoints) lines.push(`Spec points: ${p.specPoints}${p.realmSpecPoints ? ` | realm spec points: ${p.realmSpecPoints}` : ''}`);
        const status: string[] = [];
        if (p.isDead) status.push(`DEAD (deaths: ${p.deathCount})`);
        if (p.isSitting) status.push('sitting');
        if (p.inCombat) status.push('in combat');
        if (p.attacking) status.push('auto-attack on');
        if (state.movement?.moving) {
            const d = state.movement.destination;
            status.push(`moving${d ? ` to (${r(d.x)}, ${r(d.y)})` : ''}`);
        } else if (state.movement?.lastStopReason && state.movement.lastStopReason !== 'arrived') {
            status.push(`last move: ${state.movement.lastStopReason}`);
        }
        if (status.length) lines.push(`Status: ${status.join(', ')}`);
        const target = targetOf(state);
        if (target) {
            const hp = 'healthPercent' in target ? ` ${target.healthPercent}%` : '';
            const lvl = 'level' in target ? ` L${target.level}` : '';
            lines.push(`Target: ${target.name}${lvl}${hp} - ${r(target.distance)}u (oid ${target.objectId})`);
        } else if (p.targetObjectId !== null) {
            lines.push(`Target: oid ${p.targetObjectId} (not in view)`);
        }
    }

    if (state.dialog?.isOpen) {
        lines.push('', '## Dialog');
        lines.push(`"${state.dialog.text}" (code ${state.dialog.code}, ${state.dialog.type === 1 ? 'yes/no' : 'ok'})`);
        lines.push('(answer with sdk.sendRespondDialog(true|false))');
    }
    if (state.npcDialog) {
        const d = state.npcDialog;
        lines.push('', `## NPC Dialog (${d.npcName ?? 'unknown'}${d.npcObjectId !== null ? `, oid ${d.npcObjectId}` : ''})`);
        lines.push(brief && d.text.length > 300 ? `${d.text.slice(0, 300)}…` : d.text);
        if (d.keywords.length) lines.push(`Keywords: ${d.keywords.map(k => `[${k}]`).join(' ')} (sdk.sendWhisper(oid, keyword))`);
    }
    if (state.merchant?.isOpen) {
        lines.push('', `## Merchant (oid ${state.merchant.merchantObjectId ?? '?'})`);
        const items = state.merchant.items;
        for (const item of items.slice(0, brief ? 15 : 100)) {
            lines.push(`  [p${item.page} s${item.slot}] ${item.name} L${item.level} - ${formatMoney(item.price)}${item.usable ? '' : ' (unusable)'}`);
        }
        if (items.length > (brief ? 15 : 100)) lines.push(`  ... and ${items.length - (brief ? 15 : 100)} more`);
    }
    if (state.trainer?.isOpen) {
        lines.push('', `## Trainer (${state.trainer.specPoints} spec points)`);
        for (const spec of state.trainer.specs) lines.push(`  [${spec.index}] ${spec.name} ${spec.level} (next: ${spec.nextLevelCost})`);
    }

    lines.push('', `## Inventory (${40 - (state.inventory ?? []).length} free of 40)`);
    if ((state.inventory ?? []).length === 0) lines.push('(Empty)');
    for (const item of state.inventory ?? []) lines.push(`- [${item.slot}] ${itemLabel(item)}${item.level ? ` L${item.level}` : ''}`);

    if ((state.equipment ?? []).length) {
        lines.push('', '## Equipment');
        for (const item of state.equipment) lines.push(`- [${item.slot}] ${item.name}`);
    }

    if ((state.effects ?? []).length) {
        lines.push('', '## Effects');
        for (const e of state.effects) lines.push(`- ${e.name}${e.remainingSeconds > 0 ? ` (${e.remainingSeconds}s)` : ''}${e.isNegative ? ' [debuff]' : ''}`);
    }

    if ((state.group ?? []).length) {
        lines.push('', '## Group');
        for (const g of state.group) lines.push(`- ${g.name} L${g.level} ${g.className} ${g.healthPercent}%${g.isDead ? ' DEAD' : ''}`);
    }

    const skills = state.skills;
    if (skills && !brief) {
        if (skills.specializations.length) lines.push('', '## Specializations', skills.specializations.map(s => `${s.name} ${s.level}`).join(', '));
        if (skills.styles.length) lines.push('', '## Styles', skills.styles.map(s => `${s.name} [${s.skillIndex}]`).join(', '));
        if (skills.spells.length) lines.push('', '## Spells', skills.spells.map(s => `${s.name} L${s.level} [${s.lineIndex}/${s.spellIndex}]${s.cooldownRemaining > 0 ? ` cd ${s.cooldownRemaining}s` : ''}`).join(', '));
        if (skills.abilities.length) lines.push('', '## Abilities', skills.abilities.map(a => a.name).join(', '));
    } else if (skills) {
        lines.push('', `## Skills: ${skills.specializations.length} specs, ${skills.styles.length} styles, ${skills.spells.length} spells, ${skills.abilities.length} abilities (sdk.getSkills())`);
    }

    const npcLimit = brief ? 10 : 25;
    if ((state.nearbyNpcs ?? []).length) {
        lines.push('', '## Nearby NPCs');
        const sorted = [...state.nearbyNpcs].sort((a, b) => a.distance - b.distance);
        for (const n of sorted.slice(0, npcLimit)) {
            const tags = [n.role, n.inCombat ? 'in combat' : null, n.isPeaceful ? 'peaceful' : null, n.realm !== 'none' ? n.realm : null].filter(Boolean);
            lines.push(`- ${n.name} L${n.level} ${n.healthPercent}%${tags.length ? ` [${tags.join(', ')}]` : ''} - ${r(n.distance)}u (oid ${n.objectId})`);
        }
        if (sorted.length > npcLimit) lines.push(`  ... and ${sorted.length - npcLimit} more`);
    }
    if ((state.nearbyPlayers ?? []).length) {
        lines.push('', '## Nearby Players');
        const sorted = [...state.nearbyPlayers].sort((a, b) => a.distance - b.distance);
        for (const pl of sorted.slice(0, 10)) lines.push(`- ${pl.name} L${pl.level} (${pl.realm}) - ${r(pl.distance)}u (oid ${pl.objectId})${pl.isDead ? ' DEAD' : ''}`);
        if (sorted.length > 10) lines.push(`  ... and ${sorted.length - 10} more`);
    }
    if ((state.nearbyObjects ?? []).length) {
        lines.push('', '## Nearby Objects');
        const sorted = [...state.nearbyObjects].sort((a, b) => a.distance - b.distance);
        for (const o of sorted.slice(0, 10)) lines.push(`- ${o.name}${o.isLoot ? ' [loot]' : ''}${o.doorId !== null ? ' [door]' : ''} - ${r(o.distance)}u (oid ${o.objectId})`);
        if (sorted.length > 10) lines.push(`  ... and ${sorted.length - 10} more`);
    }

    const since = options?.sinceMessageId ?? -1;
    const fresh = (state.gameMessages ?? []).filter(m => m.id > since);
    const chat = fresh.filter(m => isPlayerChat(m.type) && !isOwnMessage(m, p?.name));
    const system = fresh.filter(m => !isPlayerChat(m.type));
    if (chat.length) {
        lines.push('', '## Player Chat');
        for (const m of chat.slice(-5)) lines.push(`- (${m.type}) ${messageLine(m)}`);
    }
    if (system.length) {
        lines.push('', '## Recent Messages');
        for (const m of system.slice(-(brief ? 5 : 15))) lines.push(`- ${m.text}`);
    }

    const blocking = blockers(state);
    if (blocking.length) lines.push('', `[!] ${blocking.join(', ')}`);
    return lines.join('\n');
}

export type WorldDetail = 'brief' | 'full';

/** A capped list that says how much it left out. */
export interface WorldList<T> { total: number; items: T[] }

/**
 * Structured world snapshot for execute_code's structuredContent. Every key is
 * always present (null when there's nothing); lists are capped by `detail`
 * alone, nearest first.
 */
export interface WorldSummary {
    tick: number;
    inGame: boolean;
    phase: string;
    stateAgeMs: number | null;
    player: {
        name: string; level: number; realm: string; className: string; raceName: string;
        regionId: number; zoneId: number; zoneName: string; x: number; y: number; z: number; heading: number;
        health: number; maxHealth: number; mana: number; maxMana: number; endurance: number; maxEndurance: number;
        experience: number; levelPermill: number; realmPoints: number; totalCopper: number;
        isDead: boolean; isSitting: boolean; inCombat: boolean; attacking: boolean; moving: boolean; targetObjectId: number | null;
    } | null;
    target: { objectId: number; kind: string; name: string; level: number | null; healthPercent: number | null; distance: number } | null;
    inventory: { freeSlots: number; items: { slot: number; name: string; count: number; level: number }[] };
    equipment: { slot: number; name: string }[];
    effects: { name: string; remainingSeconds: number; isNegative: boolean }[];
    group: { name: string; level: number; className: string; healthPercent: number; isDead: boolean }[];
    npcDialog: { npcObjectId: number | null; npcName: string | null; text: string; keywords: string[] } | null;
    dialog: { code: number; type: number; text: string } | null;
    merchant: { merchantObjectId: number | null; items: WorldList<{ page: number; slot: number; name: string; level: number; price: number }> } | null;
    nearby: {
        npcs: WorldList<{ objectId: number; name: string; level: number; realm: string; healthPercent: number; distance: number; inCombat: boolean; role: string | null; x: number; y: number; z: number }>;
        players: WorldList<{ objectId: number; name: string; level: number; realm: string; distance: number }>;
        objects: WorldList<{ objectId: number; name: string; isLoot: boolean; distance: number; x: number; y: number; z: number }>;
    };
    /** Messages with id > sinceMessageId, oldest first. */
    messages: { chat: { from: string | null; type: string; text: string }[]; system: string[] };
}

const WORLD_LIMITS: Record<WorldDetail, { nearby: number; messages: number }> = {
    brief: { nearby: 10, messages: 5 },
    full: { nearby: 50, messages: 50 },
};

export function summarizeWorldState(state: BotWorldState, stateAgeMs?: number, options?: { sinceMessageId?: number; detail?: WorldDetail }): WorldSummary {
    const limits = WORLD_LIMITS[options?.detail ?? 'brief'];
    const list = <S, T>(source: S[] | undefined, map: (item: S) => T, sort = true): WorldList<T> => {
        const items = [...(source ?? [])];
        const dist = (item: S) => (item as { distance?: number }).distance ?? 0;
        if (sort) items.sort((a, b) => dist(a) - dist(b));
        return { total: items.length, items: items.slice(0, limits.nearby).map(map) };
    };
    const p = state.player;
    const fresh = (state.gameMessages ?? []).filter(m => m.id > (options?.sinceMessageId ?? -1));
    const target = targetOf(state);
    const rd = (n: number) => Math.round(n * 10) / 10;

    return {
        tick: state.tick,
        inGame: state.inGame,
        phase: state.connection?.phase ?? 'unknown',
        stateAgeMs: stateAgeMs ?? null,
        player: p ? {
            name: p.name, level: p.level, realm: p.realm, className: p.className, raceName: p.raceName,
            regionId: p.regionId, zoneId: p.zoneId, zoneName: p.zoneName, x: r(p.x), y: r(p.y), z: r(p.z), heading: p.heading,
            health: p.health, maxHealth: p.maxHealth, mana: p.mana, maxMana: p.maxMana, endurance: p.endurance, maxEndurance: p.maxEndurance,
            experience: p.experience, levelPermill: p.levelPermill, realmPoints: p.realmPoints, totalCopper: p.money.totalCopper,
            isDead: p.isDead, isSitting: p.isSitting, inCombat: p.inCombat, attacking: p.attacking,
            moving: state.movement?.moving ?? false, targetObjectId: p.targetObjectId,
        } : null,
        target: target ? {
            objectId: target.objectId,
            kind: target.kind,
            name: target.name,
            level: 'level' in target ? target.level : null,
            healthPercent: 'healthPercent' in target ? target.healthPercent : null,
            distance: rd(target.distance),
        } : null,
        inventory: {
            freeSlots: 40 - (state.inventory ?? []).length,
            items: (state.inventory ?? []).map(i => ({ slot: i.slot, name: i.name, count: i.count, level: i.level })),
        },
        equipment: (state.equipment ?? []).map(i => ({ slot: i.slot, name: i.name })),
        effects: (state.effects ?? []).map(e => ({ name: e.name, remainingSeconds: e.remainingSeconds, isNegative: e.isNegative })),
        group: (state.group ?? []).map(g => ({ name: g.name, level: g.level, className: g.className, healthPercent: g.healthPercent, isDead: g.isDead })),
        npcDialog: state.npcDialog ? {
            npcObjectId: state.npcDialog.npcObjectId, npcName: state.npcDialog.npcName, text: state.npcDialog.text, keywords: state.npcDialog.keywords,
        } : null,
        dialog: state.dialog?.isOpen ? { code: state.dialog.code, type: state.dialog.type, text: state.dialog.text } : null,
        merchant: state.merchant?.isOpen ? {
            merchantObjectId: state.merchant.merchantObjectId,
            items: list(state.merchant.items, i => ({ page: i.page, slot: i.slot, name: i.name, level: i.level, price: i.price }), false),
        } : null,
        nearby: {
            npcs: list(state.nearbyNpcs, n => ({
                objectId: n.objectId, name: n.name, level: n.level, realm: n.realm, healthPercent: n.healthPercent, distance: rd(n.distance),
                inCombat: n.inCombat, role: n.role, x: r(n.x), y: r(n.y), z: r(n.z),
            })),
            players: list(state.nearbyPlayers, pl => ({ objectId: pl.objectId, name: pl.name, level: pl.level, realm: pl.realm, distance: rd(pl.distance) })),
            objects: list(state.nearbyObjects, o => ({ objectId: o.objectId, name: o.name, isLoot: o.isLoot, distance: rd(o.distance), x: r(o.x), y: r(o.y), z: r(o.z) })),
        },
        messages: {
            chat: fresh.filter(m => isPlayerChat(m.type) && !isOwnMessage(m, p?.name)).slice(-limits.messages)
                .map(m => ({ from: m.sender, type: m.type, text: m.text })),
            system: fresh.filter(m => !isPlayerChat(m.type)).slice(-limits.messages).map(m => m.text),
        },
    };
}
