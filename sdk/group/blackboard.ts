// Shared awareness: every member publishes what its own client sees, and the
// blackboard merges that into one picture of the group and its enemies.
//
// Knowledge is partial and ages. A contact keeps the freshest sighting any member
// had; it turns `stale` when nobody has seen it for a while, and it is dropped
// when a member standing near its last position no longer sees it (it died,
// despawned or walked off) or after forgetAfterMs.
//
// The server never sends an enemy player's target: only the player's own client
// gets it (WeaponAction.cs SendChangeTarget; assist.cs refuses other realms).
// Every client in view does get the fights around it: 0xBC CombatAnimation
// (attacker, defender; WeaponAction.cs), 0x72 SpellCastAnimation (caster) and
// 0x1B SpellEffectAnimation (caster, target; SpellHandler.cs). A player's target,
// casts and heals are read from those combat events. Those reach everyone within
// 6000 of the fight, so a swinging player is a threat to the group only when it is
// on a member, fights us, or swings or casts within hostileRadius of a member:
// in a three-realm battleground the other two fighting each other are not.
//
// A monster's target comes from the server, but only while it is in attack state and
// within its attack range (PacketLib168.cs): one starting a timed cast leaves attack
// state, so a caster nuking a member from range reports none. Its hostile spell effects
// stand in for that target. Spell effects only: a swing would keep a mob's old target
// after a reset, and the server keeps naming the target of a mob that swings.
//
// Nothing dies by 0 % health alone: the server rounds health down (GameLiving.cs:2621),
// so a living player or monster with a few hit points reads 0. A player dies by its
// death event or isDead, a monster by its death event (0xA2).
//
// Pets stay out of `members`. A member's report carries its pet, and the board reads
// that as ours: what fights a member's pet fights us. Pets of ours and of our realm are
// no contacts. An enemy realm's are, marked isPet: the server names no owner, so one
// on a caster registers as a threat by itself.
//
// A Necromancer in shade can't be attacked, and no pet can be ordered at it
// (AbstractServerRules.cs:449-455). It stays a contact, marked, and is never a threat: untouchable.
//
// A blow a pet takes for its owner names the pet on every client, with the mob still on the owner
// (AttackComponent.cs:1492-1498, WeaponAction.cs:366-367, PacketLib168.cs:820-828), and only the owner gets the line
// that says so. Its report names the mob (Observation.intercepts), and the board reads such a sighting as on the owner.

import type { BotWorldState, CombatEvent, PetLoss, PlayerState, Realm } from '../types';
import { isKillable, PLAYER_AIM_MS } from '../actions-helpers';
import { isAttackable } from '../index';
import { mobRunInMs } from '../mob-speed';
import { canSee, NOTICE_MAX_MS, noticed, pruneNoticeClock, terrainGround, type GroundAt, type NoticeClock, type VisionOptions } from '../vision';
import { addLook, newEvidence, readClass, type FoeEvidence, type FoeLook } from './class-read';
import { CC_IMMUNE_MS, npcCcLanded, readCcEnds, serverNameKey, type CcEnd, type CcImmunity, type CcKind, type NpcCcRun } from './cc';
import { groupmatesOf, ObservedMembers, type Groupmate, type ObservedEntry } from './observed';
import { DOOR_BROKEN_RE, SIEGE_LAYOUTS } from './siege';
import type { Activity, Capabilities, MemberCombat, Contact, GroupEvent, GroupPicture, MemberReport, Orders, OrdersUpdate, PetReport, Point, Role, Sighting } from './types';

export interface BlackboardOptions {
    /** A contact nobody has seen for this long is marked stale (default 5000). */
    staleAfterMs?: number;
    /** ... and forgotten after this long (default 60000). */
    forgetAfterMs?: number;
    /** A member this close to a contact's last position should see it; if it doesn't, the contact is gone (default 2500). */
    viewRadius?: number;
    /** Events kept for late readers (default 5000). */
    maxEvents?: number;
    /** Ground heights for the sight lines of members with human vision (default: the client heightmaps, sdk/vision.ts). */
    ground?: GroundAt;
    /** A contact stays a threat this long after its last hostile sign (default 4000). */
    hostileMs?: number;
    /**
     * An enemy player swinging or casting at someone we can't name (another realm's player, or a cast
     * whose target is unknown until it lands) is hostile within this distance of a living member
     * (default 2500, the rvr strategy's engage radius); farther off it is someone else's fight.
     */
    hostileRadius?: number;
    /** Group members with no member agent, such as a human (observed.ts, GroupDefinition.observed). None: the picture holds the bots only. */
    observed?: readonly ObservedEntry[];
}

/** The part of a member's report its agent knows and the snapshot does not. */
export interface MemberSelf {
    bot: string;
    role: Role;
    activity: Activity;
    capabilities: Capabilities;
    combat?: MemberCombat;
    /** MemberReport.petRecast. */
    petRecast?: boolean;
    /** PetReport.orderedOn. */
    petOrderedOn?: number | null;
    /** Character names of the group's observed members (Blackboard.observedNames): what this client knows of them goes in Observation.groupmates. */
    observed?: readonly string[];
}

/** Who killed a member, as its client saw them (the board's 'death' event data). Enemy players go by race name. */
export interface Killer {
    name: string;
    kind: 'npc' | 'player';
    realm: Realm;
    /** An enemy realm's pet, not one of its keep guards: both are NPCs of that realm. */
    isPet?: boolean;
}

export interface Observation {
    report: MemberReport;
    sightings: Sighting[];
    /** Object ids the client saw die: server death events, players marked dead while their entry is fresh. */
    deaths: number[];
    /** Players among `deaths` whose killer (named by 0xAE PlayerDeath) is in view and of another realm than ours, a monster too. */
    foeKills?: number[];
    /**
     * Enemy players this member hit lately: a swing that landed (a miss, parry, block or evade does
     * no damage, so the server gives no share of the kill for it: GameLiving.TakeDamage → AddXPGainer),
     * or a hostile spell, which counts whatever it did: the effect animation doesn't tell a nuke from a mezz.
     */
    hits?: number[];
    /** Enemy pets this member or its pets landed something on in that window. A pet that goes with none of that is no kill of ours (Blackboard.kill). Absent with none. */
    petHits?: number[];
    /** While the member is dead: who killed it; null when it is alive or the killer is unknown. */
    killer?: Killer | null;
    /** How its last window pet went (state.lastPetLoss), for the note when the report's pet goes. */
    petLoss?: PetLoss | null;
    /** Its pets' swings and hostile spells in the swing window, and whether a swing landed: a pet's attack on a crowd-controlled mob breaks that. */
    petSwings?: { targetId: number; at: number; landed: boolean }[];
    /** Its own swings in the swing window that landed: a hit ends a root (GameLiving.cs:1689-1694). A spell's effect doesn't say whether it did damage, so a nuke goes by the mob moving. */
    ownSwings?: { targetId: number; at: number }[];
    /** Mobs whose blow at this member its window pet took lately (INTERCEPT_HOLDS_MS), and when. Absent with none. */
    intercepts?: { mobId: number; at: number }[];
    /** Crowd control the server told this member has ended, from the last CC_END_MS of messages. */
    ccEnds?: CcEnd[];
    /**
     * With human vision (sdk/vision.ts): the way the member faced and its sight rules, so the board can
     * tell a contact it should see from one behind it or behind a hill. Absent with omniscient sight.
     * `pending`: enemies in view it hasn't noticed yet, only with noticeMs past NOTICE_MAX_MS (a member in a fight,
     * vision.ts inFightVision), so the forget rule spares them.
     */
    sight?: { heading: number; vision: VisionOptions; pending?: number[] };
    /** What this client knows of the group's observed members (MemberSelf.observed): window, position, aim, our concentration buffs on them. Absent with none asked for. */
    groupmates?: Groupmate[];
}

const SWING_WINDOW_MS = 2000;
/** A death event counts this long: object ids are reused after a mob is removed, so an older one is an earlier holder's. */
const DEATH_EVENT_MS = 5000;
/** A message about crowd control ending is reported this long: the board goes by its time, so repeats change nothing. */
const CC_END_MS = 3000;
/** An enemy player's target: its latest swing or hostile spell this recent (longer than a slow weapon's swing). */
const PLAYER_TARGET_MS = PLAYER_AIM_MS;
/** A monster the server names no target for: its latest hostile spell effect this recent. */
const SPELL_TARGET_MS = PLAYER_AIM_MS;
/**
 * A dead player's model entry counts as a death only this fresh. A release moves the player within
 * the region without telling those who saw it die (GamePlayer.MoveTo), so its entry stays dead at the
 * corpse while we stand near: reported on every publish, it would delete the live contact another
 * member sees after it walked back. The death event itself is reported for 5 s.
 */
const DEAD_ENTRY_MS = 3000;
/** A cast counts this long at least (an instant spell's cast time is 0). */
const CASTING_MS = 3000;
/** It landed a spell on another player of its own realm (a heal or buff) this recent. */
const HELPED_MS = 5000;
/** How far back a snapshot's combat events go into an enemy player's look (FoeLook): well inside the client's last 200 events, and the board unions every snapshot. */
const LOOK_MS = 4000;
/** An enemy player's evidence untouched this long is dropped; a contact forgotten sooner keeps it, so it comes back with its read. */
const FOE_MEMORY_MS = 30 * 60_000;
/** The killer is looked for among combat events this recent. */
const KILLER_MS = 15_000;

