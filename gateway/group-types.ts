// What the gateway serves about groups (gateway/groups.ts) to the viewer's
// group page (gateway/viewer/group.ts), the index page and sdk/group/cli.ts.
// Types only, so the browser bundle can import them.
//
// A group is a groups/<id>/group.json on the gateway's disk. Its picture has two
// sources: the members' own states, which the gateway always holds (positions,
// health, what each client sees), and the latest publish of a group run
// (sdk/group/wire.ts: orders, activities, the board's contacts, events, the
// observer's score so far), when one is running.

import type { Activity, Contact, Orders, Phase, Role } from '../sdk/group/types';
import type { ControlRequest, CoordinatorView, LiveReport, PlanView, RunMeta, RunResultView, WireEvent } from '../sdk/group/wire';
import type { Vec3 } from '../sdk/types';

/**
 * A run as the gateway sees it, from the runner's declared phase and the age of
 * its last publish (gateway clock):
 *   starting  declared 'starting', published within the last 30 s
 *   live      declared 'running', published within the last 5 s
 *   stale     declared 'running', last publish 5-30 s ago
 *   ending    declared 'ending', within the last 30 s
 *   ended     declared 'ended', or 'ending' longer than 30 s ago
 *   lost      anything else older than 30 s (killed process); a later publish revives it
 */
export type RunState = 'starting' | 'live' | 'stale' | 'ending' | 'ended' | 'lost';

/** The member's gateway session: sessionStatus(), or 'none' when no client ever registered as it. */
export type ClientStatus = 'active' | 'stale' | 'dead' | 'none';

/** Which group a bot belongs to, for /bots and /status/<bot>. */
export interface GroupBadge {
    id: string;
    name: string;
    run: { runId: string; state: RunState; phase: Phase | null } | null;
}

/** GET /groups */
export interface GroupListEntry {
    id: string;
    name: string;
    /** Leader bot folder. */
    leader: string;
    /** group.json could not be read or is invalid (the group is listed without members). */
    error: string | null;
    /** runs/campaign.log exists. */
    hasCampaign: boolean;
    members: {
        bot: string;
        username: string;
        /** Character name: from the member's state, else bot.env CHAR_NAME, else null. */
        name: string | null;
        role: Role | null;
        status: ClientStatus;
        inGame: boolean;
        isDead: boolean;
        level: number | null;
        className: string | null;
        regionId: number | null;
        zoneName: string | null;
    }[];
    /** The current run (see GroupFrame.run), null when none ever published since the gateway started. */
    run: { runId: string; state: RunState; strategy: string; phase: Phase | null; ageMs: number; windingDown: boolean } | null;
}

/** A member's player, from its own last state (gateway clock is GroupMemberView.client.stateAge). */
export interface MemberPlayer {
    name: string;
    objectId: number;
    level: number;
    /** Progress to the next level, 0..1000. */
    levelPermill: number;
    className: string;
    realm: string;
    regionId: number;
    zoneId: number;
    zoneName: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    speed: number;
    /** Percentages. */
    hp: number;
    mana: number;
    endurance: number;
    concentration: number;
    maxConcentration: number;
    isDead: boolean;
    isSitting: boolean;
    inCombat: boolean;
    attacking: boolean;
    targetObjectId: number | null;
    /** Carried weight as % of capacity, null when unknown. */
    load: number | null;
    deathCount: number;
    constitutionLost: number;
}

/** What the current run's board says about a member (its latest MemberReport). */
export interface RunMemberView {
    name: string;
    role: Role;
    activity: Activity;
    effects: string[];
    can: { heal: boolean; cc: boolean; nuke: boolean };
    /** Cumulative realm points (MemberReport.realmPoints), when the runner reports them. */
    realmPoints?: number;
    /** Runner clock. */
    at: number;
}

export interface GroupMemberView {
    bot: string;
    username: string;
    /** bot.env CHAR_NAME, else null (player.name is the live one). */
    charName: string | null;
    /** group.json role, else the run's, else roleForClass of the player's class; null when nothing is known. */
    role: Role | null;
    leader: boolean;
    client: {
        status: ClientStatus;
        /** Ms since the gateway received its last state; null when none. */
        stateAge: number | null;
        /** Its client's connection phase ('playing', 'disconnected', ...). */
        phase: string | null;
        lastError: string | null;
        controllers: number;
        observers: number;
    };
    /** The last known player, also after the client left (then client.status is 'dead'); null when not in game. */
    player: MemberPlayer | null;
    /** Where it walks (movement.destination and at most 50 waypoints); null without a usable state. */
    movement: { moving: boolean; destination: Vec3 | null; waypoints: Vec3[] } | null;
    /** Names in its own in-game group list (state.group). */
    inGameGroup: string[];
    /** From the current run while it is starting, live, stale or ending; else null. */
    run: RunMemberView | null;
}

/** An NPC or player some member sees, merged over the members by region and object id. */
export interface WorldContact {
    /** `${regionId}:${objectId}` */
    key: string;
    objectId: number;
    regionId: number;
    kind: 'npc' | 'player';
    name: string;
    level: number;
    realm: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    speed: number;
    hp: number;
    inCombat: boolean;
    isDead: boolean;
    targetObjectId: number | null;
    /** Character name of the member it targets, else null. */
    target: string | null;
    npc: { isPeaceful: boolean; isTargetable: boolean; isPet: boolean; role: string | null } | null;
    /** A player of another realm. */
    enemy: boolean;
    /** Character names of the members whose last state shows it, freshest first. */
    seenBy: string[];
    /** 2D distance to the nearest member that sees anything. */
    nearest: number;
    /** The current run's contact for it, when the board has one. */
    board: {
        threat: boolean;
        stale: boolean;
        cc: Contact['cc'];
        engagedAt: number;
        hostileSince: number;
        seenBy: string[];
        /** Runner clock. */
        lastSeen: number;
        /** Players: casting or helping its own realm in the last few seconds, and ever seen doing so (Contact.caster, Contact.healer). */
        casting?: boolean;
        helped?: boolean;
        healer?: boolean;
        caster?: boolean;
    } | null;
}

