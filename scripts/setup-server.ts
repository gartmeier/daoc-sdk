#!/usr/bin/env bun
// Applies bot-friendly server properties to the local OpenDAoC stack
// (server/docker/docker-compose.yml), restarts the gameserver container and
// waits until it answers the 0xF4 handshake on TCP 10300.
//
//   bun run server:setup                      # apply defaults (xp_rate=3), restart if anything changed
//   bun run server:setup --dry-run            # show what would change
//   bun run server:setup --xp=5 --set starting_money=10000
//   bun run server:setup --gm=myadmin         # PrivLevel 3 for an admin account (NOT for gameplay bots)
//   bun run server:setup --ungm=myadmin       # back to PrivLevel 1
//
// Property keys and types are checked against the [ServerProperty] attributes
// in server/core/GameServer (ServerProperties.cs and scripts/**). Values are
// stored the way ServerProperties.Load expects them (ServerProperties.cs:2613-2645):
// bools as True/False, numbers in en-US format.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
export const COMPOSE_FILE = join(ROOT, 'server', 'docker', 'docker-compose.yml');
const GAMESERVER_SRC = join(ROOT, 'server', 'core', 'GameServer');

// ── Server property metadata (from C#) ──────────────────────────────────────

export type PropType = 'bool' | 'int' | 'double' | 'string' | 'long' | 'uint' | 'ushort' | 'byte' | 'float' | 'short';

export interface PropertyDef {
    category: string;
    key: string;
    description: string;
    /** DefaultValue as ServerProperties.InitProperties stores it (bool -> True/False, double en-US). */
    defaultValue: string;
    type: PropType;
    /**
     * Type of the DefaultValue literal. ServerProperties.Load converts the DB string with
     * Convert.ChangeType(value, attrib.DefaultValue.GetType()) (ServerProperties.cs:2632), so this,
     * not the field type, decides what the server accepts: e.g. `double lord_autoset_con_multiplier`
     * has default `0` (int), and "1.5" is rejected at load.
     */
    loadType: PropType;
    field: string;
    file: string;
}

/** C# type of an attribute default literal: "x" string, true bool, (ushort)5, 1.0 double, 1f float, 5L long, 5 int. */
export function literalType(raw: string, fallback: PropType): PropType {
    const s = raw.trim();
    if (s.startsWith('"')) return 'string';
    if (s === 'true' || s === 'false') return 'bool';
    const cast = /^\((\w+)\)/.exec(s)?.[1];
    if (cast) return (['bool', 'int', 'double', 'string', 'long', 'uint', 'ushort', 'byte', 'float', 'short'].includes(cast) ? cast : fallback) as PropType;
    if (/\d[lL]\b/.test(s)) return 'long';
    if (/\d[fF]\b/.test(s)) return 'float';
    if (/\d[dD]\b/.test(s) || /\d\.\d/.test(s)) return 'double';
    if (/^-?[\d\s*+()-]+$/.test(s)) return 'int';
    return fallback;
}

function unescapeCs(s: string): string {
    return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** Parse every `[ServerProperty("cat", "key", "desc", default)] public static T FIELD;` in a C# source. */
export function parseServerProperties(src: string, file = ''): PropertyDef[] {
    const out: PropertyDef[] = [];
    const re = /\[ServerProperty\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*((?:"(?:[^"\\]|\\.)*")|[^\]"\n]*?)\s*\)\](?:[ \t]*\/\/[^\n]*)?\s*public\s+static\s+(?:readonly\s+)?(\w+)\s+(\w+)/g;
    for (const m of src.matchAll(re)) {
        const type = m[5]! as PropType;
        let raw = m[4]!.trim();
        const loadType = literalType(raw, type);
        if (raw.startsWith('"')) raw = unescapeCs(raw.slice(1, -1));
        else {
            // Casts, literal suffixes and constant products: (ushort)30000, 1.0f, 100L * 100L * 100L
            raw = raw.replace(/^\(\w+\)\s*/, '').replace(/(\d)[fFdDmMuUlL]+\b/g, '$1');
            // Arithmetic-only charset, so evaluating it is safe.
            if (/[*+]/.test(raw) && /^[\d\s.*+()-]+$/.test(raw)) raw = String(Function(`return (${raw});`)());
        }
        let defaultValue = raw;
        if (type === 'bool') defaultValue = raw === 'true' ? 'True' : 'False';
        else if (type === 'double' || type === 'float') defaultValue = String(Number(raw));
        out.push({ category: m[1]!, key: m[2]!, description: unescapeCs(m[3]!), defaultValue, type, loadType, field: m[6]!, file });
    }
    return out;
}