/**
 * A sighting that names a pet reads so this long after a blow it took for its owner: the name holds until the mob's next 0xA1 or swing, and those come within about 5 s. Passive doesn't stop this (ControlledMobState.cs:148, AttackComponent.cs:1429-1436).
 * Should the mob really go to the pet meanwhile, this reads it on the owner for that long at most.
 */
const INTERCEPT_HOLDS_MS = 5000;
/** The line and the 0xBC of one blow come in one server tick. */
const INTERCEPT_PAIR_MS = 500;
/**
 * A reading of a mob on a pet isn't one to act on for this long. A groupmate's client gets the 0xBC of an intercepted blow a snapshot before the owner's report can say what it was, and a coordinator tick or a side tick can fall in that gap.
 * After it a reading has stood its ground or the board has corrected it.
 */
const PET_READING_MS = 500;

/** Whether it reads on a pet (of `owner`, if given), and has for long enough to act on (PET_READING_MS). */
export const readsOnPet = (c: Pick<Contact, 'targetPet' | 'targetSince'>, now: number, owner?: string): boolean =>
    !!c.targetPet && (owner === undefined || c.targetPet === owner) && now - c.targetSince >= PET_READING_MS;

/** Who took a blow for this client's player, from the server's line: "The spirit soldier steps in front of you and takes the blow!" (Ability.txt:117, AttackComponent.cs:1900). */
export const steppedInFront = (line: string): string | undefined => /^(?:the )?(.+) steps in front of you and takes the blow!$/i.exec(line)?.[1];

/** The server's answer to any attack or pet order on a shade (AbstractServerRules.cs:449-455). */
export const SHADE_REFUSED = "You can't attack a shadowed necromancer!";
/** ... which marks that contact for this long (Blackboard.markUnattackable). */
export const UNATTACKABLE_MS = 30_000;

/** Whether the client saw this object die lately: an NPC at 0 % without that is alive (see the top of this file). */
export function diedLately(state: Pick<BotWorldState, 'combatEvents' | 'timestamp'>, id: number): boolean {
    return state.combatEvents.some(e => e.kind === 'death' && e.targetObjectId === id && state.timestamp - e.receivedAt < DEATH_EVENT_MS);
}

/** Our window pet for the others; null without one, undefined from a client that doesn't report it. */
function petReport(state: BotWorldState): PetReport | null | undefined {
    const pet = state.pet;
    if (!pet) return pet;
    const n = state.nearbyNpcs.find(x => x.objectId === pet.objectId);
    return {
        objectId: pet.objectId, name: n?.name ?? pet.name ?? '', level: n?.level ?? null, x: n?.x ?? null, y: n?.y ?? null, z: n?.z ?? null, hp: n?.healthPercent ?? null,
        targetId: pet.targetObjectId, inCombat: n?.inCombat ?? false, aggression: pet.aggression, walk: pet.walk, icons: [...pet.icons],
    };
}

/** Which mob each such line of the window was about: the 0xBC on the pet beside it, as the line names none. The newest for a mob. */
function interceptsOf(state: BotWorldState): NonNullable<Observation['intercepts']> {
    const pet = state.pet;
    if (!pet) return [];
    const name = (state.nearbyNpcs.find(n => n.objectId === pet.objectId)?.name ?? pet.name ?? '').toLowerCase();
    const found = new Map<number, number>();
    for (const m of state.gameMessages) {
        if (state.timestamp - m.receivedAt >= INTERCEPT_HOLDS_MS || steppedInFront(m.text)?.toLowerCase() !== name) continue;
        const gap = (e: CombatEvent) => Math.abs(e.receivedAt - m.receivedAt);
        const blow = state.combatEvents.filter(e => e.kind === 'melee' && e.targetObjectId === pet.objectId && e.attackerObjectId !== null && gap(e) <= INTERCEPT_PAIR_MS).sort((a, b) => gap(a) - gap(b))[0];
        if (blow) found.set(blow.attackerObjectId!, Math.max(found.get(blow.attackerObjectId!) ?? 0, m.receivedAt));
    }
    return [...found].map(([mobId, at]) => ({ mobId, at }));
}

/** An enemy player's look in one snapshot: its visible gear and what its combat events showed. Nothing when there is nothing. */
interface Seen { effects: Set<number>; styles: Set<number>; weapons: Set<number>; cast: boolean; swung: boolean }
function lookFor(gear: { slot: number; model: number }[] | undefined, seen: Seen | undefined): { look?: FoeLook } {
    const look: FoeLook = {};
    if (seen?.cast) look.cast = true;
    if (seen?.swung) look.swung = true;
    if (gear?.length) look.gear = gear.map(i => [i.slot, i.model]);
    if (seen?.effects.size) look.effects = [...seen.effects];
    if (seen?.styles.size) look.styles = [...seen.styles];
    if (seen?.weapons.size) look.weapons = [...seen.weapons];
    return Object.keys(look).length ? { look } : {};
}

/**
 * Turn one member's snapshot into its report and sightings (pure). Sightings are
 * monsters it could fight, players of other realms and those realms' pets, within `sightRadius`.
 *
 * With `vision` (human sight, sdk/vision.ts) an enemy player or enemy pet is reported only when the
 * member would notice it: near, or in its view cone with the ground out of the way, or it is the
 * member's target, or it swung or cast at the member or its pets lately (the hit says where it is).
 * One it only sees is reported once it has been in view `vision.noticeMs`, by `noticeClock`, which the caller keeps
 * between snapshots (none: at once). Monsters are reported as before.
 */
