// Roam a battleground as a small squad of 1 to 3 (sdk/group/squad.ts): the edges, fights the odds favour, a run toward
// friends or our portal keep from one that turns. group.json lists the members. Field mode starts it as any group:
//
//   bun groups/<squad>/rvr.ts [seconds=120] [--squad.engageAt=0.9] [--squad.leaveAt=0.55] [--squad.variant=1] [--squad.edge=false]
//
// Copy it as groups/<squad>/rvr.ts. A folder name ending in a number picks the lane it starts on (squad-run.ts squadVariant).

import { squadMain, squadScript } from '../../sdk/group/squad-run';

const main = squadMain(import.meta.dir);
export default main;
if (import.meta.main) await squadScript(import.meta.dir);
