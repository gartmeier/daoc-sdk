// Minimal parser for the OpenDAoC-Database mysqldump files
// (server/db/opendaoc-db-core/*.sql): extracts rows from
// `REPLACE INTO `table` (`col`, ...) VALUES (...), (...);` statements.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DB_DIR = join(import.meta.dir, '..', 'server', 'db', 'opendaoc-db-core');

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

/** Parse every REPLACE/INSERT INTO statement in a dump file into row objects. */
export function parseSqlDump(sql: string): SqlRow[] {
    const rows: SqlRow[] = [];
    const header = /(?:REPLACE|INSERT) INTO `[^`]+` \(([^)]*)\) VALUES\s*/g;
    let m: RegExpExecArray | null;
    while ((m = header.exec(sql)) !== null) {
        const columns = m[1]!.split(',').map(c => c.trim().replace(/`/g, ''));
        let i = header.lastIndex;
        // Read tuples until the terminating ';'
        while (i < sql.length) {
            while (i < sql.length && /\s|,/.test(sql[i]!)) i++;
            if (sql[i] === ';' || i >= sql.length) break;
            if (sql[i] !== '(') break;
            i++;
            const values: SqlValue[] = [];
            while (i < sql.length) {
                while (sql[i] === ' ') i++;
                const ch = sql[i]!;
                if (ch === "'") {
                    i++;
                    let s = '';
                    while (i < sql.length) {
                        const c = sql[i]!;
                        if (c === '\\') {
                            const n = sql[i + 1]!;
                            s += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '0' ? '\0' : n;
                            i += 2;
                        } else if (c === "'") {
                            if (sql[i + 1] === "'") { s += "'"; i += 2; }
                            else { i++; break; }
                        } else { s += c; i++; }
                    }
                    values.push(s);
                } else {
                    let j = i;
                    while (j < sql.length && sql[j] !== ',' && sql[j] !== ')') j++;
                    const raw = sql.slice(i, j).trim();
                    values.push(raw === 'NULL' ? null : Number(raw));
                    i = j;
                }
                while (sql[i] === ' ') i++;
                if (sql[i] === ',') { i++; continue; }
                if (sql[i] === ')') { i++; break; }
            }
            const row: SqlRow = {};
            columns.forEach((c, k) => { row[c] = values[k] ?? null; });
            rows.push(row);
        }
        header.lastIndex = i;
    }
    return rows;
}

/** Load and parse `<DB_DIR>/<table>.sql`. */
export function loadTable(table: string, dir = DB_DIR): SqlRow[] {
    return parseSqlDump(readFileSync(join(dir, `${table}.sql`), 'utf8'));
}