export function observeState(state: BotWorldState, self: MemberSelf, sightRadius = 3000, vision: VisionOptions | null = null, ground: GroundAt = terrainGround, noticeClock?: NoticeClock): Observation | null {
    const p = state.player;
    if (!state.inGame || !p) return null;
    const now = state.timestamp;
    // Ours whatever their entries say yet: a window pet and those with none.
    const ownPets = new Set<number>(state.summons ?? []);
    if (state.pet) ownPets.add(state.pet.objectId);
    // A spell effect is hostile when caster and target are of different realms (monsters are 'none').
    const realmOf = new Map<number, Realm>([[p.objectId, p.realm]]);
    for (const n of state.nearbyNpcs) realmOf.set(n.objectId, n.realm);
    for (const o of state.nearbyPlayers) realmOf.set(o.objectId, o.realm);
    const isPlayer = new Set(state.nearbyPlayers.map(o => o.objectId));
    const isPet = new Set(state.nearbyNpcs.filter(n => n.isPet).map(n => n.objectId));
    const lastSwing = new Set<number>();
    // Hostile spell effects and cast starts in the swing window: a player's swing (see its sighting).
    const lastSpell = new Set<number>();
    const aim = new Map<number, { targetId: number; at: number }>();
    const spellAim = new Map<number, { targetId: number; at: number }>();
    const casting = new Set<number>();
    const helped = new Set<number>();
    const looks = new Map<number, Seen>();
    const lookOf = (id: number) => looks.get(id) ?? looks.set(id, { effects: new Set(), styles: new Set(), weapons: new Set(), cast: false, swung: false }).get(id)!;
    const deaths: number[] = [];
    const foeKills: number[] = [];
    const hits = new Set<number>();
    const petHits = new Set<number>();
    const petSwings: NonNullable<Observation['petSwings']> = [];
    const ownSwings: NonNullable<Observation['ownSwings']> = [];
    for (const e of state.combatEvents) {
        const by = e.attackerObjectId, on = e.targetObjectId, age = now - e.receivedAt;
        // Object ids are reused after a mob is removed: only fresh deaths count.
        if (e.kind === 'death' && on !== null && age < DEATH_EVENT_MS) {
            deaths.push(on);
            // A player's death event names its killer (PacketLib168.cs SendPlayerDied), a mob's none.
            const killer = by !== null ? realmOf.get(by) : undefined;
            if (killer !== undefined && killer !== p.realm) foeKills.push(on);
        }
        if (by === null) continue;
        const effect = e.kind === 'spellEffect' && on !== null && realmOf.has(by) && realmOf.has(on);
        const hostile = e.kind === 'melee' || (effect && realmOf.get(by) !== realmOf.get(on!));
        if (e.kind === 'melee' && age < SWING_WINDOW_MS) lastSwing.add(by);
        if (hostile && e.kind === 'spellEffect' && age < SWING_WINDOW_MS) lastSpell.add(by);
        if (hostile && on !== null && age < PLAYER_TARGET_MS && e.receivedAt >= (aim.get(by)?.at ?? -Infinity)) aim.set(by, { targetId: on, at: e.receivedAt });
        if (hostile && e.kind === 'spellEffect' && age < SPELL_TARGET_MS && e.receivedAt >= (spellAim.get(by)?.at ?? -Infinity)) spellAim.set(by, { targetId: on!, at: e.receivedAt });
        // Any swing shows its aim, only one that landed did damage.
        const landed = e.kind !== 'melee' || e.result === undefined || e.result === 'hit' || e.result === 'styledHit';
        // A pet's damage credits its owner (GameLiving.cs:1299-1300).
        if (hostile && landed && (by === p.objectId || ownPets.has(by)) && isPlayer.has(on!) && age < PLAYER_TARGET_MS) hits.add(on!);
        if (hostile && landed && (by === p.objectId || ownPets.has(by)) && isPet.has(on!) && age < PLAYER_TARGET_MS) petHits.add(on!);
        if (hostile && on !== null && ownPets.has(by) && age < SWING_WINDOW_MS) petSwings.push({ targetId: on, at: e.receivedAt, landed });
        if (e.kind === 'melee' && landed && by === p.objectId && on !== null && age < SWING_WINDOW_MS) ownSwings.push({ targetId: on, at: e.receivedAt });
        if (effect && !hostile && on !== by && isPlayer.has(on!) && age < HELPED_MS) helped.add(by);
        // What a player shows of its class: the spells it casts, the styles it swings, the weapons it swings them with.
        if (isPlayer.has(by) && age < LOOK_MS) {
            if ((e.kind === 'spellCast' || e.kind === 'spellEffect') && e.effectId) lookOf(by).effects.add(e.effectId);
            if (e.kind === 'melee' && e.style) lookOf(by).styles.add(e.style);
            if (e.kind === 'melee' && e.weaponModel) lookOf(by).weapons.add(e.weaponModel);
            if (e.kind === 'spellCast') lookOf(by).cast = true;
            // A swing, not a spell's damage (SPELL_DAMAGE_RESULT reads 'other') nor a bow being drawn: a fighter that never casts shows it so.
            if (e.kind === 'melee' && age < SWING_WINDOW_MS && e.result !== undefined && e.result !== 'other') lookOf(by).swung = true;
        }
        if (e.kind === 'spellCast') {
            if (age < Math.max(e.castTimeMs ?? 0, CASTING_MS)) casting.add(by);
            if (age < SWING_WINDOW_MS) lastSpell.add(by);
        }
    }
    const viewer = { regionId: p.regionId, x: p.x, y: p.y, z: p.z, heading: p.heading };
    const pending: number[] = [];
    const notices = (id: number, at: { x: number; y: number; z: number }) => {
        if (!vision || id === p.targetObjectId) return true;
        const on = aim.get(id)?.targetId;
        if (on !== undefined && (on === p.objectId || ownPets.has(on))) return true;
        if (!canSee(viewer, at, vision, ground)) return false;
        if (noticed(noticeClock, id, now, vision.noticeMs)) return true;
        pending.push(id);
        return false;
    };
    if (noticeClock) pruneNoticeClock(noticeClock, now);
    const sightings: Sighting[] = [];
    for (const n of state.nearbyNpcs) {
        const spell = spellAim.get(n.objectId);
        const aimed = aim.get(n.objectId)?.targetId;
        const spellLanded = spell !== undefined && now - spell.at < SWING_WINDOW_MS;
        if (n.distance2d > sightRadius) continue;
        // Under 1 % reads 0 alive, for seconds (4 of 52 live kills, 2.3-5.5 s), and it can regenerate. So 0 % is dead only with its
        // death event, already in `deaths`. Without one it is floored at 1: every reader of hp > 0 then means alive.
        if (n.healthPercent <= 0 && deaths.includes(n.objectId)) continue;
        if (ownPets.has(n.objectId)) continue;
        // An enemy realm's pet can be fought (isAttackable); a monster's stays out, like a town NPC.
        const enemyPet = n.isPet && isAttackable(n, p);
        // A keep's guard or lord of another realm: on the board, and in its picture only while the orders carry a raid (Contact.keepGuard).
        const keepGuard = !n.isPet && n.realm !== 'none' && n.realm !== p.realm && n.level > 1 && n.name.length > 0 && isAttackable(n, p);
        if (!enemyPet && !keepGuard && !isKillable(n, p)) continue;
        if (enemyPet && !notices(n.objectId, n)) continue;
        // A caster pet's entry names its target only on its victim's client, for moments (live): as for a player, the fight says it, and that reaches every client.
        // Not a monster's: its entry is the word, as a 0 says it let go (a reset, a leash), and a pet killer's run-in reads that (PET_KILLER_RUN_IN_MS).
        // On its victim's client a caster stays named through the server's 0 (NearbyNpc.targetBySpell): to the group that's the spell the other clients read, by the board's rules for one (a mezz, a dead member).
        const heldBySpell = !enemyPet && !!n.targetBySpell && n.targetObjectId !== null;
        const targetId = heldBySpell ? null : n.targetObjectId ?? (enemyPet ? aim.get(n.objectId)?.targetId ?? null : null);
        sightings.push({
            objectId: n.objectId, kind: 'npc', name: n.name, level: n.level, realm: n.realm,
            x: n.x, y: n.y, z: n.z, hp: Math.max(1, n.healthPercent), targetId, inCombat: heldBySpell ? false : n.inCombat, speed: n.speed,
            ...(n.speed > 0 ? { fixedAt: now - n.lastSeenAgo } : {}),
            spellTargetId: spell?.targetId ?? (heldBySpell ? n.targetObjectId : null),
            // A spell that landed counts, not a cast start, which may be a self-buff. Like a swing it ends a mezz:
            // a mezz stops the cast under way and any new one (CrowdControlECSEffect.cs OnHardCCStart,
            // CastingComponent.cs CanCastSpell), a bolt shows at launch, and DoT ticks show nothing (DoTSpellHandler.cs).
            swinging: lastSwing.has(n.objectId) || spellLanded,
            spellLanded,
            aimedAtPlayer: aimed !== undefined && isPlayer.has(aimed) ? aimed : null,
            ...(aimed !== undefined && isPet.has(aimed) && !ownPets.has(aimed) ? { aimedAtPet: aimed } : {}),
            ...(enemyPet ? { isPet: true } : {}),
            ...(keepGuard ? { keepGuard: true } : {}),
        });
    }
    for (const o of state.nearbyPlayers) {
        if (o.distance2d > sightRadius || o.realm === p.realm || o.realm === 'none') continue;
        // Dead by isDead only; at 0 % it may be alive. A stale corpse is no news (DEAD_ENTRY_MS).
        if (o.isDead) {
            if (o.lastSeenAgo < DEAD_ENTRY_MS) deaths.push(o.objectId);
            continue;
        }
        if (!notices(o.objectId, o)) continue;
        sightings.push({
            objectId: o.objectId, kind: 'player', name: o.name, level: o.level, realm: o.realm,
            x: o.x, y: o.y, z: o.z, hp: o.healthPercent, targetId: aim.get(o.objectId)?.targetId ?? null, inCombat: o.inCombat,
            // A cast's target is unknown until its effect lands, so any cast start counts. A mezzed or
            // stunned player can neither swing nor cast: the board's mezz-break check stays right.
            swinging: lastSwing.has(o.objectId) || lastSpell.has(o.objectId),
            casting: casting.has(o.objectId), helped: helped.has(o.objectId),
            ...(o.isShade ? { isShade: true } : {}),
            ...lookFor(o.gear?.items, looks.get(o.objectId)),
        });
    }
    const report: MemberReport = {
        name: p.name, bot: self.bot, role: self.role, className: p.className, level: p.level, experience: p.experience,
        realmPoints: p.realmPoints, objectId: p.objectId, regionId: p.regionId, x: p.x, y: p.y, z: p.z,
        hp: p.healthPercent, maxHp: p.maxHealth, mana: p.manaPercent, endurance: p.endurancePercent,
        load: p.encumbrance && p.encumbrance.max > 0 ? Math.round(100 * p.encumbrance.current / p.encumbrance.max) : 0,
        isDead: p.isDead, isSitting: p.isSitting, inCombat: p.inCombat, attacking: p.attacking, targetId: p.targetObjectId,
        effects: state.effects.map(e => e.name), capabilities: self.capabilities, activity: self.activity, combat: self.combat,
        at: state.timestamp, pet: petReport(state),
    };
    if (state.summons?.length) report.summons = [...state.summons];
    if (self.petRecast) report.petRecast = true;
    const doors = doorsBrokenNear(state.gameMessages ?? [], state.nearbyObjects ?? [], p, state.timestamp);
    if (doors.length) report.doorsBroken = doors;
    if (report.pet && self.petOrderedOn != null) report.pet.orderedOn = self.petOrderedOn;
    const intercepts = interceptsOf(state);
    const ccEnds = readCcEnds(state.gameMessages ?? [], state.timestamp - CC_END_MS);
    const groupmates = self.observed?.length ? groupmatesOf(state, self.observed, aim, (self.capabilities.buffSpells ?? []).map(b => b.name)) : null;
    return { ...(groupmates ? { groupmates } : {}), report, sightings, deaths, foeKills, hits: [...hits], killer: p.isDead ? killerOf(state, p) : null, petLoss: state.lastPetLoss, petSwings, ownSwings, ...(petHits.size ? { petHits: [...petHits] } : {}), ...(intercepts.length ? { intercepts } : {}), ...(ccEnds.length ? { ccEnds } : {}), ...(vision ? { sight: { heading: p.heading, vision, ...(pending.length && vision.noticeMs > NOTICE_MAX_MS ? { pending } : {}) } } : {}) };
}

/** A broken-door line this old still counts (the coordinator keeps what it learns for the raid). */
export const DOOR_BROKEN_MS = 60_000;
/** The line reaches players within 512 of the door (GameKeepDoor.Die, WorldMgr.INFO_DISTANCE); a little more for one that moved since. */
const DOOR_BROKEN_NEAR = 900;

/**
 * The doors a member read "The Keep Door is broken!" for in the last DOOR_BROKEN_MS: the line names no door, so it is the door
 * nearest the member, a door object in view (NearbyObject.doorId) or else a door of a siege layout (siege.ts) in its region.
 */
