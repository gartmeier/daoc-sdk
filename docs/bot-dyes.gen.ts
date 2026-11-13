// Generates docs/bot-dyes.sql and docs/bot-dyes-undo.sql from the live DB.
// Read-only on the DB. Run: bun docs/bot-dyes.gen.ts   (writes both files, prints the dry-run count)
// The SQL must run while the gameserver is stopped: it caches a logged-in character's inventory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXCLUDE = new Set(['Niamh']); // the user's character
// helm, gloves, boots, torso, cloak, legs, arms: the slots the appearance packet colours (shields left alone)
const SLOTS = [21, 22, 23, 25, 26, 27, 28];
const BODY = new Set([25, 27, 28]);
const EXTREMITIES = new Set([21, 22, 23]);

function sql(query: string): string[][] {
    const p = Bun.spawnSync(['docker', 'compose', '-f', join(ROOT, 'server/docker/docker-compose.yml'), 'exec', '-T', 'db',
        'mariadb', '-uroot', '-pdaoc-sdk', 'opendaoc', '-N', '-B', '-e', query]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().split('\n').filter(Boolean).map((l) => l.split('\t'));
}

// Dye ids are the itemtemplate Color of the cloth/leather/enamel dyes (same id for every kind).
const C = {
    teal: 34, charcoal: 43, rust: 49, lightBlue: 51, blue: 52, royalBlue: 53, turquoise: 56, darkTeal: 60,
    lightBrown: 61, brown: 62, darkBrown: 63, red: 65, royalRed: 66, crimson: 67, green: 69, royalGreen: 70,
    forestGreen: 71, darkGray: 73, black: 74, orange: 76, purple: 79, royalPurple: 80, royalYellow: 83,
    darkBlue: 86, darkPurple: 87, plum: 121, deepViolet: 122, lightGold: 125, darkGold: 126, tan: 128,
    earthenBrown: 129, oliveGreen: 131, lightGray: 133, duskyRose: 135, sageGreen: 136, grayTeal: 138,
    grayBlue: 139, oliveGray: 140,
} as const;

// Two colours that go together per character, as players dyed: a cloak and a body colour (black cloak, golden vest).
// Either colour may be the cloak; gloves, boots and helm take one of the two. Not tied to the realm.
const PAIRS: [number, number][] = [
    [C.black, C.lightGold], [C.black, C.darkGold], [C.black, C.crimson], [C.black, C.royalRed], [C.black, C.lightGray],
    [C.black, C.royalBlue], [C.black, C.royalPurple], [C.royalBlue, C.lightGold], [C.darkBlue, C.lightGray],
    [C.darkBlue, C.darkGold], [C.royalBlue, C.lightGray], [C.forestGreen, C.tan], [C.forestGreen, C.darkGold],
    [C.forestGreen, C.earthenBrown], [C.royalGreen, C.lightGold], [C.oliveGreen, C.darkBrown], [C.crimson, C.darkGold],
    [C.royalRed, C.charcoal], [C.crimson, C.lightGray], [C.darkPurple, C.lightGold], [C.deepViolet, C.lightGray],
    [C.plum, C.charcoal], [C.darkBrown, C.tan], [C.darkTeal, C.tan], [C.grayBlue, C.charcoal], [C.rust, C.charcoal],
    [C.darkTeal, C.darkGold], [C.sageGreen, C.darkBrown], [C.charcoal, C.lightGold], [C.darkGray, C.royalBlue],
];
// The three guilds groups/signature.ts formed keep their signature colour, now with a partner: [cloak, body].
// Starter guilds (Clan Cotswold, Mularn Protectors, Tir na Nog Adventurers) are no guild in this sense.
const GUILD_PAIR: Record<string, [number, number]> = {
    'Crimson Order': [C.crimson, C.darkGold],
    'Ravens of Jordheim': [C.black, C.royalBlue],
    'Wolves of Tir na Nog': [C.darkGray, C.forestGreen],
};


function hash(s: string): number {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    // murmur3 finaliser: FNV alone leaves keys that differ in one letter close together
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return h >>> 0;
}
const rnd = (key: string) => hash(key) / 2 ** 32;
const pick = <T>(key: string, xs: readonly T[]) => xs[Math.floor(rnd(key) * xs.length)]!;
const rows = sql(`select c.Name, coalesce(g.GuildName, ''), i.Inventory_ID, i.SlotPosition, i.Color, i.Emblem
  from inventory i join dolcharacters c on c.DOLCharacters_ID = i.OwnerID join account a on a.Name = c.AccountName
  left join guild g on g.GuildID = c.GuildID
  where a.PrivLevel = 1 and i.SlotPosition in (${SLOTS.join(',')}) order by c.Name, i.SlotPosition`);

type Look = { body: number; trim: number; cloak: number; undyedArmour: boolean; guild?: string };
const looks = new Map<string, Look>();
function lookFor(name: string, guildName: string): Look {
    let l = looks.get(name);
    if (l) return l;
    const gp = GUILD_PAIR[guildName];
    let cloak: number, body: number;
    if (gp) [cloak, body] = gp;
    else {
        const [a, b] = pick(`pair:${name}`, PAIRS);
        [cloak, body] = rnd(`flip:${name}`) < 0.5 ? [a, b] : [b, a];
    }
    const trim = rnd(`trim:${name}`) < 0.5 ? body : cloak;
    // a few never bothered dyeing the armour, only the cloak (not in a guild that dyes together)
    l = { body, trim, cloak, undyedArmour: !gp && rnd(`plain:${name}`) < 0.06, guild: gp ? guildName : undefined };
    looks.set(name, l);
    return l;
}

const sets: string[] = [];
const undo: string[] = [];
const byColor = new Map<number, string[]>();
const chars = new Set<string>();
for (const [name, guildName, id, slotS, colorS, emblemS] of rows) {
    if (EXCLUDE.has(name!)) continue;
    const slot = Number(slotS);
    const l = lookFor(name!, guildName ?? '');
    const color = slot === 26 ? l.cloak : l.undyedArmour ? 0 : BODY.has(slot) ? l.body : EXTREMITIES.has(slot) ? l.trim : 0;
    if (color === Number(colorS) && Number(emblemS) === 0) continue;
    chars.add(name!);
    (byColor.get(color) ?? byColor.set(color, []).get(color)!).push(id!);
    undo.push(`UPDATE inventory SET Color=${Number(colorS)}, Emblem=${Number(emblemS)} WHERE Inventory_ID='${id}';`);
}
for (const [color, ids] of [...byColor].sort((a, b) => a[0] - b[0]))
    for (let i = 0; i < ids.length; i += 50)
        sets.push(`UPDATE inventory SET Color=${color}, Emblem=0 WHERE Inventory_ID IN (${ids.slice(i, i + 50).map((x) => `'${x}'`).join(',')});`);

const total = undo.length;
const stamp = new Date().toISOString();
const head = (what: string) => `-- ${what}
-- Generated ${stamp} by docs/bot-dyes.gen.ts from the live DB: ${total} inventory rows on ${chars.size} PrivLevel-1 characters (Niamh left out).
-- Run only while the gameserver is stopped (it caches logged-in inventories and would write the old colours back):
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/<this file>
`;
writeFileSync(join(ROOT, 'docs/bot-dyes.sql'), `${head('Dyed armour and cloaks for the bots: two colours that go together per character (cloak and body), a shared pair for each of the three guilds.')}START TRANSACTION;\n${sets.join('\n')}\n-- expect ${total} rows changed in all\nCOMMIT;\n`);
writeFileSync(join(ROOT, 'docs/bot-dyes-undo.sql'), `${head('Undo of docs/bot-dyes.sql: each row back to its colour and emblem before the dye.')}START TRANSACTION;\n${undo.join('\n')}\nCOMMIT;\n`);

const name = (c: number) => Object.entries(C).find(([, v]) => v === c)?.[0] ?? (c === 0 ? 'undyed' : String(c));
console.log(`${total} rows, ${chars.size} characters`);
if (process.argv.includes('--looks'))
    for (const [n, l] of looks) console.log(`${n.padEnd(14)} ${(l.guild ?? '-').padEnd(20)} body=${name(l.undyedArmour ? 0 : l.body)} trim=${name(l.undyedArmour ? 0 : l.trim)} cloak=${name(l.cloak)}`);
