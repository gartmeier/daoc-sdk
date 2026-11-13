// Generates docs/bot-dyes.sql and docs/bot-dyes-undo.sql from the live DB and groups/*/group.json.
// Read-only on the DB. Run: bun docs/bot-dyes.gen.ts   (writes both files, prints the dry-run count)
// The SQL must run while the gameserver is stopped: it caches a logged-in character's inventory.
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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

// Weighted palettes: the realm colour dominates, then neutrals, then a few personal picks.
const MAIN: Record<number, [number, number][]> = {
    1: [[C.crimson, 5], [C.royalRed, 4], [C.red, 2], [C.royalBlue, 2], [C.darkBlue, 2], [C.black, 2], [C.charcoal, 2],
        [C.plum, 1], [C.darkGold, 1], [C.tan, 1], [C.darkBrown, 1], [C.royalPurple, 1]],
    2: [[C.royalBlue, 5], [C.darkBlue, 4], [C.grayBlue, 3], [C.blue, 2], [C.charcoal, 2], [C.black, 2], [C.darkGray, 2],
        [C.earthenBrown, 1], [C.rust, 1], [C.oliveGray, 1], [C.teal, 1], [C.lightGray, 1]],
    3: [[C.forestGreen, 5], [C.royalGreen, 3], [C.oliveGreen, 3], [C.darkTeal, 2], [C.sageGreen, 2], [C.grayTeal, 1],
        [C.turquoise, 1], [C.earthenBrown, 2], [C.brown, 1], [C.darkPurple, 1], [C.black, 1], [C.tan, 1]],
};
// Gloves, boots and helm: usually a dark neutral or the body colour.
const TRIM: Record<number, number[]> = {
    1: [C.black, C.charcoal, C.darkBrown, C.darkGold, C.darkGray],
    2: [C.black, C.charcoal, C.darkGray, C.earthenBrown, C.grayBlue],
    3: [C.darkBrown, C.black, C.earthenBrown, C.darkTeal, C.oliveGray],
};
// Guild colours: a group that wears one shares it on the cloak (and some members on the tabard/torso too).
const GUILD: Record<number, number[]> = {
    1: [C.crimson, C.royalBlue, C.black, C.darkGold, C.royalPurple, C.royalRed],
    2: [C.royalBlue, C.darkBlue, C.black, C.rust, C.grayBlue, C.charcoal],
    3: [C.forestGreen, C.darkPurple, C.royalGreen, C.darkTeal, C.black, C.earthenBrown],
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
function weighted(key: string, xs: [number, number][]): number {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = rnd(key) * total;
    for (const [v, w] of xs) if ((r -= w) < 0) return v;
    return xs[xs.length - 1]![0];
}

// Character name -> group (members before bench, first file wins).
const charOf = new Map<string, string>();
for (const bot of readdirSync(join(ROOT, 'bots'))) {
    const env = join(ROOT, 'bots', bot, 'bot.env');
    if (!existsSync(env)) continue;
    const m = readFileSync(env, 'utf8').match(/^CHAR_NAME=(.+)$/m);
    if (m) charOf.set(bot.toLowerCase(), m[1]!.trim());
}
const groupOf = new Map<string, string>();
const groupFiles = readdirSync(join(ROOT, 'groups')).sort()
    .filter((g) => existsSync(join(ROOT, 'groups', g, 'group.json')))
    .map((g) => ({ g, j: JSON.parse(readFileSync(join(ROOT, 'groups', g, 'group.json'), 'utf8')) }));
for (const key of ['members', 'bench'] as const)
    for (const { g, j } of groupFiles)
        for (const m of j[key] ?? []) {
            const ch = charOf.get(String(m.bot).toLowerCase()) ?? String(m.bot);
            const name = ch.charAt(0).toUpperCase() + ch.slice(1);
            if (!groupOf.has(name)) groupOf.set(name, g);
        }

const rows = sql(`select c.Name, c.Realm, i.Inventory_ID, i.SlotPosition, i.Color, i.Emblem
  from inventory i join dolcharacters c on c.DOLCharacters_ID = i.OwnerID join account a on a.Name = c.AccountName
  where a.PrivLevel = 1 and i.SlotPosition in (${SLOTS.join(',')}) order by c.Name, i.SlotPosition`);

type Look = { body: number; trim: number; cloak: number; undyedArmour: boolean };
const looks = new Map<string, Look>();
function lookFor(name: string, realm: number): Look {
    let l = looks.get(name);
    if (l) return l;
    const g = groupOf.get(name);
    const guildOn = g !== undefined && rnd(`guild?${g}`) < 0.6;
    const guild = g ? pick(`guild:${g}`, GUILD[realm]!) : undefined;
    let body = weighted(`body:${name}`, MAIN[realm]!);
    if (guildOn && rnd(`tabard:${name}`) < 0.35) body = guild!; // some wear the guild colour head to toe
    const r = rnd(`trim?${name}`);
    const trim = r < 0.35 ? body : pick(`trim:${name}`, TRIM[realm]!);
    const cloak = guildOn ? guild! : rnd(`cloak?${name}`) < 0.5 ? body : weighted(`cloak:${name}`, MAIN[realm]!);
    l = { body, trim, cloak, undyedArmour: rnd(`plain:${name}`) < 0.1 }; // a few never bothered with dye
    looks.set(name, l);
    return l;
}

const sets: string[] = [];
const undo: string[] = [];
const byColor = new Map<number, string[]>();
const chars = new Set<string>();
for (const [name, realmS, id, slotS, colorS, emblemS] of rows) {
    if (EXCLUDE.has(name!)) continue;
    const realm = Number(realmS), slot = Number(slotS);
    if (!MAIN[realm]) continue;
    const l = lookFor(name!, realm);
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
writeFileSync(join(ROOT, 'docs/bot-dyes.sql'), `${head('Dyed armour and cloaks for the bots: realm palettes, dark trim, a shared guild cloak for some groups.')}START TRANSACTION;\n${sets.join('\n')}\n-- expect ${total} rows changed in all\nCOMMIT;\n`);
writeFileSync(join(ROOT, 'docs/bot-dyes-undo.sql'), `${head('Undo of docs/bot-dyes.sql: each row back to its colour and emblem before the dye.')}START TRANSACTION;\n${undo.join('\n')}\nCOMMIT;\n`);

const name = (c: number) => Object.entries(C).find(([, v]) => v === c)?.[0] ?? (c === 0 ? 'undyed' : String(c));
console.log(`${total} rows, ${chars.size} characters`);
if (process.argv.includes('--looks'))
    for (const [n, l] of looks) console.log(`${n.padEnd(14)} ${(groupOf.get(n) ?? '-').padEnd(14)} body=${name(l.undyedArmour ? 0 : l.body)} trim=${name(l.undyedArmour ? 0 : l.trim)} cloak=${name(l.cloak)}`);