export function doorsBrokenNear(messages: readonly { text: string; receivedAt: number }[], objects: readonly { doorId: number | null; x: number; y: number }[], at: { x: number; y: number; regionId: number }, now: number): number[] {
    if (!messages.some(m => now - m.receivedAt <= DOOR_BROKEN_MS && DOOR_BROKEN_RE.test(m.text.trim()))) return [];
    const doors = [
        ...objects.filter(o => o.doorId != null).map(o => ({ id: o.doorId!, x: o.x, y: o.y })),
        ...Object.values(SIEGE_LAYOUTS).filter(l => l.regionId === at.regionId).flatMap(l => l.targets.filter(t => t.doorId !== undefined).map(t => ({ id: t.doorId!, x: t.at.x, y: t.at.y }))),
    ];
    const near = doors.map(d => ({ id: d.id, d: Math.hypot(d.x - at.x, d.y - at.y) })).filter(d => d.d <= DOOR_BROKEN_NEAR).sort((a, b) => a.d - b.d)[0];
    return near ? [near.id] : [];
}

const isBlow = (e: CombatEvent) => e.kind === 'melee' || e.kind === 'spellEffect';

/**
 * Who killed `p`: the death event's killer (0xAE PlayerDeath names it; GamePlayer.cs),
 * else the newest foe that hit it, while still in view; null otherwise. A friend's heal
 * or buff is a spell effect on it too, so a hitter counts only when of another realm.
 *
 * For a pet's kill the server names the owner (GameLiving.cs:1299-1300, into Die at :1370; SendPlayerDied, GamePlayer.cs:5905), a turret's with its owner 5900 away too. So the killer is the pet
 * when the newest blow before the death is that of a pet of the named player's realm, and the named player has no blow of its own in the window (live: `necroservant#432 -> Pethun#429 hit`, `death Briton#427 -> Pethun#429`).
 */
function killerOf(state: BotWorldState, p: PlayerState): Killer | null {
    const who = (id: number): Killer | null => {
        const n = state.nearbyNpcs.find(x => x.objectId === id);
        if (n) return { name: n.name, kind: 'npc', realm: n.realm, ...(n.isPet ? { isPet: true } : {}) };
        const o = state.nearbyPlayers.find(x => x.objectId === id);
        return o ? { name: o.name, kind: 'player', realm: o.realm } : null;
    };
    // Newest first.
    const hits = state.combatEvents.filter(e => e.targetObjectId === p.objectId && e.attackerObjectId !== null && e.attackerObjectId !== p.objectId
        && e.receivedAt > state.timestamp - KILLER_MS).reverse();
    const death = hits.find(e => e.kind === 'death');
    const killer = death ? who(death.attackerObjectId!) : null;
    if (killer) {
        const blows = hits.slice(hits.indexOf(death!) + 1).filter(isBlow);
        const last = blows.map(e => who(e.attackerObjectId!)).find(k => k && k.realm !== p.realm);
        const petsKill = killer.kind === 'player' && last?.isPet && last.realm === killer.realm && !blows.some(e => e.attackerObjectId === death!.attackerObjectId);
        return petsKill ? last! : killer;
    }
    for (const e of hits) {
        if (!isBlow(e)) continue;
        const k = who(e.attackerObjectId!);
        if (k && k.realm !== p.realm) return k;
    }
    return null;
}

/**
 * Still alive as far as the board knows. Both leave the board on their death event (a player on its dead
 * flag too), since the server rounds health down and a living one can read 0 % (GameLiving.cs:2621). A
 * monster's sighting is floored at 1 for that (observeState), so one reading 0 here never was a live sighting.
 */
export const isAlive = (c: Pick<Contact, 'kind' | 'hp'>) => c.kind === 'player' || c.hp > 0;

/** Nothing we do can reach it now: a shade, or marked by a refusal (markUnattackable). No focus, no crowd control, no enemy to count; its servant is what's left to fight. */
export const untouchable = (c: Pick<Contact, 'isShade' | 'unattackableUntil'>, now: number) => !!c.isShade || (c.unattackableUntil ?? 0) > now;

/** A shade's servant stays within this of it: the server cuts the bond past 1500 for 10 s and at 2000 at once, in 3D (NecromancerPetBrain.cs CheckTether), so 2D is within it too. */
export const SERVANT_LEASH = 2000;
/** What the Necromancer's servants are called (Call ... Zombie Servant, Necroservant, Abomination): a pet so named goes before any other pet of the shade's realm near it. */
const SERVANT_NAME = /servant|zombie|abomination/i;

/**
 * Each enemy shade's servant, by the pet's object id. The server names no pet's owner (PacketLib1124.cs:186-187), so it is
 * read as a human reads it: a living enemy pet of the shade's realm, in its region, within SERVANT_LEASH of it, one per shade
 * and one shade per pet, a servant's name first, then the nearest. A Necromancer in shade is its servant: nothing else of it
 * can be fought, and the servant's death ends the shade at 10 % health (ClassDisciple.cs:60-83, ShadeECSEffect.cs:149).
 */
export function servantsOf(contacts: readonly Contact[]): Map<number, Contact> {
    const out = new Map<number, Contact>();
    const shades = contacts.filter(c => c.kind === 'player' && c.isShade);
    if (!shades.length) return out;
    const pets = contacts.filter(c => c.kind === 'npc' && c.isPet && c.hp > 0);
    const pairs: { shade: Contact; pet: Contact; d: number; named: number }[] = [];
    for (const shade of shades) for (const pet of pets) {
        if (pet.realm !== shade.realm || pet.regionId !== shade.regionId) continue;
        const d = Math.hypot(pet.x - shade.x, pet.y - shade.y);
        if (d <= SERVANT_LEASH) pairs.push({ shade, pet, d, named: SERVANT_NAME.test(pet.name) ? 1 : 0 });
    }
    pairs.sort((a, b) => b.named - a.named || a.d - b.d);
    const served = new Set<number>();
    for (const { shade, pet } of pairs) {
        if (out.has(pet.objectId) || served.has(shade.objectId)) continue;
        out.set(pet.objectId, shade);
        served.add(shade.objectId);
    }
    return out;
}

/**
 * The contacts with each shade's servant (servantsOf) read as that enemy player, for a strategy that counts, sizes up and
 * focuses players: kind 'player', no pet flag, the shade's classGuess, caster and healer, and servantOf. The shade itself
 * stays as it is (untouchable drops it), so the Necromancer counts once, as its servant. The member that gets the servant as
 * focus finds the pet on the board and fights it as one (behaviors.ts attack). Contacts with no shade come back unchanged.
 */
export function shadeBodies(contacts: readonly Contact[]): Contact[] {
    const of = servantsOf(contacts);
    if (!of.size) return contacts as Contact[];
    return contacts.map(c => {
        const shade = of.get(c.objectId);
        if (!shade) return c;
        const { isPet: _pet, ...rest } = c;
        return {
            ...rest, kind: 'player' as const, servantOf: shade.objectId,
            ...(shade.classGuess ? { classGuess: shade.classGuess } : {}), ...(shade.caster ? { caster: true } : {}), ...(shade.healer ? { healer: true } : {}),
        };
    });
}

export function emptyOrders(now = Date.now()): Orders {
    return { seq: 0, phase: 'idle', objective: '', anchor: null, facing: null, focus: null, puller: null, cc: [], retreatTo: null, waiting: [], reason: 'start', issuedAt: now };
}

const moved = (a: { x: number; y: number } | null, b: { x: number; y: number } | null, by: number) =>
    !a !== !b || (!!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) > by);
const ccKey = (o: Orders) => o.cc.map(c => `${c.targetId}:${c.by}`).sort().join(',');
const splitKey = (o: Orders) => (o.meleeSplit ? Object.entries(o.meleeSplit).map(([n, id]) => `${n}:${id}`).sort().join(',') : '')
    + (o.memberOwn ? `|${Object.entries(o.memberOwn).map(([n, t]) => `${n}:${t.focus}@${Math.round(t.anchor.x)},${Math.round(t.anchor.y)}`).sort().join(',')}` : '');

/** Orders changed in a way that should interrupt what members are doing. */
export function isMaterialChange(a: Orders, b: Orders): boolean {
    return a.phase !== b.phase || a.focus !== b.focus || a.meleeFocus !== b.meleeFocus || splitKey(a) !== splitKey(b) || a.puller !== b.puller || ccKey(a) !== ccKey(b)
        || moved(a.retreatTo, b.retreatTo, 300) || moved(a.anchor, b.anchor, 300) || (a.column?.driver ?? null) !== (b.column?.driver ?? null);
}

/** Late sightings of a dead mob (a member's client lags) are ignored this long ... */
const KILLED_MS = 20_000;
/** ... a player's only this long: players keep their id, and one seen alive after this was rezzed. */
const PLAYER_KILLED_MS = 3000;
/** ... when they are this close to its corpse and carry its name. */
const CORPSE_RADIUS = 300;
/** A death stays in members' observations this long (observeState keeps death events 5 s), plus lag. */
const DEATH_ECHO_MS = 6000;
/**
 * A mob that kills a pet comes for its owner, and reads as on nobody until its next swing or 0xA1 (NearbyNpc.targetObjectId) in a group of two or more: the server
 * sends no target (65535) while a mob runs. It idles about 1 s, and a caster stands 900-1400 away and keeps stepping out: 9-10 s live (20261103-165547, 20261103-163415). It stays a threat
 * while its sighting reads that, in combat and moving with no target, so its run-in isn't read as the fight being over: for as long as it can take from where it reads now at its hurt speed (mobRunInMs: at 21 % that is 106 units/s,
 * and a flat 15 s let a summon start 4 s before Growler arrived, 20261104-052514), and no longer than this after the pet's loss, as the model's hand-over goes by.
 */
