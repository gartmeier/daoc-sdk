// Group coordination: shared awareness (Blackboard), a coordinator running a
// strategy's decide(), member agents running behaviour lists, and an observer
// that scores each run. See learnings/group-coordination.md.

export * from './types';
export { Blackboard, observeState, emptyOrders, isMaterialChange, isAlive, type BlackboardOptions, type Observation } from './blackboard';
export { MemberAgent, MemberContext, type Behavior, type Member } from './member';
export * from './behaviors';
export { Coordinator, defineStrategy, roleForClass, type CoordinatorContext, type GroupStrategy } from './strategy';
export { pveLeveling, decidePve, pickPullTarget, pickFocus, assignCc, PVE_SETTINGS, type PveSettings } from './pve';
export { PORTAL_KEEPS, BATTLEGROUNDS, portalKeepOf, inBattleground, atPortalKeep, entryProblem, townTeleporter, viaWalkers, walkTogether, toPortalKeep, bindAtPortalKeep, wearsMedallion, getMedallion, wearMedallion, waitForPort, enterBattleground, type MedallionResult, type PortalKeep, type Battleground, type EnterResult } from './battleground';
export { accessorySlots, nextAccessory, wearAccessories, nearestCloakSeller, holdsCloak, buyCloak, CLOAK_RADIUS, CLOAK_RESERVE, CLOAK_TOWN_RANGE, type AccessoryMove, type CloakSeller, type GearMember } from './gear';
export { rvrRoaming, decideRvr, rvrBehaviors, rvrFindings, pickRvrFocus, homeOf, keepDangers, defaultPatrol, realmOfGroup, BATTLEGROUND_LAYOUTS, THIDRANKI, RVR_SETTINGS, type RvrSettings, type BattlegroundLayout, type Keep, type PlayerRealm } from './rvr';
export { GroupObserver, findingsFor, formatReport, saveReport, stampOf, inferPhase, type Finding, type FightSummary, type MemberStats, type RunReport } from './observer';
export { loadGroup, connectBot, connectGroup, formGroup } from './roster';
export { runGroup, runGroupScript, groupArgs, type GroupRunOptions, type GroupRunResult } from './runner';
export { GroupPublisher, EventOutbox, windDownClock, memoryView, planView, jsonSafe, type GroupPublishOptions, type PublisherDeps } from './publish';
export { isLoggedEvent, WIRE_VERSION } from './wire';
export type { RunPhase, RunMember, RunMeta, CoordinatorView, PlanView, LiveReport, WireEvent, RunResultView, GroupPublish, ControlRequest, PublishAck } from './wire';
export { Spellbook, spellsOf, slotOf, pickNuke, dotFamily, toPick, type SpellPick, type NukeOptions } from './spells';
export * from './buffs';
export * from './songs';
export * from './terrain';
export * from './baseplan';
export * from './positioning';
export type { ScriptContext } from '../runner';
