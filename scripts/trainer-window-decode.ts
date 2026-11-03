// Decodes the parts of 0x7B TrainerWindow that say what a class can train: codes 0, 3 and 4. It serves
// capture-trainer-windows.ts; bots keep using the client's own decoder for the line index when training.
// Source of truth: server/core/GameServer/packets/Server/PacketLib1105.cs:29-277 (no later PacketLib overrides
// the writers; PacketLib1110.cs:146-153 only appends 0xD8 DelveInfo packets afterwards).
//
// `bytes` is the frame payload, i.e. what follows `u16BE size | u8 code` (GSTCPPacketOut.cs:12-19), the same
// slice client/net/framing.ts hands to WorldModel.handle.

import { PacketReader } from '../client/protocol/buffer';

/** GSTCPPacketOut.Init writes 3 header bytes first, so the server's pak.Length = 3 + payload offset. */
const FRAME_HEADER = 3;
/** PacketLib1105.cs:187: no further spec block once pak.Length reaches this. */
const SPEC_BLOCK_LIMIT = 2045;
/** PacketLib1105.cs:197: no further skill record once pak.Length reaches this. */
const SKILL_RECORD_LIMIT = 2040;
/** PacketLib1105.cs:162: for i = 2..50 inclusive. */
const MIN_LEVEL_TABLE_SIZE = 49;

/** eSkillPage (Skill.cs:224-233), except that abilities are written as a literal 5 (PacketLib1105.cs:95). */
export const SKILL_PAGE = { styles: 2, spells: 3, songs: 4, abilities: 5 } as const;
/** Style.eOpening (Style.cs:37-52). */
export const OPENINGS = ['offensive', 'defensive', 'positional'] as const;
/** Style.eOpeningPosition (Style.cs:56-70), meaningful only for a positional opening. */
export const POSITIONS = ['back', 'side', 'front'] as const;

export interface SpecEntry {
    index: number;
    /** min(50, spec.Level): the character's trained level in the line. */
    level: number;
    /** That + 1; equals the spec-point cost of the next level. */
    nextLevel: number;
    /** Specialization.Name, the display name. KeyName is never on the wire. */
    name: string;
}

export interface BaseSkillRecord {
    /** Required level in the spec line; never a character level. */
    specLevel: number;
    icon: number;
    page: number;
    /** Skill.InternalID: the tooltip id a 0xD8 delve takes (Spell.TooltipId, Style.StyleID, Ability.InternalID). */
    id: number;
    /** The two raw bytes after the page. */
    raw: [number, number];
}
export type SkillRecord =
    | (BaseSkillRecord & { kind: 'ability' })
    | (BaseSkillRecord & { kind: 'spell' | 'song' })
    | (BaseSkillRecord & {
        kind: 'style';
        opening: (typeof OPENINGS)[number] | null;
        /** The low byte of OpeningRequirementValue (a style's DB ID or a position), so an opener's ID can be cut short. */
        openingValue: number;
        position: (typeof POSITIONS)[number] | null;
    })
    /** PacketLib1105.cs:235-245, unreachable with the DB as loaded today. */
    | (BaseSkillRecord & { kind: 'other' });

export interface SpecSkillBlock {
    /** Index into the code 0 spec list. */
    specIndex: number;
    /** How many records the server meant to write; also the size of this spec's code 4 name packet. */
    declaredCount: number;
    /** floor(BaseLevel / 4) for an autotrainable line, else 0 (PacketLib1105.cs:181-185). */
    autotrain: number;
    skills: SkillRecord[];
    /** declaredCount - skills.length: records the server cut at its 2040-byte limit. */
    missing: number;
}

export type WindowPacket =
    | { code: 0; count: number; specPoints: number; specs: SpecEntry[] }
    | {
        code: 3;
        count: number;
        specPoints: number;
        reserved: number;
        /** 49 bytes for levels 2..50, all 0xFF today (PacketLib1105.cs:162-177). */
        minLevelTable: number[];
        blocks: SpecSkillBlock[];
        /** Spec blocks never started because the packet reached its 2045-byte limit. */
        missingBlocks: number;
    }
    | { code: 4; count: number; specPoints: number; startIndex: number; names: string[] }
    /** Realm abilities (codes 1 and 5), or a sub-code SendTrainerWindow does not write: kept undecoded. */
    | { code: number; count: number; points: number; raw: Uint8Array };

function readSkillRecord(r: PacketReader): SkillRecord {
    const specLevel = r.u8();
    const icon = r.u16();
    const page = r.u8();
    const a = r.u8();
    const b = r.u8();
    const id = r.u16();
    const base: BaseSkillRecord = { specLevel, icon, page, id, raw: [a, b] };
    switch (page) {
        case SKILL_PAGE.abilities: // :204-210, line byte 0xFD
            return { ...base, kind: 'ability' };
        case SKILL_PAGE.spells: // :216-222, line byte 0xFE
            return { ...base, kind: 'spell' };
        case SKILL_PAGE.songs: // :216-222, line byte 0xFF
            return { ...base, kind: 'song' };
        case SKILL_PAGE.styles: { // :227-233
            const opening = OPENINGS[a] ?? null;
            return { ...base, kind: 'style', opening, openingValue: b, position: opening === 'positional' ? POSITIONS[b] ?? null : null };
        }
        default: // :238-244
            return { ...base, kind: 'other' };
    }
}