const PET_KILLER_RUN_IN_MS = 30_000;
/** A pet's swing this soon after crowd control was marked can be one from before it landed: the mark follows the cast's result. */
const CC_SETTLE_MS = 500;
/**
 * A running mob's position says where a root stopped it only from an update this much newer than the root: until the next 0xA1 a client reckons it on to where it was going (Sighting.fixedAt), and live that read 120 off with the root
 * holding for 8 s more ('05:28:05.098 feet are frozen', '05:28:08 root on moss sheerie broke', the server's own line at '05:28:13.264'). A snapshot, as the mark itself can be one late.
 */
const ROOT_UPDATE_AFTER_MS = 250;
/**
 * A rooted mob this far from where it stood once the mark settled is free: a root's end says nothing, as every root in spell.sql has an empty Message3 and Message4. `can move normally again` is a snare's
 * (DamageSpeedDecrease, StyleSpeedDecrease), and comes as a root replaces one (live: `can move normally again` and `feet are frozen` at 16:36:00.306, in that order), so that line doesn't end a root: it is before the mark, and ccEnded takes it for its predecessor's.
 * A rooted player creeps at 1 % speed, about 2 units/s, which stays well inside this.
 */
const ROOT_MOVED = 120;
/** An enemy pet gone this soon after a player of its realm died went with it, as a release is a death to the client (GamePlayer.cs:5988-5989, world-model.ts RemoveObject): same tick, a snapshot or two apart ... */
const WITH_OWNER_MS = 1000;
/** ... and with this much health left: one we killed reads near 0. */
const WITH_OWNER_HP = 10;
/**
 * An enemy pet gone with this much health left has gone for another reason than us, its death event being empty as every NPC's is (world-model.ts, 0xA2): a Necromancer's servant beyond its tether at 100 % (NecromancerPetBrain.cs:301), a release,
 * and live that read `necroservant (L21) died`, `won in 16 s, kills 2` for 1 player (20261104-043622). A pet at half that a big hit took down reads so as well: it is worth nothing either way (GameNPC.cs:2731-2732).
 */
const LOST_PET_HP = 50;
/** ... and one nobody of ours has landed anything on for this long, whatever its health. Observation.petHits holds a hit for PLAYER_TARGET_MS first. */
const PET_HIT_LATELY_MS = 2000;

/**
 * `engaged`: the group fought it, so its death is a kill event (not `engagedAt`, the engage order).
 * `hit`: a member hit it (an enemy player), so it is our kill even when another realm finishes it:
 * the server shares a player kill among all who damaged it (PlayerKillRewardProcessor.cs).
 * `deathEchoUntil`: it inherited the id of something dead; deaths reported for that id until then are the old one's.
 * `petKillerUntil`: it fought a pet of ours that went; until then its run-in counts (PET_KILLER_RUN_IN_MS), and `petKillerOf` says whose, and when.
 * `ccAt`: where it stood once a root's mark settled (ROOT_MOVED).
 * `petHitAt`: an enemy pet: when a member last reported a hit on it (Observation.petHits).
 */
type InternalContact = Contact & { engaged: boolean; hit: boolean; petHitAt: number; ccSince: number; ccAt: Point | null; ccRuns?: Partial<Record<CcKind, NpcCcRun>>; lastHostile: number; deathEchoUntil: number; petKillerUntil: number; petKillerOf: { owner: string; at: number } | null };

/** An observed member's death counts only after it read alive this long without a break (observedDeaths). */
export const OBSERVED_ALIVE_MS = 5000;

export class Blackboard {
    private readonly reports = new Map<string, MemberReport>();
    private readonly contacts = new Map<string, InternalContact>();
    /** Recently died, by key, with where and as what: ignore its own late sightings (ids are reused at once). */
    private readonly killed = new Map<string, { at: number; name: string; x: number; y: number; hp: number; player: boolean }>();
    /**
     * When a death was first reported for a key no contact holds: a pet's (the model reports its 0xA2 like a mob's), a town
     * NPC's, a mob nobody watched. The server gives that id to the next object it adds (Region.cs:955, :779).
     */
    private readonly unseenDeaths = new Map<string, number>();
    /** When an enemy player of this realm last died: a pet of that realm gone just after went with it (WITH_OWNER_MS). */
    private readonly playerDiedAt = new Map<Realm, number>();
    /** By a mob's key: whose pet took a blow of its lately, and until when a sighting naming that pet reads on its owner (INTERCEPT_HOLDS_MS). */
    private readonly intercepted = new Map<string, { owner: string; until: number }>();
    /** What we knew about crowd control on a contact gone from view: it outlasts forgetAfterMs, so it comes back with it. Not after a death. */
    private readonly ccMemory = new Map<string, Pick<InternalContact, 'ccImmune' | 'serverName' | 'ccRuns'>>();
    /** What every member has seen of each enemy player (class-read.ts), by key: it outlasts the contact, and a death too. A new race under the key starts over. */
    private readonly foes = new Map<string, FoeEvidence & { touched: number }>();
    private orders: Orders = emptyOrders();
    private readonly eventLog: GroupEvent[] = [];
    private readonly eventListeners = new Set<(e: GroupEvent) => void>();
    private readonly orderListeners = new Set<(next: Orders, prev: Orders) => void>();
    private readonly staleAfterMs: number;
    private readonly forgetAfterMs: number;
    private readonly viewRadius: number;
    private readonly ground: GroundAt;
    private readonly maxEvents: number;
    private readonly hostileMs: number;
    private readonly hostileRadius: number;
    /** Members with no agent (observed.ts): their reports come from the others' observations. */
    private readonly observed: ObservedMembers;
    /** Which of them read dead in the last picture of them, for their 'death' event. */
    private readonly observedDead = new Map<string, boolean>();
    /** Since when each observed member has read alive without a break: a death counts only after OBSERVED_ALIVE_MS of it. */
    private readonly observedAliveSince = new Map<string, number>();

    constructor(options: BlackboardOptions = {}) {
        this.staleAfterMs = options.staleAfterMs ?? 5000;
        this.forgetAfterMs = options.forgetAfterMs ?? 60_000;
        this.viewRadius = options.viewRadius ?? 2500;
        this.ground = options.ground ?? terrainGround;
        this.maxEvents = options.maxEvents ?? 5000;
        this.hostileMs = options.hostileMs ?? 4000;
        this.hostileRadius = options.hostileRadius ?? 2500;
        this.observed = new ObservedMembers(options.observed ?? []);
    }

    /** The observed members' character names (MemberSelf.observed); empty without any. */
    observedNames(): string[] {
        return this.observed.names();
    }

    /** An observed member asked to be picked up: read at `place` while nobody sees them, until `until` (ObservedMembers.pickup). */
    askPickup(name: string, place: { regionId: number; x: number; y: number; z: number }, now: number, until: number): boolean {
        return this.observed.pickup(name, place, now, until);
    }

    /** Observed members with a pickup still open. */
    pickupsOpen(now: number): string[] {
        return this.observed.pickupsOpen(now);
    }

    /** Every member's report: the bots', then the observed members' (observed.ts). Just the bots' without observed members. */
    private everyone(now: number): MemberReport[] {
        const bots = [...this.reports.values()];
        return this.observed.size ? [...bots, ...this.observed.reports(now)] : bots;
    }

    /** An observed member's death, from its window: a 'death' event like a bot's, its killer unknown. */
    private observedDeaths(now: number): void {
        for (const m of this.observed.reports(now)) {
            // Members' windows can disagree for a moment (one already reads the corpse, another not yet), so a dead human
            // flickered alive and dead: one death read 20 times in 6 s, and field.ts rotated the unit for "20 deaths"
            // (hibernia, 2026-11-13 16:26:45 UTC). A death counts only after it read alive OBSERVED_ALIVE_MS without a break.
            if (m.isDead) {
                const since = this.observedAliveSince.get(m.name);
                if (this.observedDead.get(m.name) === false && since !== undefined && now - since >= OBSERVED_ALIVE_MS) this.emit({ at: now, kind: 'death', member: m.name, text: `${m.name} died`, data: { killer: null } });
                this.observedAliveSince.delete(m.name);
            } else if (!this.observedAliveSince.has(m.name)) this.observedAliveSince.set(m.name, now);
            this.observedDead.set(m.name, m.isDead);
        }
    }