function walkCs(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walkCs(p, out);
        else if (e.endsWith('.cs')) out.push(p);
    }
    return out;
}

export function loadPropertyDefs(dir = GAMESERVER_SRC): Map<string, PropertyDef> {
    const defs = new Map<string, PropertyDef>();
    if (!existsSync(dir)) return defs;
    for (const f of walkCs(dir)) {
        const src = readFileSync(f, 'utf8');
        if (!src.includes('[ServerProperty(')) continue;
        for (const d of parseServerProperties(src, f.slice(ROOT.length + 1).replace(/\\/g, '/'))) defs.set(d.key.toLowerCase(), d);
    }
    return defs;
}

/** Normalise a user value to what Convert.ChangeType(value, defaultType, en-US) accepts; throws on mismatch. */
const INT_RANGE: Partial<Record<PropType, [number, number]>> = {
    byte: [0, 255], short: [-32768, 32767], ushort: [0, 65535], int: [-2147483648, 2147483647], uint: [0, 4294967295],
    long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

export function normaliseValue(def: Pick<PropertyDef, 'key' | 'type'> & { loadType?: PropType }, value: string): string {
    const v = value.trim();
    const type = def.loadType ?? def.type;
    switch (type) {
        case 'bool': {
            const l = v.toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(l)) return 'True';
            if (['false', '0', 'no', 'off'].includes(l)) return 'False';
            break;
        }
        case 'double':
        case 'float':
            if (v !== '' && Number.isFinite(Number(v))) return String(Number(v));
            break;
        case 'string':
            return value;
        default:
            if (/^-?\d+$/.test(v)) {
                // Must fit the literal type (Convert.ChangeType) and the field (reflection SetValue).
                const n = Number(v);
                const ok = [type, def.type].every(t => {
                    const r = INT_RANGE[t];
                    return !r || (n >= r[0] && n <= r[1]);
                });
                if (ok) return v;
            }
    }
    throw new Error(`${def.key}: '${value}' is not a valid ${type}${type !== def.type ? ` (field is ${def.type}, but the server parses the value as the default's type)` : ''}`);
}

// ── Bot-friendly defaults ───────────────────────────────────────────────────

export interface Desired {
    key: string;
    value: string;
    why: string;
}

export function botProperties(xpRate: number): Desired[] {
    return [
        { key: 'time_between_account_creation_sameip', value: '0', why: 'all bots share one NAT IP under Docker Desktop' },
        { key: 'total_accounts_allowed_sameip', value: '1000', why: 'default 20 accounts per IP' },
        { key: 'allow_auto_account_creation', value: 'True', why: 'accounts are created on first login' },
        { key: 'allow_all_realms', value: 'True', why: 'one account may own characters in every realm' },
        { key: 'allow_dual_logins', value: 'True', why: 'several bots per account/IP' },
        { key: 'disable_quit_timer', value: 'True', why: 'instant /quit out of combat' },
        { key: 'player idle kick', value: 'False', why: 'never kick idle bots to the character screen' },
        { key: 'ban_hackers', value: 'False', why: 'protocol mistakes kick instead of ban' },
        { key: 'xp_rate', value: String(xpRate), why: 'faster levelling for test runs' },
    ];
}

// ── Docker / SQL plumbing ───────────────────────────────────────────────────

export interface Ctx {
    compose: string;
    dbPassword: string;
    database: string;
    verbose: boolean;
}

async function run(cmd: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const p = Bun.spawn(cmd, { stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
}

/** Run SQL through the db container's mariadb client; returns tab-separated rows. */
export async function sql(ctx: Ctx, query: string): Promise<string[][]> {
    const r = await run(['docker', 'compose', '-f', ctx.compose, 'exec', '-T', 'db',
        'mariadb', '-uroot', `-p${ctx.dbPassword}`, ctx.database, '-N', '-B', '--default-character-set=utf8mb3'], query);
    if (r.code !== 0) throw new Error(`SQL failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.split(/\r?\n/).filter(l => l.length > 0).map(l => l.split('\t'));
}

export const sqlString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function waitFor<T>(what: string, timeoutMs: number, fn: () => Promise<T | undefined>): Promise<T> {
    const t0 = Date.now();
    let lastErr = '';
    let announced = false;
    while (Date.now() - t0 < timeoutMs) {
        try {
            const v = await fn();
            if (v !== undefined) return v;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
        }
        if (!announced) {
            console.log(`  waiting for ${what}...`);
            announced = true;
        }
        await Bun.sleep(2000);
    }
    throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${lastErr ? `: ${lastErr}` : ''}`);
}

// ── Game server readiness probe ─────────────────────────────────────────────

/** PacketProcessor.CalculateChecksum (packets/Server/PacketProcessor.cs:608-622). */
export function checksum(b: Uint8Array, off: number, len: number): number {
    let v1 = 0x7e, v2 = 0x7e;
    for (let i = off; i < off + len; i++) {
        v1 = (v1 + b[i]!) & 0xff;
        v2 = (v2 + v1) & 0xff;
    }
    return (v2 - ((v1 + v2) << 8)) & 0xffff;
}

/** 0xF4 CryptKeyRequest for 1.127, client type 0x06 (CryptKeyRequestHandler.cs:31-61; 12-byte header GSPacketIn.cs:101-114). */
export function cryptKeyRequest(): Uint8Array {
    const b = new Uint8Array(19);
    b.set([0x00, 0x07, 0, 0, 0, 0, 0, 0, 0x00, 0xf4, 0x06, 0x01, 0x01, 0x1b, 0x61, 0x00, 0x00]);
    const c = checksum(b, 0, 17);
    b[17] = c >> 8;
    b[18] = c & 0xff;
    return b;
}

/**
 * True when the game server answers 0xF4 with 0x22 CryptKey. A plain TCP
 * connect is not enough: Docker's port proxy accepts connections even while
 * the server inside the container is still loading the world.
 */
export async function probeGameServer(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        let done = false;
        let buf = new Uint8Array(0);
        const finish = (ok: boolean, sock?: { end(): void }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock?.end(); } catch { /* ignore */ }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false, socketRef), timeoutMs);
        let socketRef: { end(): void } | undefined;
        Bun.connect({
            hostname: host,
            port,
            socket: {
                open(s) {
                    socketRef = s;
                    s.setNoDelay(true);
                    s.write(cryptKeyRequest());
                },
                data(s, chunk) {
                    const merged = new Uint8Array(buf.length + chunk.length);
                    merged.set(buf);
                    merged.set(chunk, buf.length);
                    buf = merged;
                    if (buf.length >= 3) finish(buf[2] === 0x22, s);
                },
                close() { finish(false); },
                error() { finish(false); },
                connectError() { finish(false); },
            },
        }).catch(() => finish(false));
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

interface Options {
    dryRun: boolean;
    restart: 'auto' | 'always' | 'never';
    xp: number;
    sets: { key: string; value: string }[];
    privLevels: { account: string; level: number }[];
    host: string;
    port: number;
    timeoutMs: number;
    verbose: boolean;
    dbPassword: string;
}

function usage(): never {
    console.log(`usage: bun scripts/setup-server.ts [options]
  --dry-run              show changes, touch nothing
  --xp=<rate>            xp_rate (default 3)
  --set <key>=<value>    any other server property (repeatable; key checked against the C# source)
  --gm=<account>[:<lvl>] set account PrivLevel (default 3 = admin). Gameplay bots must stay at 1:
                         mobs never attack PrivLevel > 1.
  --ungm=<account>       set account PrivLevel back to 1
  --restart / --no-restart   force or skip the gameserver restart (default: only if properties changed)
  --timeout=<seconds>    wait limit for DB / game server (default 240)
  --host / --port        game server probe target (default localhost:10300)`);
    process.exit(0);
}

export function parseArgs(argv: string[]): Options {
    const o: Options = {
        dryRun: false, restart: 'auto', xp: 3, sets: [], privLevels: [], host: 'localhost', port: 10300,
        timeoutMs: 240_000, verbose: false, dbPassword: process.env.DAOC_DB_PASSWORD ?? 'daoc-sdk',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const [flag, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
        const val = () => {
            const v = inline ?? argv[++i];
            if (v === undefined) throw new Error(`${flag} needs a value`);
            return v;
        };
        switch (flag) {
            case '--dry-run': o.dryRun = true; break;
            case '--restart': o.restart = 'always'; break;
            case '--no-restart': o.restart = 'never'; break;
            case '--verbose': case '-v': o.verbose = true; break;
            case '--xp': o.xp = Number(val()); if (!(o.xp > 0)) throw new Error('--xp must be > 0'); break;
            case '--set': {
                const kv = val();
                const eq = kv.indexOf('=');
                if (eq <= 0) throw new Error(`--set expects key=value, got '${kv}'`);
                o.sets.push({ key: kv.slice(0, eq), value: kv.slice(eq + 1) });
                break;
            }
            case '--gm': case '--ungm': {
                const [account, lvl] = val().split(':');
                if (!account || !/^[a-zA-Z0-9]+$/.test(account)) throw new Error(`invalid account name '${account}'`);
                const level = flag === '--ungm' ? 1 : lvl === undefined ? 3 : Number(lvl);
                if (![1, 2, 3].includes(level)) throw new Error('PrivLevel must be 1 (player), 2 (GM) or 3 (admin)');
                o.privLevels.push({ account, level });
                break;
            }
            case '--host': o.host = val(); break;
            case '--port': o.port = Number(val()); break;
            case '--timeout': o.timeoutMs = Number(val()) * 1000; break;
            case '--db-password': o.dbPassword = val(); break;
            case '--help': case '-h': usage();
            default: throw new Error(`unknown option ${a} (see --help)`);
        }
    }
    return o;
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const ctx: Ctx = { compose: COMPOSE_FILE, dbPassword: opts.dbPassword, database: 'opendaoc', verbose: opts.verbose };
    const tag = opts.dryRun ? '[dry-run] ' : '';

    // 1. Validate desired properties against the C# source.
    const defs = loadPropertyDefs();
    if (defs.size === 0) console.warn('  warning: server/core/GameServer not found; property keys/types are not verified');
    const desired = [...botProperties(opts.xp), ...opts.sets.map(s => ({ ...s, why: '--set' }))];
    const byKey = new Map<string, Desired & { def?: PropertyDef }>();
    for (const d of desired) {
        const def = defs.get(d.key.toLowerCase());
        if (defs.size && !def) throw new Error(`unknown server property '${d.key}' (no [ServerProperty] with that key in server/core/GameServer)`);
        const value = def ? normaliseValue(def, d.value) : d.value;
        byKey.set(d.key.toLowerCase(), { ...d, key: def?.key ?? d.key, value, def });
    }

    // 2. Wait for the DB and the serverproperty table (created by the gameserver on first boot).
    console.log(`${tag}waiting for MariaDB (docker compose service 'db')...`);
    await waitFor('MariaDB', opts.timeoutMs, async () => ((await sql(ctx, 'SELECT 1;'))[0]?.[0] === '1' ? true : undefined));
    const tableExists = async () => (await sql(ctx, "SHOW TABLES LIKE 'serverproperty';")).length > 0 ? true : undefined;
    if (!(await tableExists())) {
        if (opts.dryRun) console.log(`${tag}serverproperty table does not exist yet (gameserver has never booted)`);
        else await waitFor('the gameserver to create the serverproperty table', opts.timeoutMs, tableExists);
    }
    const columns = (await tableExists().catch(() => undefined))
        ? (await sql(ctx, 'SHOW COLUMNS FROM serverproperty;')).map(r => r[0]!)
        : [];

    // 3. Diff and apply.
    const current = new Map<string, string>();
    if (columns.length) {
        const keys = [...byKey.values()].map(d => sqlString(d.key)).join(',');
        for (const [k, v] of await sql(ctx, `SELECT \`Key\`, Value FROM serverproperty WHERE \`Key\` IN (${keys});`))
            current.set(k!.toLowerCase(), v ?? '');
    }
    const statements: string[] = [];
    let changed = 0;
    console.log(`${tag}server properties:`);
    for (const d of byKey.values()) {
        const cur = current.get(d.key.toLowerCase());
        const same = cur !== undefined && (cur === d.value || (d.def?.type === 'bool' && cur.toLowerCase() === d.value.toLowerCase())
            || ((d.def?.type === 'double' || d.def?.type === 'float') && Number(cur) === Number(d.value)));
        const state = cur === undefined ? 'insert' : same ? 'ok' : 'update';
        console.log(`  ${state.padEnd(6)} ${d.key.padEnd(38)} ${(cur ?? '-').padEnd(8)} -> ${d.value.padEnd(6)} (${d.why})`);
        if (same) continue;
        changed++;
        if (cur !== undefined) {
            statements.push(`UPDATE serverproperty SET Value=${sqlString(d.value)}${columns.includes('LastTimeRowUpdated') ? ', LastTimeRowUpdated=NOW()' : ''} WHERE \`Key\`=${sqlString(d.key)};`);
        } else {
            // Row missing (property added after first boot, or a fresh table): insert it as InitProperties would.
            const row: Record<string, string> = {
                Category: sqlString(d.def?.category ?? 'custom'),
                Key: sqlString(d.key),
                Description: sqlString(d.def?.description ?? ''),
                DefaultValue: sqlString(d.def?.defaultValue ?? d.value),
                Value: sqlString(d.value),
                LastTimeRowUpdated: 'NOW()',
                ServerProperty_ID: 'UUID()',
            };
            const cols = Object.keys(row).filter(c => columns.length === 0 || columns.includes(c));
            statements.push(`INSERT INTO serverproperty (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => row[c]).join(', ')}) ON DUPLICATE KEY UPDATE Value=VALUES(Value);`);
        }
    }

    // 4. PrivLevel changes (account rows exist after the account's first login).
    for (const p of opts.privLevels) {
        const rows = await sql(ctx, `SELECT Name, PrivLevel FROM account WHERE Name=${sqlString(p.account)};`);
        if (!rows.length) {
            console.log(`  account ${p.account}: not found (log in once to auto-create it, then rerun)`);
            continue;
        }
        console.log(`  account ${rows[0]![0]}: PrivLevel ${rows[0]![1]} -> ${p.level}${p.level > 1 ? '  (GM: mobs will not attack it; never use for gameplay bots)' : ''}`);
        statements.push(`UPDATE account SET PrivLevel=${p.level} WHERE Name=${sqlString(p.account)};`);
    }

    if (opts.verbose || opts.dryRun) for (const s of statements) console.log(`  sql: ${s}`);
    if (opts.dryRun) {
        console.log(`${tag}${changed} propert${changed === 1 ? 'y' : 'ies'} would change; gameserver would ${opts.restart === 'never' || (opts.restart === 'auto' && changed === 0) ? 'not ' : ''}be restarted`);
        return;
    }
    if (statements.length) await sql(ctx, statements.join('\n'));

    // 5. Verify what the DB now holds.
    if (columns.length || changed) {
        const keys = [...byKey.values()].map(d => sqlString(d.key)).join(',');
        const after = new Map((await sql(ctx, `SELECT \`Key\`, Value FROM serverproperty WHERE \`Key\` IN (${keys});`)).map(([k, v]) => [k!.toLowerCase(), v ?? '']));
        const bad = [...byKey.values()].filter(d => {
            const v = after.get(d.key.toLowerCase());
            return v === undefined || (v.toLowerCase() !== d.value.toLowerCase() && Number(v) !== Number(d.value));
        });
        if (bad.length) throw new Error(`properties not applied: ${bad.map(b => b.key).join(', ')}`);
        console.log(`  verified ${byKey.size} properties in the DB (${changed} changed)`);
    }

    // 6. Restart the gameserver so ServerProperties.Load re-reads the table.
    const restart = opts.restart === 'always' || (opts.restart === 'auto' && changed > 0);
    if (restart) {
        console.log('restarting gameserver container...');
        const r = await run(['docker', 'compose', '-f', ctx.compose, 'restart', 'gameserver']);
        if (r.code !== 0) throw new Error(`docker compose restart failed: ${r.stderr.trim()}`);
        await Bun.sleep(3000);
    } else {
        console.log('no property changes; gameserver not restarted (use --restart to force)');
    }
    const t0 = Date.now();
    await waitFor(`game server handshake on ${opts.host}:${opts.port}`, opts.timeoutMs,
        async () => ((await probeGameServer(opts.host, opts.port)) ? true : undefined));
    console.log(`game server is accepting logins on ${opts.host}:${opts.port}${restart ? ` (up ${Math.round((Date.now() - t0) / 1000)} s after restart)` : ''}`);
    if (opts.privLevels.length) console.log('PrivLevel changes apply on the account\'s next login.');
}

if (import.meta.main) {
    main().catch(e => {
        console.error(`setup-server: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