/** Something the gateway noticed itself from the members' states, with or without a run. Gateway clock. */
export interface PassiveEvent {
    seq: number;
    at: number;
    /**
     * death: died (pos = the corpse; by = killer; track = its last ~60 s of positions)
     * level: reached a level; region: changed region; client: its client left or came back;
     * control: a controlling SDK attached, left or took over.
     */
    kind: 'death' | 'level' | 'region' | 'client' | 'control';
    bot: string;
    /** Character name when known, else the bot. */
    name: string;
    text: string;
    /** death: "<name> (L<level>)" of the killer, null when unknown. */
    by: string | null;
    pos: { regionId: number; x: number; y: number; z: number } | null;
    /** death only: positions in the ~60 s before, oldest first, gateway clock. */
    track: { x: number; y: number; at: number }[] | null;
    /** The run that was live when it happened, else null. */
    runId: string | null;
}

export interface ControlView extends ControlRequest {
    /** When an answer to the runner's publish carried it; null while pending. */
    deliveredAt: number | null;
    /** When the runner reported it applied (GroupPublish.applied). */
    appliedAt: number | null;
}

export interface RunView {
    runId: string;
    state: RunState;
    /** GroupPublish.error: why the run failed, null when it ended normally. */
    error: string | null;
    /** The group's current run: the newest one starting, live, stale or ending, else the newest. */
    current: boolean;
    /** Gateway clock: first and last publish. */
    firstAt: number;
    lastAt: number;
    /** Gateway clock minus runner clock (smallest over the last 10 publishes): add it to runner times. */
    skewMs: number;
    /** Only when the request's ?run= is not this runId. */
    meta?: RunMeta;
    strategy: string;
    orders: Orders;
    /** Runner clock of the picture. */
    pictureAt: number;
    timing: { windingDown: boolean; deadline: number; hardStop: number };
    coordinator: CoordinatorView | null;
    /** Only when the request's ?planRev= differs from planRev. */
    plan?: PlanView | null;
    planRev: number;
    /** Only when the request's ?reportRev= differs from reportRev. */
    report?: LiveReport | null;
    reportRev: number;
    /** Run events after the request's ?events= seq, oldest first, at most 500. */
    events: WireEvent[];
    /** Highest event seq stored. */
    eventSeq: number;
    /** Lowest event seq the gateway has (older ones were before a gateway restart or trimmed). */
    eventsFrom: number;
    /** Events missing in the stored sequence (those the runner dropped before an ack show up as such gaps). */
    lostEvents: number;
    /** More events than one answer carries are waiting: ask again at once. */
    moreEvents: boolean;
    control: ControlView[];
    result: RunResultView | null;
}

/** GET /groups/<id>/live */
export interface GroupFrame {
    v: 1;
    id: string;
    name: string;
    leader: { bot: string; username: string };
    /** Gateway clock. */
    now: number;
    /** When the gateway's group store started (gateway clock): a new value means the gateway restarted, so every cursor (events, passive) starts over. */
    boot: number;
    /** In group.json order. */
    members: GroupMemberView[];
    /** Nearest the members first, at most 400. */
    world: WorldContact[];
    /** The leader's in-game group (or the largest member list when the leader has none) against the roster, by character name. */
    grouping: { inLeaderGroup: string[]; missing: string[]; strangers: string[] };
    run: RunView | null;
    /** The group's other runs still kept. */
    others: { runId: string; state: RunState; firstAt: number; strategy: string }[];
    /** Passive events after the request's ?passive= seq (at most 300), and the highest seq. */
    passive: { events: PassiveEvent[]; seq: number };
    /** Things the page should say, e.g. "galahad: no bots/galahad/bot.env, using the folder name". */
    notes: string[];
}

/** One line of runs/history.jsonl, newest first, with the runs/<stamp> it belongs to. */
export interface HistoryEntry {
    stamp: string;
    startedAt: string;
    strategy: string;
    seconds: number;
    kills: number;
    deaths: number;
    wipes: number;
    retreats: number;
    fights: number;
    killsPerHour: number;
    xpPerHour: number;
    avgFightMs: number;
    downtime: number;
    tankHold: number | null;
    /** RvR runs only (RunReport.totals). */
    playerKills?: number;
    deathsToPlayers?: number;
    realmPoints?: number;
    rpPerHour?: number;
    enemiesSeen?: number;
    engagements?: number;
    /** Finding topics, with repeats. */
    findings: string[];
}

/** GET /groups/<id>/runs */
export interface GroupRuns {
    history: HistoryEntry[];
    /** The newest 50 runs/<stamp>.* sets. */
    files: { stamp: string; json: boolean; md: boolean; log: boolean; size: number }[];
    /** runs/campaign.log, when there is one. */
    campaign: { log: string[]; stopPending: boolean; updatedAt: number | null } | null;
}

/** POST /groups/<id>/control answer. */
export type ControlAnswer = { ok: true; request: ControlView } | { ok: false; error: string; auth?: { bot: string; username: string } };