    /** Merge one member's observation. */
    publish(obs: Observation, now = Date.now()): void {
        const r = obs.report;
        const prev = this.reports.get(r.name);
        this.reports.set(r.name, r);
        if (prev && !prev.isDead && r.isDead) this.emit({ at: now, kind: 'death', member: r.name, text: `${r.name} died`, data: { killer: obs.killer ?? null } });
        if (prev && r.level > prev.level) this.emit({ at: now, kind: 'level', member: r.name, text: `${r.name} reached level ${r.level}` });
        if (prev?.pet && !r.pet && !r.isDead) this.petLost(r, prev.pet, obs.petLoss, now);
        if (obs.groupmates && this.observed.size) {
            this.observed.merge(r.name, obs.groupmates, r.at);
            this.observedDeaths(now);
        }
        // Observed members too: a mob on one is on the group, and what one fights is the group's fight.
        const all = this.everyone(now);

        const memberById = new Map<number, string>();
        for (const m of all) if (m.regionId === r.regionId) memberById.set(m.objectId, m.name);
        // Who owns a pet, here. A window pet comes last: a buff of ours on a groupmate's fresh pet can land it in our summons (BotWorldState.summons).
        const petOwner = new Map<number, string>();
        const windowPets = new Set<number>();
        for (const m of this.reports.values()) if (m.regionId === r.regionId) for (const id of m.summons ?? []) petOwner.set(id, m.name);
        for (const m of this.reports.values()) if (m.regionId === r.regionId && m.pet) { petOwner.set(m.pet.objectId, m.name); windowPets.add(m.pet.objectId); }
        const targetedByUs = new Set(all.map(m => m.targetId).filter((t): t is number => t !== null));
        // What members' pets fight (PetState.targetObjectId holds through a caster pet's 0 and a walking one's 65535).
        const petsOn = new Set([...this.reports.values()].filter(m => !m.isDead).map(m => m.pet?.targetId).filter((t): t is number => t !== null && t !== undefined));
        const attackedByUs = new Set([...all.filter(m => m.attacking && !m.isDead).map(m => m.targetId), ...petsOn]);
        const hitByUs = new Set(obs.hits);
        const living = all.filter(m => m.regionId === r.regionId && !m.isDead);
        const nearUs = (s: Sighting) => living.some(m => Math.hypot(m.x - s.x, m.y - s.y) < this.hostileRadius);
        const deadIds = new Set(all.filter(m => m.isDead).map(m => m.objectId));

        // Before the sightings: the mob's answer can come in the same tick (live), and would read as a mezz broken by nobody.
        for (const swing of obs.petSwings ?? []) this.petSwung(r, swing, now);
        for (const swing of obs.ownSwings ?? []) {
            const c = this.contacts.get(`${r.regionId}:${swing.targetId}`);
            if (c?.cc?.kind === 'root' && swing.at - c.ccSince > CC_SETTLE_MS) this.ccBroke(c, now);
        }

        // Before the sightings: a mob that came under such an id in this very snapshot is not what died.
        for (const id of obs.deaths) {
            const key = `${r.regionId}:${id}`;
            if (this.contacts.has(key)) continue;
            for (const [k, at] of this.unseenDeaths) if (now - at >= DEATH_ECHO_MS) this.unseenDeaths.delete(k);
            if (!this.unseenDeaths.has(key)) this.unseenDeaths.set(key, now);
        }

        for (const [k, v] of this.intercepted) if (v.until <= now) this.intercepted.delete(k);
        for (const i of obs.intercepts ?? []) this.intercepted.set(`${r.regionId}:${i.mobId}`, { owner: r.name, until: i.at + INTERCEPT_HOLDS_MS });

        const seen = new Set<string>();
        for (const sighted of obs.sightings) {
            const key = `${r.regionId}:${sighted.objectId}`;
            const named = this.pastThePet(sighted, key);
            // A groupmate's window pet, whatever this client's entry says: a mob a charm just took may stay a mob for the others. Not by summons:
            // one that ends out of view lingers there up to 30 s (BotWorldState.summons), and the server hands its id to the next object it adds.
            if (named.kind === 'npc' && windowPets.has(named.objectId)) { this.contacts.delete(key); continue; }
            // Its spell names the target the server doesn't, a member's or a member's pet's. Not while it is crowd-controlled: that spell is from
            // before, and it would hold a mezzed add as a threat for the whole aim window (behaviors.ts position()
            // counts on them dropping out). Not on a dead member either: nothing else would end it.
            // In combat with no target it is running (the 65535 below), so it isn't standing to cast.
            const spellTarget = named.spellTargetId ?? null;
            const bySpell = named.targetId === null && !named.inCombat && spellTarget !== null && !this.contacts.get(key)?.cc && !deadIds.has(spellTarget);
            const s = bySpell ? { ...named, targetId: spellTarget } : named;
            const dead = this.killed.get(key);
            const unseenDeath = this.unseenDeaths.get(key);
            let deathEchoUntil = unseenDeath !== undefined ? unseenDeath + DEATH_ECHO_MS : 0;
            if (dead) {
                // Only the dead mob's own late sightings are ignored. Anything else under its id
                // is a mob that inherited it (the server frees ids on death): a new contact at once.
                // A camp respawn can inherit the id at the same spot: it shows full health, the corpse never more than it died with.
                if (now - dead.at < (dead.player ? PLAYER_KILLED_MS : KILLED_MS) && s.name === dead.name && Math.hypot(s.x - dead.x, s.y - dead.y) < CORPSE_RADIUS && s.hp <= dead.hp + 5) continue;
                this.killed.delete(key);
                deathEchoUntil = Math.max(deathEchoUntil, dead.at + DEATH_ECHO_MS);
            }
            seen.add(key);
            const target = s.targetId !== null ? memberById.get(s.targetId) ?? null : null;
            const targetPet = s.targetId !== null ? petOwner.get(s.targetId) ?? null : null;
            let c = this.contacts.get(key);
            let cantSay = false;
            if (!c) {
                c = { ...s, targetBySpell: bySpell, regionId: r.regionId, target, targetPet, targetSince: now, engagedAt: 0, movedAt: 0, seenBy: [], firstSeen: now, lastSeen: r.at, stale: false, threat: false, hostileSince: 0, cc: null, engaged: false, hit: false, petHitAt: 0, ccSince: 0, ccAt: null, lastHostile: 0, deathEchoUntil, petKillerUntil: 0, petKillerOf: null };
                if (s.kind === 'player') Object.assign(c, { healer: false, caster: false });
                Object.assign(c, this.ccMemory.get(key));
                this.ccMemory.delete(key);
                this.contacts.set(key, c);
            } else if (r.at >= c.lastSeen) {
                // A mob in combat with no target: the server sends none (65535) while it runs or its
                // target is out of reach. Keep the last one, so target and targetSince don't blink.
                // A player's inCombat is only its attack mode (AttackState; PlayerPositionUpdateHandler.cs),
                // and observeState already keeps its target PLAYER_TARGET_MS after the last hit.
                const unknown = s.kind === 'npc' && s.targetId === null && s.inCombat;
                // A member whose client can't say what an enemy pet aims at (no 0xBC or 0x1B in yet; its entry reads none) doesn't end what another said, while that is fresh. It is no sign of its own below, so that ends hostileMs after the last real one.
                cantSay = !!s.isPet && s.targetId === null && !s.inCombat && c.targetId !== null && now - c.lastHostile < this.hostileMs;
                // The clock of how fast it goes down (fnfPet): its first loss since the engage order, from the health before that.
                if (s.hp >= 100) { delete c.lossSince; delete c.lossFromHp; }
                else if (c.engagedAt > 0 && c.lossSince === undefined && s.hp < c.hp) { c.lossSince = now; c.lossFromHp = c.hp; }
                if ((unknown || cantSay) && c.targetId !== null) {
                    Object.assign(c, s, { targetId: c.targetId, target: c.target, targetBySpell: false, lastSeen: r.at });
                    // Running before the engage order: a carried pull (its hold counts from engagedAt).
                    if (unknown && c.engagedAt === 0) c.movedAt = now;
                } else {
                    // A new target, or none after a reset or leash (no longer in combat).
                    if (c.targetId !== s.targetId) c.targetSince = now;
                    Object.assign(c, s, { target, targetPet, targetBySpell: bySpell, lastSeen: r.at });
                }
                // Object.assign leaves what a sighting doesn't say: a mob that inherited an enemy pet's id.
                if (!s.isPet) delete c.isPet;
                if (!s.keepGuard) delete c.keepGuard;
                if (!s.isShade) {
                    // The shade over: the servant went, the old model is back and attacks land at once (ClassDisciple.cs:60-83, ShadeECSEffect.cs:38), at 10 % or so (:149). So is a refusal's mark. One never read as a shade has only the mark to go by, and keeps it.
                    if (c.isShade) delete c.unattackableUntil;
                    delete c.isShade;
                }
            }
            if (!c.seenBy.includes(r.name)) c.seenBy.push(r.name);
            if (s.kind === 'player') this.readFoe(key, c, s, now);
            // Sticky, from any member's sighting, fresh or late: one heal on its own realm makes a healer.
            if (s.helped) c.healer = true;
            if (s.casting) { c.caster = true; c.castingAt = now; }
            // The contact's target, which is kept while it runs at a member; an older report's own as a fallback.
            const onMember = cantSay ? target : c.target ?? target;
            // The same for one on a member's pet, or one a pet fights that hasn't turned on it yet: a pet's fight can be silent to all of us but for that.
            const onPet = cantSay ? targetPet : c.targetPet ?? targetPet;
            if (onMember || onPet || targetedByUs.has(s.objectId) || petsOn.has(s.objectId)) c.engaged = true;
            // A player's or an enemy pet's swing or cast start on someone we can't name is hostile only near us: its
            // combat reaches every client within 6000, so far off it is two other realms' fight.
            // A monster's hit or spell on a player outside the group isn't our fight (pve.ts rejectPull: 'fighting someone else'), nor on a pet no member owns: a stranger's, an enemy's, or one that stepped in front of its owner (AttackComponent.cs:1492-1498). An enemy pet goes by the first rule, as its owner does.
            const onStranger = s.kind === 'npc' && !s.isPet && ((s.aimedAtPlayer != null && !memberById.has(s.aimedAtPlayer)) || (s.aimedAtPet != null && !petOwner.has(s.aimedAtPet)));
            const fighting = s.swinging && !onStranger && ((s.kind === 'npc' && !s.isPet) || nearUs(s));
            if (onMember || onPet || fighting || attackedByUs.has(s.objectId) || hitByUs.has(s.objectId)) {
                if (now - c.lastHostile > this.hostileMs) c.hostileSince = now;
                c.lastHostile = now;
            } else if (now < c.petKillerUntil && s.inCombat && (s.speed ?? 0) > 0 && s.targetId === null) {
                // As it comes, from where it reads now: its owner can have stepped out, and only that reading ends this. A 0 or a real id is another branch.
                const owner = c.petKillerOf && this.reports.get(c.petKillerOf.owner);
                if (owner && owner.regionId === c.regionId) c.petKillerUntil = Math.max(c.petKillerUntil, Math.min(c.petKillerOf!.at + PET_KILLER_RUN_IN_MS, now + mobRunInMs(Math.hypot(s.x - owner.x, s.y - owner.y), s.hp)));
                if (now - c.lastHostile > this.hostileMs) c.hostileSince = now;
                // Threat lasts hostileMs from lastHostile, so this ends with petKillerUntil at the latest.
                c.lastHostile = Math.max(c.lastHostile, Math.min(now, c.petKillerUntil - this.hostileMs));
            }
            // A mezzed or stunned mob neither swings nor casts: either after the cc landed means it broke. A rooted one can still do both, and its root ends on its expiry, on a landed hit (petSwung, ownSwings;
            // GameLiving.HandleCrowdControlOnAttacked), or with the mob moving. A monster's swing is at what stands in its reach (live: `The water beetle hits your hand for 25 damage!`, feet frozen), so it stays controlled.
            // A landed spell has no such reach, and a player can't be rooted again for the immunity (cc.ts), so those aren't controlled any more and the group must be free to kill them, but the root is still on them: no note.
            if (c.cc?.kind === 'root') {
                // Only a position that means it: this very sighting's (a late one wrote nothing), and one still reckoned on from before the root isn't (ROOT_UPDATE_AFTER_MS).
                const placed = c.lastSeen === r.at && (!s.speed || (s.fixedAt ?? r.at) - c.ccSince >= ROOT_UPDATE_AFTER_MS);
                if (placed && (!c.ccAt || now - c.ccSince <= CC_SETTLE_MS)) c.ccAt = { x: c.x, y: c.y };
                if (placed && Math.hypot(c.x - c.ccAt!.x, c.y - c.ccAt!.y) > ROOT_MOVED) this.ccBroke(c, now);
                else if (s.swinging && (s.kind === 'player' || s.spellLanded) && now - c.ccSince > SWING_WINDOW_MS) c.cc = null;
            } else if (c.cc && s.swinging && now - c.ccSince > SWING_WINDOW_MS) this.ccBroke(c, now);
        }
        for (const e of obs.ccEnds ?? []) this.ccEndedNamed(r.regionId, e);
        for (const id of obs.hits ?? []) {
            const c = this.contacts.get(`${r.regionId}:${id}`);
            if (c) c.hit = c.engaged = true;
        }
        for (const id of obs.petHits ?? []) {
            const c = this.contacts.get(`${r.regionId}:${id}`);
            if (c) { c.petHitAt = now; c.engaged = true; }
        }
        const foeKills = new Set(obs.foeKills);
        // Players first: a pet goes right after its owner, and is no kill then (kill).
        const isPlayer = (id: number) => this.contacts.get(`${r.regionId}:${id}`)?.kind === 'player';
        for (const id of [...obs.deaths.filter(isPlayer), ...obs.deaths.filter(id => !isPlayer(id))]) this.kill(`${r.regionId}:${id}`, r.name, now, foeKills.has(id));
        // Contacts this member should see but doesn't: gone (died out of our sight, despawned, left).
        // With human vision only where it looks and the ground lets it (observeState filters players and enemy pets so).
        const viewer = obs.sight && { regionId: r.regionId, x: r.x, y: r.y, z: r.z, heading: obs.sight.heading };
        // One it has in view and is still noticing (a member in a fight, Observation.sight.pending) is no proof of absence.
        const shouldSee = (c: Contact) => !viewer || (c.kind !== 'player' && !c.isPet) || (!obs.sight!.pending?.includes(c.objectId) && canSee(viewer, c, obs.sight!.vision, this.ground));
        for (const [key, c] of this.contacts) {
            if (seen.has(key) || c.regionId !== r.regionId) continue;
            const i = c.seenBy.indexOf(r.name);
            if (i >= 0) c.seenBy.splice(i, 1);
            if (!r.isDead && Math.hypot(c.x - r.x, c.y - r.y) < this.viewRadius && r.at - c.lastSeen > 1500 && shouldSee(c)) this.forget(key, c);
        }
    }

