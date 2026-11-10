// Group tactics: the decide wrappers the realm groups converged on in the arena (2026-11-09/10), shaped like the class
// kits. A group's strategy wraps the pack's or roaming's decide in the ones it wants, with its own options, and adds its
// own experiments; each tactic can be switched off per run (settings.tactics, `--tactics.peel=false`).
// learnings/group-coordination.md "Group tactics" has what each does, the variants, and what step 2 would unify.
//
// 1. focus by enemy role (focus-role.ts)   2. no thrash (focus-hold.ts)   3. peel (peel.ts)   4. the enemy's make-up (make-up.ts)

export { dist, centreOf, retarget, anchorFor, clockAt, clockPair, tacticOn, TACTIC_NAMES, type AnchorRule, type Retarget, type Clock, type TacticName, type TacticSwitches } from './common';
export { foeKind, enemyMix, meleeHeavy, healersRead, byMakeUp, readMakeUp, withMakeUp, MELEE_HEAVY, MAKE_UP, type FoeKind, type MakeUp, type MakeUpOptions, type MeleeHeavyRule } from './make-up';
export { roleOf, isNear, focusByRole, focusBackLine, CC_HEALER_CASTER, CASTER_HEALER_CC, HEALER_CASTER_CC, HEALER_STICKY, BACK_LINE, type RoleBy, type Near, type FocusByRoleOptions, type BackLineOptions } from './focus-role';
export { holdFocus, finishLow, dwellFocus, dwellHold, dwellRecord, HOLD, FINISH_LOW, DWELL, type HoldOptions, type FinishOptions, type DwellOptions } from './focus-hold';
export { diverOn, peelFocus, meleeOn, peelByMezz, mezzMelee, rootMelee, leashTank, PEEL_MELEE, PEEL_CASTER, MELEE_ON_SOFT, MEZZ_MELEE, ROOT_MELEE, type PeelOptions, type MeleeOnOptions, type MezzMeleeOptions, type RootMeleeOptions } from './peel';