export function decodeWindowPacket(bytes: Uint8Array): WindowPacket {
    const r = new PacketReader(bytes);
    const count = r.u8();
    const points = r.u8(); // (byte) cast: SkillSpecialtyPoints wraps at 256
    const code = r.u8();
    r.u8(); // always 0

    switch (code) {
        case 0: { // :42-54
            const specs: SpecEntry[] = [];
            for (let i = 0; i < count; i++) specs.push({ index: r.u8(), level: r.u8(), nextLevel: r.u8(), name: r.pascal() });
            return { code: 0, count, specPoints: points, specs };
        }
        case 4: { // :126-137, one packet per spec, even an empty one
            const startIndex = r.u8();
            const names: string[] = [];
            for (let i = 0; i < count; i++) names.push(r.pascal());
            return { code: 4, count, specPoints: points, startIndex, names };
        }
        case 3: { // :146-247
            const reserved = r.u8();
            const minLevelTable = [...r.bytes(MIN_LEVEL_TABLE_SIZE)];
            const blocks: SpecSkillBlock[] = [];
            let missingBlocks = 0;
            for (let s = 0; s < count; s++) {
                // Replays the writer's own limit checks. A cut record list is not marked on the wire and the next
                // block's header can follow it directly, so the offset is the only way to tell them apart.
                if (FRAME_HEADER + r.pos >= SPEC_BLOCK_LIMIT) {
                    missingBlocks = count - s;
                    break;
                }
                const specIndex = r.u8();
                const declaredCount = r.u8();
                const autotrain = r.u8();
                const skills: SkillRecord[] = [];
                for (let i = 0; i < declaredCount; i++) {
                    if (FRAME_HEADER + r.pos >= SKILL_RECORD_LIMIT) break;
                    skills.push(readSkillRecord(r));
                }
                blocks.push({ specIndex, declaredCount, autotrain, skills, missing: declaredCount - skills.length });
            }
            return { code: 3, count, specPoints: points, reserved, minLevelTable, blocks, missingBlocks };
        }
        default:
            return { code, count, points, raw: bytes.slice(r.pos) };
    }
}

export interface AssembledSkill {
    /** From the code 4 packet. Known even when the record was cut. */
    name: string;
    /** Global name position (the server's `index`); not wrapped at 256 here. */
    nameIndex: number;
    /** Null when code 3 ran out of room before this skill. */
    record: SkillRecord | null;
}
export interface AssembledSpec extends SpecEntry {
    autotrain: number;
    skills: AssembledSkill[];
}

/**
 * Joins one window's packets in the order the server sends them (0, 1, 4 x specs, 3, 5). The i-th code 4 packet and
 * the block with specIndex i both belong to spec i; names and records line up by position within the spec.
 */
export function assembleWindow(packets: WindowPacket[]): AssembledSpec[] {
    const specs = packets.find((p): p is Extract<WindowPacket, { code: 0 }> => p.code === 0 && 'specs' in p)?.specs ?? [];
    const names = packets.filter((p): p is Extract<WindowPacket, { code: 4 }> => p.code === 4 && 'names' in p);
    const skills = packets.find((p): p is Extract<WindowPacket, { code: 3 }> => p.code === 3 && 'blocks' in p);
    let nameIndex = 0;
    return specs.map((spec, i) => {
        const block = skills?.blocks.find(b => b.specIndex === i);
        const list: AssembledSkill[] = (names[i]?.names ?? []).map((name, j) => ({ name, nameIndex: nameIndex + j, record: block?.skills[j] ?? null }));
        nameIndex += list.length;
        return { ...spec, autotrain: block?.autotrain ?? 0, skills: list };
    });
}

// ── The fixture ─────────────────────────────────────────────────────────────

export interface FixtureLine {
    /** Display name: KeyName is never on the wire. */
    name: string;
    autotrain: boolean;
    /** "kind|specLevel|name|id", in wire order. */
    skills: string[];
}

/** data/fixtures/trainer-windows.json. */
export interface TrainerWindowFixture {
    /** The level of every captured character. */
    level: number;
    /** What server/core and server/db were pinned to. */
    serverCore: string;
    serverDb: string;
    /** Class key -> the window's lines, in wire order. */
    classes: Record<string, FixtureLine[]>;
}

/** One line of the fixture from an assembled window. A cut record would be a hole in it, so that throws. */
export function compactWindow(window: Pick<AssembledSpec, 'name' | 'autotrain' | 'skills'>[]): FixtureLine[] {
    return window.map(line => ({
        name: line.name,
        autotrain: line.autotrain > 0,
        skills: line.skills.map(({ name, record }) => {
            if (!record) throw new Error(`${line.name} / ${name}: the server cut this record from the packet`);
            return `${record.kind}|${record.specLevel}|${name}|${record.id}`;
        }),
    }));
}

/** The fixture's bytes: classes sorted and one skill per line, so that a recapture diffs by the skill. */
export function formatFixture(fixture: TrainerWindowFixture): string {
    const classes = Object.fromEntries(Object.entries(fixture.classes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return `${JSON.stringify({ ...fixture, classes }, null, 1)}\n`;
}
