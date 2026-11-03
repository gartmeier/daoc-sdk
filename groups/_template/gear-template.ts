// Put every member in its level's gear template: custom items at the server's caps, made by a GM and traded over
// (learnings/gear-template.md). Whoever wears it already is left alone, and then no GM is needed.
//
//   bun groups/<group>/gear-template.ts [--only=bot,bot]

import { auditRow, connectGroup, loadGroup, runGearTemplate, runGroupScript, type ScriptContext, type TemplateMember } from '../../sdk/group';

const main = async ({ bot, sdk }: ScriptContext) => {
    const def = loadGroup(import.meta.dir);
    const { members, opened } = await connectGroup(def, { bot, sdk });
    try {
        const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
        const reports = await runGearTemplate(import.meta.dir, members as unknown as TemplateMember[], { only });
        console.log('| Bot | Class | Slots | Stats at cap | Hits | Resists at cap | Skills at cap | Power | AF bonus | HP | Load | Short of it |');
        console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
        for (const r of reports) console.log(auditRow(r, members[0]!.sdk.getPlayer()!.level));
        return reports;
    } finally {
        await Promise.all(opened.map(s => s.disconnect().catch(() => null)));
    }
};

export default main;
if (import.meta.main) await runGroupScript(main, { dir: import.meta.dir, timeout: 15 * 60_000 });
