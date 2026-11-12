// Test fixtures for the realm board and director: the parts of a gateway group frame they read.

import type { GroupFrame, GroupMemberView, WorldContact } from '../../gateway/group-types';

export interface MemberSpec { name: string; x: number; y: number; z?: number; hp?: number; dead?: boolean; combat?: boolean; realm?: string; regionId?: number; inRun?: boolean }

export function member(m: MemberSpec): GroupMemberView {
    return {
        bot: m.name.toLowerCase(), username: m.name.toLowerCase(), charName: m.name, role: 'melee', leader: false,
        client: { status: 'active', stateAge: 100, phase: 'playing', lastError: null, controllers: 1, observers: 0 },
        player: {
            name: m.name, objectId: m.name.length * 7, level: 24, levelPermill: 0, className: 'Armsman', realm: m.realm ?? 'albion',
            regionId: m.regionId ?? 252, zoneId: 0, zoneName: 'Thidranki', x: m.x, y: m.y, z: m.z ?? 0, heading: 0, speed: 0,
            hp: m.hp ?? 100, mana: 100, endurance: 100, concentration: 0, maxConcentration: 0,
            isDead: !!m.dead, isSitting: false, inCombat: !!m.combat, attacking: false, targetObjectId: null, load: null, deathCount: 0, constitutionLost: 0,
        },
        movement: null, inGameGroup: [],
        run: m.inRun === false ? null : { name: m.name, role: 'melee', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, effects: [], can: { heal: false, cc: false, nuke: false }, at: 0 },
    };
}

export interface FoeSpec { id: number; x: number; y: number; realm?: string; board?: boolean; stale?: boolean; dead?: boolean; healer?: boolean; caster?: boolean; threat?: boolean; role?: string; seenBy?: string[]; regionId?: number; npc?: boolean }

export function foe(f: FoeSpec): WorldContact {
    const regionId = f.regionId ?? 252;
    return {
        key: `${regionId}:${f.id}`, objectId: f.id, regionId, kind: f.npc ? 'npc' : 'player', name: 'Norseman', level: 24, realm: f.realm ?? 'midgard',
        x: f.x, y: f.y, z: 0, heading: 0, speed: 0, hp: 100, inCombat: true, isDead: !!f.dead, targetObjectId: null, target: null, npc: null,
        enemy: true, seenBy: f.seenBy ?? ['A'], nearest: 0,
        board: f.board === false ? null : {
            threat: f.threat ?? true, stale: !!f.stale, cc: null, engagedAt: 0, hostileSince: 0, seenBy: f.seenBy ?? ['A'], lastSeen: 0,
            ...(f.healer ? { healer: true } : {}), ...(f.caster ? { caster: true } : {}), ...(f.role ? { classGuess: { classes: [], p: [], role: f.role, basis: [] } } : {}),
        } as WorldContact['board'],
    };
}

export interface FrameSpec { id: string; now?: number; members: MemberSpec[]; foes?: FoeSpec[]; phase?: string; reason?: string; state?: string; noRun?: boolean; runId?: string; playerKills?: number }

export function frame(f: FrameSpec): GroupFrame {
    return {
        v: 1, id: f.id, name: f.id, leader: { bot: 'a', username: 'a' }, now: f.now ?? 0, boot: 1,
        members: f.members.map(member), world: (f.foes ?? []).map(foe),
        grouping: { inLeaderGroup: [], missing: [], strangers: [] },
        run: f.noRun ? null : {
            runId: f.runId ?? `${f.id}-run`, state: (f.state ?? 'live') as any, error: null, current: true, firstAt: 0, lastAt: 0, skewMs: 0, strategy: 'rvr',
            orders: { seq: 1, phase: (f.phase ?? 'travel') as any, objective: '', anchor: null, facing: null, focus: null, puller: null, cc: [], retreatTo: null, waiting: [], reason: f.reason ?? '', issuedAt: 0 },
            pictureAt: 0, timing: { windingDown: false, deadline: null, hardStop: null }, coordinator: null, planRev: 0, reportRev: 0,
            events: [], eventSeq: 0, eventsFrom: 1, lostEvents: 0, moreEvents: false, control: [], result: null,
            ...(f.playerKills !== undefined ? { report: { totals: { playerKills: f.playerKills, deathsToPlayers: 0 } } as any } : {}),
        },
        others: [], passive: { events: [], seq: 0 }, notes: [],
    };
}

