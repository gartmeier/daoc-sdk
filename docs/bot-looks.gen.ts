// Generates docs/bot-looks.sql and docs/bot-looks-undo.sql from the live DB: guilds with emblems for the bots, dyes,
// caster hats and robes, and Niamh's look. Read-only on the DB.
//   bun docs/bot-looks.gen.ts [--looks]
// The SQL must run while the gameserver is stopped: it caches guilds, item templates and logged-in inventories.
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SLOTS = [11, 21, 22, 23, 25, 26, 27, 28]; // shield (emblem only), helm, gloves, boots, torso, cloak, legs, arms

function sql(query: string): string[][] {
    const p = Bun.spawnSync(['docker', 'compose', '-f', join(ROOT, 'server/docker/docker-compose.yml'), 'exec', '-T', 'db',
        'mariadb', '-uroot', '-pdaoc-sdk', 'opendaoc', '-N', '-B', '-e', query]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().split('\n').filter(Boolean).map((l) => l.split('\t'));
}
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

// Dye ids: the itemtemplate Color of the dyes (cloth dye, leather dye and enamel share one id per colour).
const C = {
    teal: 34, charcoal: 43, rust: 49, royalBlue: 53, darkTeal: 60, brown: 62, darkBrown: 63, royalRed: 66, crimson: 67,
    royalGreen: 70, forestGreen: 71, darkGray: 73, black: 74, royalPurple: 80, darkBlue: 86, darkPurple: 87, plum: 121,
    deepViolet: 122, lightGold: 125, darkGold: 126, tan: 128, earthenBrown: 129, oliveGreen: 131, lightGray: 133,
    sageGreen: 136, grayBlue: 139,
} as const;

// Guild emblem = (logo << 9) | (pattern << 7) | (primary << 3) | secondary (EmblemDialogReponseHandler).
// primary: the client's dark set (patterns.csv set 1, 16), secondary: its light set (set 2, 8).
// logo: an id 1..255 from the client's gamedata.mpk/insignia.csv, which numbers the three realms' insignia/<b|n|h>_emblem_NNN.dds
// in blocks (checked in the client on 2026-11-14: logo 77 drew N_emblem_037, a crow). logo() turns a realm's file number into that id.
const DK = { red: 0, darkRed: 1, violet: 2, purple: 3, royalBlue: 4, blue: 5, teal: 6, ltBlue: 7, green: 8, dkGreen: 9, olive: 10, tan: 11, brown: 12, rust: 13, gray: 14, maroon: 15 };
const LT = { ivory: 0, darkKhaki: 1, gray: 2, yellow: 3, orange: 4, green: 5, blue: 6, purple: 7 };
const LOGO_BLOCKS: Record<'b' | 'n' | 'h', [number, number, number]> = { b: [1, 124, 199], n: [41, 174, 218], h: [81, 149, 237] }; // ids of files 1, 41, 66
const logo = (realm: 'b' | 'n' | 'h', file: number) => {
    if (file < 1 || file > 84) throw new Error(`no insignia file ${realm} ${file}`);
    const [a, b, c] = LOGO_BLOCKS[realm];
    return file <= 40 ? a + file - 1 : file <= 65 ? b + file - 41 : c + file - 66;
};
const emblem = (realm: 'b' | 'n' | 'h', file: number, pattern: number, primary: number, secondary: number) =>
    (logo(realm, file) << 9) | (pattern << 7) | (primary << 3) | secondary;

type Scheme = { body: number; arms: number; hands: number; helm: number };
type GuildDef = { name: string; realm: number; emblem: number; scheme: Scheme; groups: string[] };
// The names from the "Server and guild naming" session: its pick per realm for the first unit, its alternatives for the rest.
// The schemes follow that session's two-tone idea: a dark main colour, lighter sleeves, gloves to match one of them.
const GUILDS: GuildDef[] = [
    { name: 'The Copper Knights', realm: 1, emblem: emblem('b', 58, 1, DK.rust, LT.orange), groups: ['camelot'],
        scheme: { body: C.darkBrown, arms: C.rust, hands: C.darkBrown, helm: C.rust } }, // knight's helm, weathered copper
    { name: 'Knights of the Ninth Hour', realm: 1, emblem: emblem('b', 29, 2, DK.darkRed, LT.yellow), groups: ['camelot-2'],
        scheme: { body: C.black, arms: C.crimson, hands: C.black, helm: C.black } }, // crossed torches
    { name: 'Order of the Brass Lion', realm: 1, emblem: emblem('b', 74, 0, DK.red, LT.yellow), groups: ['camelot-s1', 'camelot-s2', 'camelot-s3', 'camelot-s4'],
        scheme: { body: C.crimson, arms: C.darkGold, hands: C.darkGold, helm: C.crimson } }, // lion rampant
    { name: 'Einherjar', realm: 2, emblem: emblem('n', 61, 1, DK.blue, LT.gray), groups: ['midgard'],
        scheme: { body: C.charcoal, arms: C.grayBlue, hands: C.charcoal, helm: C.charcoal } }, // horned helm
    { name: 'Iron Ravens', realm: 2, emblem: emblem('n', 36, 2, DK.gray, LT.ivory), groups: ['midgard-2'],
        scheme: { body: C.black, arms: C.lightGray, hands: C.black, helm: C.lightGray } }, // raven's head
    { name: 'Mimirs Well', realm: 2, emblem: emblem('n', 27, 0, DK.teal, LT.blue), groups: ['midgard-s1', 'midgard-s2', 'midgard-s3', 'midgard-s4'],
        scheme: { body: C.darkTeal, arms: C.grayBlue, hands: C.darkTeal, helm: C.darkTeal } }, // Odin's eye
    { name: 'Silver Hand', realm: 3, emblem: emblem('h', 77, 1, DK.dkGreen, LT.ivory), groups: ['hibernia'],
        scheme: { body: C.forestGreen, arms: C.lightGray, hands: C.lightGray, helm: C.forestGreen } }, // hands and heart; silver gloves
    { name: 'Fianna', realm: 3, emblem: emblem('h', 39, 2, DK.olive, LT.darkKhaki), groups: ['hibernia-2'],
        scheme: { body: C.oliveGreen, arms: C.tan, hands: C.darkBrown, helm: C.oliveGreen } }, // stag
    { name: 'The Cauldron', realm: 3, emblem: emblem('h', 45, 0, DK.purple, LT.orange), groups: ['hibernia-s1', 'hibernia-s2', 'hibernia-s3', 'hibernia-s4'],
        scheme: { body: C.black, arms: C.darkPurple, hands: C.black, helm: C.darkPurple } }, // cauldron
];
const NIAMH = 'Niamh'; // the user's Mentalist: Silver Hand, all black, light gray gloves, a tiara
const NIAMH_TIARA = 538; // client items.csv 'Tiarra - Celt/Elf' (hce_hat06), undyed; Niamh is an Elf. Asked for on 2026-11-14 in place of the black wizard hat.

// Two colours that go together, for characters in no bot guild.
const PAIRS: [number, number][] = [
    [C.black, C.lightGold], [C.black, C.darkGold], [C.black, C.crimson], [C.black, C.royalRed], [C.black, C.lightGray],
    [C.black, C.royalBlue], [C.black, C.royalPurple], [C.royalBlue, C.lightGold], [C.darkBlue, C.lightGray],
    [C.darkBlue, C.darkGold], [C.royalBlue, C.lightGray], [C.forestGreen, C.tan], [C.forestGreen, C.darkGold],
    [C.forestGreen, C.earthenBrown], [C.royalGreen, C.lightGold], [C.oliveGreen, C.darkBrown], [C.crimson, C.darkGold],
    [C.royalRed, C.charcoal], [C.crimson, C.lightGray], [C.darkPurple, C.lightGold], [C.deepViolet, C.lightGray],
    [C.plum, C.charcoal], [C.darkBrown, C.tan], [C.darkTeal, C.tan], [C.grayBlue, C.charcoal], [C.rust, C.charcoal],
    [C.darkTeal, C.darkGold], [C.sageGreen, C.darkBrown], [C.charcoal, C.lightGold],
];

// Caster headgear and robes: per-class variants of the t24_* templates that gear-template.ts made.
const WIZARD_HAT: Record<number, number> = { 1: 1278, 2: 1280, 3: 1279 }; // pointed steeple hats
const CROWN: Record<number, number> = { 1: 1294, 2: 1291, 3: 1298 }; // quilted crown, spiked circlet, woven crown
const CASTERS = new Set(['wizard', 'sorcerer', 'theurgist', 'cabalist', 'necromancer', 'runemaster', 'spiritmaster', 'bonedancer', 'eldritch', 'enchanter', 'mentalist', 'animist']);
const HEALERS = new Set(['cleric', 'healer', 'shaman', 'druid']);
const MID_ROBE = 97; // dress robe; Albion and Hibernia casters already wear robe 378
const MID_ROBED = new Set(['runemaster', 'spiritmaster', 'bonedancer']);

function hash(s: string): number {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return h >>> 0;
}
const rnd = (key: string) => hash(key) / 2 ** 32;
const pick = <T>(key: string, xs: readonly T[]) => xs[Math.floor(rnd(key) * xs.length)]!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- who goes in which guild --------------------------------------------------------------------------
const charOf = new Map<string, string>();
for (const bot of readdirSync(join(ROOT, 'bots'))) {
    const env = join(ROOT, 'bots', bot, 'bot.env');
    if (!existsSync(env)) continue;
    const m = readFileSync(env, 'utf8').match(/^CHAR_NAME=(.+)$/m);
    if (m && !m[1]!.includes('{')) charOf.set(bot.toLowerCase(), cap(m[1]!.trim()));
}
const groupJson = (g: string) => JSON.parse(readFileSync(join(ROOT, 'groups', g, 'group.json'), 'utf8'));
const charName = (bot: string) => charOf.get(bot.toLowerCase()) ?? cap(bot);
const guildOf = new Map<string, GuildDef>();
const leaders = new Set<string>();
for (const g of GUILDS) // members of the unit (and of every squad) first; the first group's leader leads the guild
    for (const [i, grp] of g.groups.entries()) {
        const j = groupJson(grp);
        for (const m of j.members ?? []) if (!guildOf.has(charName(m.bot))) guildOf.set(charName(m.bot), g);
        if (i === 0 && guildOf.get(charName(j.leader)) === g) leaders.add(charName(j.leader));
    }
for (const realm of [1, 2, 3]) { // the bench: alternately to the realm's two main guilds, in the first unit's bench order
    const [a, b] = GUILDS.filter((g) => g.realm === realm);
    let i = 0;
    for (const m of groupJson(a!.groups[0]!).bench ?? []) {
        const n = charName(m.bot);
        if (n === NIAMH || guildOf.has(n)) continue;
        guildOf.set(n, i++ % 2 === 0 ? a! : b!);
    }
}
guildOf.set(NIAMH, GUILDS.find((g) => g.name === 'Silver Hand')!);

// --- read the live DB ---------------------------------------------------------------------------------
const chars = sql(`select c.Name, c.Realm, c.Level, coalesce(c.GuildID, ''), c.GuildRank from dolcharacters c join account a on a.Name = c.AccountName where a.PrivLevel = 1`);
const charRow = new Map(chars.map(([n, r, l, gid, rank]) => [n!, { realm: Number(r), level: Number(l), guildId: gid!, rank: Number(rank) }]));
const items = sql(`select c.Name, i.Inventory_ID, i.SlotPosition, i.ITemplate_Id, i.Color, i.Emblem, coalesce(t.Object_Type, 0)
  from inventory i join dolcharacters c on c.DOLCharacters_ID = i.OwnerID join account a on a.Name = c.AccountName
  left join itemtemplate t on t.Id_nb = i.ITemplate_Id
  where a.PrivLevel = 1 and i.SlotPosition in (${SLOTS.join(',')}) order by c.Name, i.SlotPosition`);
const existing = new Set(sql(`select GuildName from guild`).map(([n]) => n!));
for (const g of GUILDS) if (existing.has(g.name)) throw new Error(`guild ${g.name} exists already`);
const [rankSource] = sql(`select GuildID from guild where GuildName = 'Crimson Order'`)[0]!;
const variantsExisting = new Set(sql(`select Id_nb from itemtemplate where Id_nb like 't24\\_%\\_hat' or Id_nb like 't24\\_%\\_crown' or Id_nb like 't24\\_%\\_tiara' or Id_nb like 't24\\_%\\_robe'`).map(([n]) => n!));

// --- decide -------------------------------------------------------------------------------------------
const out: string[] = [];
const undo: string[] = [];
const notes: string[] = [];
let guildRows = 0, memberRows = 0, itemRows = 0, templateRows = 0;

out.push(`-- Guilds: copies of Crimson Order's row and ranks with a new id, name, realm and emblem.`);
for (const g of GUILDS) {
    const id = crypto.randomUUID();
    (g as GuildDef & { id: string }).id = id;
    out.push(`DROP TEMPORARY TABLE IF EXISTS tg; CREATE TEMPORARY TABLE tg AS SELECT * FROM guild WHERE GuildID = ${q(rankSource!)};`);
    out.push(`UPDATE tg SET GuildID = ${q(id)}, Guild_ID = UUID(), GuildName = ${q(g.name)}, Realm = ${g.realm}, Emblem = ${g.emblem}, RealmPoints = 0, BountyPoints = 0, Motd = NULL, oMotd = NULL, LastTimeRowUpdated = NOW();`);
    out.push(`INSERT INTO guild SELECT * FROM tg;`);
    out.push(`DROP TEMPORARY TABLE IF EXISTS tr; CREATE TEMPORARY TABLE tr AS SELECT * FROM guildrank WHERE GuildID = ${q(rankSource!)};`);
    out.push(`UPDATE tr SET GuildID = ${q(id)}, GuildRank_ID = UUID(), LastTimeRowUpdated = NOW();`);
    out.push(`INSERT INTO guildrank SELECT * FROM tr;`);
    undo.push(`DELETE FROM guildrank WHERE GuildID = ${q(id)};`, `DELETE FROM guild WHERE GuildID = ${q(id)};`);
    guildRows++;
}
const gid = (g: GuildDef) => (g as GuildDef & { id: string }).id;

out.push(`-- Members (leader rank 0, everyone else 9).`);
for (const [name, g] of guildOf) {
    const row = charRow.get(name);
    if (!row || row.realm !== g.realm) { notes.push(`skip ${name}: ${row ? 'other realm' : 'no character'}`); continue; }
    const rank = leaders.has(name) ? 0 : 9;
    out.push(`UPDATE dolcharacters SET GuildID = ${q(gid(g))}, GuildRank = ${rank} WHERE Name = ${q(name)};`);
    undo.push(`UPDATE dolcharacters SET GuildID = ${row.guildId ? q(row.guildId) : 'NULL'}, GuildRank = ${row.rank} WHERE Name = ${q(name)};`);
    memberRows++;
}

// Variant templates: one per class and kind, made on demand.
const variants = new Map<string, number>(); // new Id_nb -> model
function variant(base: string, kind: 'hat' | 'crown' | 'tiara' | 'robe', model: number): string {
    const id = `${base}_${kind}`;
    if (!variantsExisting.has(id)) variants.set(id, model);
    return id;
}

type Look = { cloak: number; body: number; arms: number; hands: number; helm: number; boots: number; emblem: number; head?: 'hat' | 'crown' | 'tiara'; robe?: boolean; guild?: string };
const looks = new Map<string, Look>();
function lookFor(name: string, realm: number, cls: string | undefined): Look {
    const done = looks.get(name);
    if (done) return done;
    const g = guildOf.get(name);
    let l: Look;
    if (name === NIAMH) {
        l = { cloak: C.black, body: C.black, arms: C.black, hands: C.lightGray, helm: 0, boots: C.black, emblem: g!.emblem, head: 'tiara', robe: true, guild: g!.name };
    } else if (g && g.realm === realm) {
        const s = g.scheme;
        // not everyone in a guild is perfectly matched: an undyed helm or boots now and then
        l = { cloak: s.body, body: s.body, arms: s.arms, hands: s.hands, helm: rnd(`helm0:${name}`) < 0.2 ? 0 : s.helm,
            boots: rnd(`boots0:${name}`) < 0.15 ? 0 : s.body, emblem: g.emblem, guild: g.name };
    } else {
        const [a, b] = pick(`pair:${name}`, PAIRS);
        const [cloak, body] = rnd(`flip:${name}`) < 0.5 ? [a, b] : [b, a];
        const trim = rnd(`trim:${name}`) < 0.5 ? body : cloak;
        l = { cloak, body, arms: body, hands: trim, helm: trim, boots: trim, emblem: 0 };
    }
    if (cls && name !== NIAMH) {
        if (CASTERS.has(cls)) l.head = rnd(`head:${name}`) < 0.6 ? 'hat' : 'crown';
        else if (HEALERS.has(cls)) l.head = rnd(`head:${name}`) < 0.7 ? 'crown' : undefined;
        if (MID_ROBED.has(cls)) l.robe = true;
    }
    looks.set(name, l);
    return l;
}

out.push(`-- Items: dye, emblem on cloak and shield, caster headgear and robes.`);
const classOf = new Map<string, string>();
for (const [name, , slot, tpl] of items) {
    const m = tpl!.match(/^t24_([a-z]+)_\d+$/);
    if (m && (slot === '21' || slot === '25')) classOf.set(name!, m[1]!);
}
for (const [name, id, slotS, tpl, colorS, emblemS, objS] of items) {
    const row = charRow.get(name!)!;
    const slot = Number(slotS);
    const cls = classOf.get(name!);
    const l = lookFor(name!, row.realm, cls);
    let color = Number(colorS), emb = Number(emblemS), template = tpl!;
    switch (slot) {
        case 11: if (Number(objS) !== 42) continue; emb = l.emblem || emb; break; // shields: the guild emblem only
        case 26: color = l.cloak; emb = l.emblem; break;
        case 25: case 27: color = l.body; emb = 0; break;
        case 28: color = l.arms; emb = 0; break;
        case 22: color = l.hands; emb = 0; break;
        case 23: color = l.boots; emb = 0; break;
        case 21: color = l.helm; emb = 0; break;
    }
    const m = tpl!.match(/^(t24_[a-z]+_(21|25))$/);
    if (m && slot === 21 && l.head) template = variant(m[1]!, l.head, l.head === 'tiara' ? NIAMH_TIARA : (l.head === 'hat' ? WIZARD_HAT : CROWN)[row.realm]!);
    if (m && slot === 25 && l.robe && row.realm === 2) template = variant(m[1]!, 'robe', MID_ROBE);
    if (color === Number(colorS) && emb === Number(emblemS) && template === tpl) continue;
    out.push(`UPDATE inventory SET Color = ${color}, Emblem = ${emb}${template !== tpl ? `, ITemplate_Id = ${q(template)}` : ''} WHERE Inventory_ID = ${q(id!)};`);
    undo.push(`UPDATE inventory SET Color = ${colorS}, Emblem = ${emblemS}${template !== tpl ? `, ITemplate_Id = ${q(tpl!)}` : ''} WHERE Inventory_ID = ${q(id!)};`);
    itemRows++;
}
const tplOut: string[] = [`-- Variant templates (before the items that point at them): a copy of the class's t24 template with another model.`];
for (const [vid, model] of variants) {
    const base = vid.replace(/_(hat|crown|tiara|robe)$/, '');
    tplOut.push(`DROP TEMPORARY TABLE IF EXISTS tt; CREATE TEMPORARY TABLE tt AS SELECT * FROM itemtemplate WHERE Id_nb = ${q(base)};`);
    tplOut.push(`UPDATE tt SET Id_nb = ${q(vid)}, ItemTemplate_ID = UUID(), Model = ${model};`);
    tplOut.push(`INSERT INTO itemtemplate SELECT * FROM tt;`);
    undo.push(`DELETE FROM itemtemplate WHERE Id_nb = ${q(vid)};`);
    templateRows++;
}

const stamp = new Date().toISOString();
const summary = `${guildRows} guilds (+${guildRows * 10} ranks), ${memberRows} characters moved into them, ${itemRows} inventory rows, ${templateRows} variant item templates`;
const head = (what: string) => `-- ${what}
-- Generated ${stamp} by docs/bot-looks.gen.ts from the live DB: ${summary}.
-- Run only while the gameserver is stopped (it caches guilds, item templates and logged-in inventories):
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/<this file>
`;
const fwd = [...out.slice(0, 1), ...out.slice(1)];
const itemsStart = fwd.findIndex((s) => s.startsWith('-- Items'));
fwd.splice(itemsStart, 0, ...tplOut);
writeFileSync(join(ROOT, 'docs/bot-looks.sql'), `${head('Bot guilds with emblems, dyed armour, caster hats and robes, and Niamh in black.')}START TRANSACTION;\n${fwd.join('\n')}\nCOMMIT;\n`);
// undo: items first (they point at the variants), then members, then templates and guilds
const order = (s: string) => s.startsWith('UPDATE inventory') ? 0 : s.startsWith('UPDATE dolcharacters') ? 1 : 2;
writeFileSync(join(ROOT, 'docs/bot-looks-undo.sql'), `${head('Undo of docs/bot-looks.sql: rows back as they were, the new guilds and templates removed.')}START TRANSACTION;\n${undo.sort((a, b) => order(a) - order(b)).join('\n')}\nCOMMIT;\n`);

const cn = (c: number) => Object.entries(C).find(([, v]) => v === c)?.[0] ?? (c === 0 ? 'undyed' : String(c));
console.log(summary);
for (const n of notes) console.log(n);
if (process.argv.includes('--looks')) {
    for (const g of GUILDS) console.log(`${g.name}: ${[...guildOf].filter(([, x]) => x === g).map(([n]) => (leaders.has(n) ? `${n}*` : n)).join(', ')}`);
    for (const [n, l] of looks) if (charRow.get(n)!.level >= 20)
        console.log(`${n.padEnd(12)} ${(l.guild ?? '-').padEnd(26)} cloak=${cn(l.cloak)}${l.emblem ? '+emblem' : ''} body=${cn(l.body)} arms=${cn(l.arms)} hands=${cn(l.hands)} helm=${cn(l.helm)}${l.head ? `(${l.head})` : ''} boots=${cn(l.boots)}${l.robe ? ' robe' : ''}`);
}