    /** A sighting of a mob whose blow a pet took for its owner, with what it names put right: the mob is on the owner (intercepted). */
    private pastThePet(s: Sighting, key: string): Sighting {
        const stepped = this.intercepted.get(key);
        const owner = stepped && this.reports.get(stepped.owner);
        return owner?.pet && s.targetId === owner.pet.objectId ? { ...s, targetId: owner.objectId } : s;
    }

    /** A member's window pet went: a note for the observer, and what was on it stays a threat for its run-in (PET_KILLER_RUN_IN_MS). */
    private petLost(r: MemberReport, pet: PetReport, loss: PetLoss | null | undefined, now: number): void {
        const cause = loss?.objectId === pet.objectId ? loss.cause : null;
        this.emit({ at: now, kind: 'note', member: r.name, text: `${r.name} lost ${pet.name || 'its pet'}${cause ? ` (${cause})` : ''}`, data: { pet: 'lost', name: pet.name, cause } });
        for (const c of this.contacts.values()) {
            // Its own target too: another member's snapshot may already have cleared the mob's.
            if (c.regionId !== r.regionId || (c.targetId !== pet.objectId && c.objectId !== pet.targetId)) continue;
            if (now - c.lastHostile > this.hostileMs) c.hostileSince = now;
            // hostileMs covers the moment it stands before it runs; publish keeps it from there.
            c.lastHostile = now;
            c.petKillerUntil = now + Math.min(PET_KILLER_RUN_IN_MS, mobRunInMs(Math.hypot(c.x - r.x, c.y - r.y), c.hp));
            c.petKillerOf = { owner: r.name, at: now };
        }
    }

    /**
     * A member's pet attacked a mob. Any swing breaks a mezz, a miss too, and any spell but a mezz on an NPC does; a root takes a hit (GameLiving.cs:1689-1704, :1729-1730).
     * A note for the observer, and the mob comes off cc for the group: a broken mezz sends no line of its own (live).
     * Crowd control on a focus with nothing else free is broken on purpose (ccHolds: a root has done its job, a mezz is picked off), and petControl sends a pet in for it: that note counts for nothing.
     */
    private petSwung(r: MemberReport, swing: NonNullable<Observation['petSwings']>[number], now: number): void {
        const c = this.contacts.get(`${r.regionId}:${swing.targetId}`);
        if (!c?.cc || swing.at - c.ccSince <= CC_SETTLE_MS || !(swing.landed || c.cc.kind === 'mezz')) return;
        if (c.objectId === this.orders.focus && !this.anotherFree(c, now)) this.emit({ at: now, kind: 'note', member: r.name, targetId: c.objectId, text: `${r.name}'s pet ended the ${c.cc.kind} on ${c.name}, with nothing else free`, data: { kind: c.cc.kind, by: c.cc.by } });
        else this.emit({ at: now, kind: 'note', member: r.name, targetId: c.objectId, text: `${r.name}'s pet broke the ${c.cc.kind} on ${c.name}`, data: { petBrokeCc: true, kind: c.cc.kind, by: c.cc.by } });
        this.ccEnded(c, c.cc.kind as CcKind, now);
    }

    /** Anything else fighting the group here and under no crowd control: ccHolds' question, on the board. */
    private anotherFree(c: InternalContact, now: number): boolean {
        for (const t of this.contacts.values()) if (t !== c && t.regionId === c.regionId && !(t.cc && t.cc.until > now) && this.isThreat(t, now)) return true;
        return false;
    }

    /** Contact.threat, as of `now`. */
    private isThreat(c: InternalContact, now: number): boolean {
        // A player contact at 0 % is alive (a dead one is no contact): it still fights.
        return now - c.lastSeen <= this.staleAfterMs && (c.kind === 'player' || c.hp > 0) && now - c.lastHostile < this.hostileMs && !untouchable(c, now);
    }

    /** Crowd control it no longer has, by what we saw of it: a note for the observer. */
    private ccBroke(c: InternalContact, now: number): void {
        this.emit({ at: now, kind: 'note', member: c.cc!.by, targetId: c.objectId, text: `${c.cc!.kind} on ${c.name} broke` });
        this.ccEnded(c, c.cc!.kind as CcKind, now);
    }

