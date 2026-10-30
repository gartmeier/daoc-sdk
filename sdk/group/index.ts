// Group coordination: shared awareness (Blackboard), a coordinator running a
// strategy's decide(), member agents running behaviour lists, and an observer
// that scores each run. See learnings/group-coordination.md.

export * from './types';
export { Blackboard, observeState, emptyOrders, isMaterialChange, type BlackboardOptions, type Observation } from './blackboard';
export { MemberAgent, MemberContext, type Behavior, type Member } from './member';
export * from './behaviors';
export { Coordinator, defineStrategy, roleForClass, type CoordinatorContext, type GroupStrategy } from './strategy';
export { pveLeveling, decidePve, pickPullTarget, pickFocus, assignCc, PVE_SETTINGS, type PveSettings } from './pve';
export { GroupObserver, findingsFor, formatReport, saveReport, inferPhase, type Finding, type FightSummary, type MemberStats, type RunReport } from './observer';
export { loadGroup, connectBot, connectGroup, formGroup } from './roster';
export { runGroup, runGroupScript, groupArgs, type GroupRunOptions, type GroupRunResult } from './runner';
export { Spellbook, spellsOf, slotOf, type SpellPick } from './spells';
export * from './buffs';
export * from './songs';
export * from './terrain';
export type { ScriptContext } from '../runner';
