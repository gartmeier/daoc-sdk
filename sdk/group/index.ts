// Group coordination: shared awareness (Blackboard), a coordinator running a
// strategy's decide(), member agents running behaviour lists, and an observer
// that scores each run. See learnings/group-coordination.md.

export * from './types';
export { Blackboard, observeState, emptyOrders, isMaterialChange, isAlive, type BlackboardOptions, type Observation } from './blackboard';
export { MemberAgent, MemberContext, countCombatMessage, type Behavior, type Member } from './member';
export { loadCharacter, withCharacter, type Character } from './character';
export * from './behaviors';
export { resistDebuff, matchingDebuff, debuffPays } from './debuff';
export * from './styles';
export { Coordinator, defineStrategy, roleForClass, type CoordinatorContext, type GroupStrategy } from './strategy';
export { pveLeveling, decidePve, pickPullTarget, pickFocus, assignCc, PVE_SETTINGS, type PveSettings } from './pve';
export { PORTAL_KEEPS, BATTLEGROUNDS, CAPITALS, portalKeepOf, capitalOf, inBattleground, inCapital, atPortalKeep, entryProblem, townTeleporter, viaWalkers, walkTogether, toPortalKeep, bindAtPortalKeep, wearsMedallion, getMedallion, wearMedallion, waitForPort, portTogether, enterBattleground, battlegroundExit, leaveBattleground, type MedallionResult, type PortalKeep, type Battleground, type Passage, type EnterResult } from './battleground';
export { wearPerEvent, tooHighLevel, wornDown, GEAR_MAX_CON, GEAR_MIN_GAP, REPAIR_BELOW } from './gear-score';
export { repairGear, takeFromVault, stashInVault, needsRepair, keepForLater, vaultDue, careDue, classCouldUse, nearestSmith, nearestVaultKeeper, CARE_RADIUS, REPAIR_RESERVE, type CareMember, type CareOptions } from './gear-care';
export { cloakTrip, CAPITAL_RADIUS } from './cloak-trip';
export { trainAtClassTrainer, trainAtTrainer, trainFlags, trainingDue, nearestClassTrainer, TRAINER_RADIUS, type TrainMember, type TrainOptions, type TrainRun, type TrainTrip } from './train';
export { accessorySlots, nextAccessory, wearAccessories, nearestCloakSeller, holdsCloak, buyCloak, GearDelves, armorUpgradeGain, upgradeGains, UPGRADE_MARGIN, MAX_DELVES, CLOAK_RADIUS, CLOAK_RESERVE, CLOAK_TOWN_RANGE, weaponNeeds, weaponSlots, bestWeapon, wearWeapons, buyWeapons, weaponUpgrades, weaponSellers, WEAPON_STEP, WEAPON_SWAP, WEAPON_RADIUS, WEAPON_RESERVE, type AccessoryMove, type CloakSeller, type GearMember, type GearScore, type WeaponMember, type WeaponNeeds, type WeaponOptions, type WeaponRow, type WeaponSeller } from './gear';
export { CLASS_KITS, GM_BOT, MAX_BONUSES, SKILL_PROPERTY, TEMPLATE_PACKAGE, auditRow, buildSpecs, isTemplatePiece, levelCaps, runGearTemplate, templateFor, templateGap, templateSql, templateTotals, wearOrder, type TemplateAudit, type TemplateMember, type TemplatePiece } from './gear-template';
export { statScore, statWeight, bonusCap, armorValue, armorGain, armorSwing, weaponValue, asRepaired, weaponScore, STAT_WEIGHTS, SIDE_STAT_WEIGHT, BONUS_WEIGHTS, ARMOR_STAT_RATE, ARMOR_STAT_SWING, WEAPON_STAT_RATE, WEAPON_STAT_SWING } from './gear-score';
export { CC_IMMUNE_MS, canControl, ccImmuneTo, immuneKinds, type CcImmunity, type CcKind } from './cc';
export { rvrRoaming, decideRvr, rvrBehaviors, rvrFindings, pickRvrFocus, homeOf, keepDangers, defaultPatrol, realmOfGroup, BATTLEGROUND_LAYOUTS, THIDRANKI, RVR_SETTINGS, type RvrSettings, type BattlegroundLayout, type Keep, type PlayerRealm } from './rvr';
export { rvrPack, decidePack, packBehaviors, packCc, pickPackFocus, PACK_SETTINGS, PACK_OPTIONS, type PackSettings, type PackOptions } from './pack';
export { GroupObserver, findingsFor, formatReport, saveReport, stampOf, inferPhase, type Finding, type FightSummary, type MemberStats, type RunReport } from './observer';
export { loadGroup, connectBot, connectGroup, formGroup } from './roster';
export { runGroup, runGroupScript, groupArgs, type GroupRunOptions, type GroupRunResult } from './runner';
export { GroupPublisher, EventOutbox, windDownClock, memoryView, planView, jsonSafe, type GroupPublishOptions, type PublisherDeps } from './publish';
export { isLoggedEvent, WIRE_VERSION } from './wire';
export type { RunPhase, RunMember, RunMeta, CoordinatorView, PlanView, LiveReport, WireEvent, RunResultView, GroupPublish, ControlRequest, PublishAck } from './wire';
export { Spellbook, spellsOf, slotOf, pickNuke, pickHeal, healAmount, dotFamily, toPick, type SpellPick, type NukeOptions } from './spells';
export * from './buffs';
export * from './songs';
export * from './terrain';
export * from './baseplan';
export * from './positioning';
export type { ScriptContext } from '../runner';