    /**
     * `byFoe`: a player another realm (or a monster) killed, which is ours only if we hit it too.
     * An enemy pet that went with its owner is no kill in the fight: the owner's death frees it (GamePlayer.cs:5988-5989), and live it read `kills 3` for 2 players with the turret at 74 %. Nor is one that went for any other reason (LOST_PET_HP).
     */
    private kill(key: string, by: string, now: number, byFoe = false): void {
        const c = this.contacts.get(key);
        // A mob that just inherited the id: the death members still report is its predecessor's.
        if (!c || now < c.deathEchoUntil) return;
        this.contacts.delete(key);
        this.ccMemory.delete(key);
        for (const [k, d] of this.killed) if (now - d.at >= KILLED_MS) this.killed.delete(k);
        this.killed.set(key, { at: now, name: c.name, x: c.x, y: c.y, hp: c.hp, player: c.kind === 'player' });
        if (c.kind === 'player') this.playerDiedAt.set(c.realm, now);
        if (!c.engaged) return;
        if (c.isPet && c.hp >= WITH_OWNER_HP && now - (this.playerDiedAt.get(c.realm) ?? -Infinity) <= WITH_OWNER_MS) {
            this.emit({ at: now, kind: 'note', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) went with its owner` });
            return;
        }
        if (c.isPet && (c.hp >= LOST_PET_HP || now - c.petHitAt > PET_HIT_LATELY_MS)) {
            this.emit({ at: now, kind: 'note', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) was lost, no kill of ours` });
            return;
        }
        if (byFoe && !c.hit) this.emit({ at: now, kind: 'note', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) died to someone else` });
        else this.emit({ at: now, kind: 'kill', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) died`, data: { name: c.name, level: c.level, kind: c.kind, realm: c.realm, ...(c.isPet ? { pet: true } : {}) } });
    }

    /**
     * Record crowd control a member landed, so nobody hits it or casts that kind at it. `durationMs` is the spell's
     * full length: the server's own line ends it sooner (ccEnded). A root holds for half of that, then wears off
     * (ECSGameSpellEffect.cs, EffectService.cs), and a monster's repeats are shorter (npcCcLanded).
     */
    markCc(targetId: number, regionId: number, by: string, kind: string, durationMs: number, now = Date.now(), serverName?: string): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (!c) return;
        const k = kind as CcKind;
        let lastsMs = durationMs;
        if (c.kind === 'player') (c.ccImmune ??= {})[k] = now + durationMs + CC_IMMUNE_MS;
        // A monster has no limit on roots (TryApplyImmunity is for players, and NpcImmunityEffect for mezz and stun).
        else if (k !== 'root') {
            const landed = npcCcLanded(c.ccRuns?.[k], durationMs, now);
            lastsMs = landed.durationMs;
            (c.ccRuns ??= {})[k] = landed.run;
            if (landed.immuneUntil) (c.ccImmune ??= {})[k] = landed.immuneUntil;
        }
        c.cc = { by, kind, until: now + (k === 'root' ? lastsMs / 2 : lastsMs) };
        c.ccSince = now;
        c.ccAt = null;
        if (serverName) c.serverName = serverName;
    }

    /** Record that this kind can't land on it for up to `durationMs` (the server answered so), unless we already know until when. */
    markCcImmune(targetId: number, regionId: number, kind: CcKind, durationMs: number, now = Date.now()): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (c && (c.ccImmune?.[kind] ?? 0) <= now) (c.ccImmune ??= {})[kind] = now + durationMs;
    }

    /** It ended at `at`: on a player the immunity runs from then (EffectListComponent.cs TryApplyImmunity). */
    private ccEnded(c: InternalContact, kind: CcKind, at: number): void {
        if (at < c.ccSince) return; // Its predecessor's.
        if (c.cc?.kind === kind) c.cc = null;
        if (c.kind === 'player') (c.ccImmune ??= {})[kind] = at + CC_IMMUNE_MS;
    }

    /** The server said so by name. A monster's isn't unique: only the one contact of that name under this kind. */
    private ccEndedNamed(regionId: number, e: CcEnd): void {
        const key = serverNameKey(e.name);
        const named = [...this.contacts.values()].filter(c => c.regionId === regionId && (c.kind === 'player' ? c.serverName && serverNameKey(c.serverName) === key : c.cc?.kind === e.kind && serverNameKey(c.name) === key));
        if (named.length === 1) this.ccEnded(named[0]!, e.kind, e.at);
    }

    /** Adds a sighting's look to the enemy player's evidence, and reads its class again when something new came. */
    private readFoe(key: string, c: InternalContact, s: Sighting, now: number): void {
        delete c.look;
        let ev = this.foes.get(key);
        if (ev && (ev.race !== s.name || ev.realm !== s.realm)) ev = undefined;
        const fresh = !ev;
        if (!ev) {
            for (const [k, f] of this.foes) if (now - f.touched > FOE_MEMORY_MS) this.foes.delete(k);
            this.foes.set(key, ev = { ...newEvidence(s.name, s.realm, s.level), touched: now });
        }
        ev.touched = now;
        if (addLook(ev, s.look, s.level, now) || fresh || !c.classGuess) {
            const guess = readClass(ev);
            if (guess) c.classGuess = guess; else delete c.classGuess;
        }
    }

    private forget(key: string, c: InternalContact): void {
        this.contacts.delete(key);
        if (c.ccImmune || c.serverName || c.ccRuns) this.ccMemory.set(key, { ccImmune: c.ccImmune, serverName: c.serverName, ccRuns: c.ccRuns });
    }

    /** Record that no attack lands on it for `durationMs`: a member's got `You can't attack a shadowed necromancer!` (SHADE_REFUSED). The coordinator's next tick moves the focus off it. */
    markUnattackable(targetId: number, regionId: number, durationMs: number, now = Date.now()): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (c) c.unattackableUntil = now + durationMs;
    }

    /** The current shared picture (copies; safe to keep). */
    picture(now = Date.now()): GroupPicture {
        const contacts: Contact[] = [];
        // Keep guards only while the orders carry a raid (Contact.keepGuard): nothing else knows what to do with them.
        const guards = !!this.orders.settings?.raid;
        for (const [key, c] of this.contacts) {
            if (now - c.lastSeen > this.forgetAfterMs) { this.forget(key, c); continue; }
            // ... or while one is on one of ours (a guard come out after us): rvr.ts fights a lone one outside the walls.
            if (c.keepGuard && !guards && !c.target && !c.targetPet) continue;
            if (c.cc && c.cc.until <= now) c.cc = null;
            for (const k of Object.keys(c.ccImmune ?? {}) as CcKind[]) if (c.ccImmune![k]! <= now) delete c.ccImmune![k];
            if (c.unattackableUntil !== undefined && c.unattackableUntil <= now) delete c.unattackableUntil;
            const { engaged: _e, hit: _h, petHitAt: _p, ccSince: _s, ccAt: _a, ccRuns: _r, deathEchoUntil: _d, petKillerUntil: _k, petKillerOf: _o, fixedAt: _f, lastHostile: _l, look: _lk, ...pub } = c;
            const stale = now - c.lastSeen > this.staleAfterMs;
            const threat = this.isThreat(c, now);
            contacts.push({ ...pub, seenBy: [...c.seenBy], stale, threat, hostileSince: threat ? c.hostileSince : 0, cc: c.cc ? { ...c.cc } : null, ...(c.ccImmune ? { ccImmune: { ...c.ccImmune } } : {}) });
        }
        // A shade's servant, marked for everyone who reads the board (shadeBodies reads it as the player).
        for (const [petId, shade] of servantsOf(contacts)) {
            const pet = contacts.find(c => c.objectId === petId && c.regionId === shade.regionId);
            if (pet) pet.servantOf = shade.objectId;
        }
        return { at: now, members: this.everyone(now).map(m => ({ ...m })), contacts, orders: this.getOrders() };
    }

    getOrders(): Orders {
        return { ...this.orders, cc: this.orders.cc.map(c => ({ ...c })), waiting: this.orders.waiting.map(w => ({ ...w })) };
    }

    /** Orders.settings as it stands, without getOrders' copy: members read it on every ctx.settings. */
    settingsPatch(): Orders['settings'] {
        return this.orders.settings;
    }

    /** Apply the coordinator's update. Returns true when the change is material (seq bumped). */
    setOrders(update: OrdersUpdate, now = Date.now()): boolean {
        const prev = this.orders;
        const next: Orders = { ...prev, ...update, seq: prev.seq, issuedAt: prev.issuedAt };
        // The melee's own focus lasts one decide: one that doesn't name it (the raid over, a fight with players) drops it.
        if (!('meleeFocus' in update)) delete next.meleeFocus;
        if (!('meleeSplit' in update)) delete next.meleeSplit;
        if (!('memberOwn' in update)) delete next.memberOwn;
        const material = isMaterialChange(prev, next);
        if (material) {
            next.seq = prev.seq + 1;
            next.issuedAt = now;
        }
        this.orders = next;
        const focus = this.contactById(next.focus);
        // Set once per contact (cc or reason changes don't move it): a carried mob's hold counts from here.
        if (next.phase === 'engage' && focus && focus.engagedAt === 0) focus.engagedAt = now;
        if (material) {
            this.emit({
                at: now, kind: 'orders', targetId: next.focus,
                text: `${next.phase}${next.column ? ` (column behind ${next.column.driver})` : ''}${focus ? ` on ${focus.name}` : ''}${next.cc.length ? ` (cc ${next.cc.map(c => `${c.by}→${c.targetId}`).join(', ')})` : ''}: ${next.reason}`,
                data: { phase: next.phase, focus: next.focus, puller: next.puller, seq: next.seq },
            });
            for (const l of this.orderListeners) l(this.getOrders(), prev);
        }
        return material;
    }

    /** The contact under an object id. Ids are per region: the most recently seen one wins. */
    private contactById(id: number | null): InternalContact | undefined {
        let best: InternalContact | undefined;
        if (id === null) return best;
        for (const c of this.contacts.values()) if (c.objectId === id && (!best || c.lastSeen > best.lastSeen)) best = c;
        return best;
    }

    emit(event: GroupEvent): void {
        this.eventLog.push(event);
        if (this.eventLog.length > this.maxEvents) this.eventLog.splice(0, this.eventLog.length - this.maxEvents);
        for (const l of this.eventListeners) l(event);
    }

    events(since = 0): GroupEvent[] {
        return this.eventLog.filter(e => e.at >= since);
    }

    onEvent(listener: (e: GroupEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /** Called after every material orders change. */
    onOrders(listener: (next: Orders, prev: Orders) => void): () => void {
        this.orderListeners.add(listener);
        return () => this.orderListeners.delete(listener);
    }
}
