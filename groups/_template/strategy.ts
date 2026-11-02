// Group strategy for {{GROUP}}: the coordinator's policy and every role's behaviours. A member's own
// way of playing goes in bots/<bot>/character.ts, so it stays with the bot. Start from the PvE leveling strategy and change what the
// observer's reports point at. Everything in PVE_SETTINGS can be overridden here.
//
// Examples (see learnings/group-coordination.md):
//   settings: { holdMs: 2500 }                         casters wait longer before opening
//   settings: { combatRange: { nuker: [1100, 1450] } }  casters stand farther back
//   behaviors: { nuker: [...] }                         replace a role's behaviour list
//   decide: ctx => { ... return decidePve(ctx); }       wrap the coordinator's policy

import { defineStrategy, pveLeveling } from '../../sdk/group';

export default defineStrategy(pveLeveling, {
    name: '{{GROUP}}-pve',
    settings: {
        minCon: -1,
        maxCon: 1,
    },
});
