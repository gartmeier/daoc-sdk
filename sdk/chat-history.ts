// Portions adapted from rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
/**
 * Accumulated chat history, shared by the SDK and the gateway.
 *
 * The client keeps the last 100 messages in every BotWorldState snapshot.
 * Reading only the latest snapshot means anything older is gone after a busy
 * minute of combat spam. This class merges each snapshot into a persistent,
 * deduplicated buffer keyed by GameMessage.id (monotonic per client process),
 * so callers retain the last {@link CHAT_HISTORY_LIMIT} messages seen.
 *
 * A snapshot whose newest id is below our newest id means the client process
 * restarted and its id counter began again: nothing in it can overlap.
 */

import type { ChatType, GameMessage } from './types';

/** Messages retained, independent of the client's 100-deep snapshot window. */
export const CHAT_HISTORY_LIMIT = 500;

/** Chat spoken by players (as opposed to system, combat and spell messages). */
export const PLAYER_CHAT_TYPES: readonly ChatType[] = [
    'say', 'send', 'group', 'guild', 'officer', 'alliance', 'broadcast', 'chat', 'lfg', 'trade', 'emote',
];

const PLAYER_CHAT_SET = new Set<ChatType>(PLAYER_CHAT_TYPES);

export function isPlayerChat(type: ChatType): boolean {
    return PLAYER_CHAT_SET.has(type);
}

/**
 * True when the message is our own speech echoed back ("You say, ...",
 * "You send, ... to Bob.") or carries our name as sender.
 */
export function isOwnMessage(message: GameMessage, playerName?: string | null): boolean {
    const sender = message.sender?.toLowerCase() ?? null;
    if (sender === 'you') return true;
    if (sender && playerName && sender === playerName.toLowerCase()) return true;
    return /^You (say|send|tell|whisper|shout|emote|group|guild|officer|alliance|broadcast)\b/i.test(message.text);
}

/** Speaker of a '<name> says, "..."' line: the client's parsed sender, else read from the text. */
function speakerOf(message: GameMessage): string | null {
    if (message.sender) return message.sender;
    return /^(.+?) (?:says|sends|shouts|yells|whispers|tells you|asks|replies|wishes), "/.exec(message.text)?.[1] ?? null;
}

const normalizeName = (name: string) => name.toLowerCase().replace(/^the /, '');

/**
 * Chat that showChat=false hides: player-chat types spoken by other players. Kept are our own
 * echoes ("You say, ..."), popup text, and NPC speech: NPCs talk through GameNPC.SayTo, which
 * sends CT_Say (GameNPC.cs:2607-2608; trainers in GameTrainer.cs:414), so it arrives as type
 * 'say' and bot.talkTo/whisper/say need to see it. `npcNames` are the nearby NPCs' names.
 */
export function isOtherPlayersChat(message: GameMessage, npcNames: Iterable<string>, playerName?: string | null): boolean {
    if (!isPlayerChat(message.type) || message.popup) return false;
    if (isOwnMessage(message, playerName)) return false;
    const speaker = speakerOf(message);
    if (speaker) {
        const who = normalizeName(speaker);
        for (const n of npcNames) if (normalizeName(n) === who) return false;
    }
    return true;
}

export class ChatHistory {
    private messages: GameMessage[] = [];
    private totalRecorded = 0;
    private readonly limit: number;

    constructor(limit: number = CHAT_HISTORY_LIMIT) {
        this.limit = limit;
    }

    /**
     * Total messages ever recorded (monotonic, unaffected by trimming). Read
     * this as a cursor, then pass it to {@link since} to get what came after.
     */
    get seen(): number {
        return this.totalRecorded;
    }

    /**
     * Merge a chronological snapshot into the history. Returns the messages
     * that were genuinely new (also chronological).
     */
    record(snapshot: GameMessage[]): GameMessage[] {
        if (!snapshot || snapshot.length === 0) return [];

        const last = this.messages[this.messages.length - 1];
        let fresh: GameMessage[];
        if (!last) {
            fresh = snapshot.slice();
        } else if (snapshot[snapshot.length - 1]!.id < last.id) {
            // Client restarted: its id counter began again.
            fresh = snapshot.slice();
        } else {
            fresh = snapshot.filter(m => m.id > last.id);
        }

        if (fresh.length > 0) {
            this.messages.push(...fresh);
            this.totalRecorded += fresh.length;
            if (this.messages.length > this.limit) {
                this.messages.splice(0, this.messages.length - this.limit);
            }
        }
        return fresh;
    }

    /** All retained messages, oldest first. */
    all(): GameMessage[] {
        return this.messages;
    }

    /**
     * Messages recorded after a cursor previously read from {@link seen},
     * oldest first. Overflow beyond the retained limit is silently gone.
     */
    since(cursor: number): GameMessage[] {
        const missed = this.totalRecorded - cursor;
        if (missed <= 0) return [];
        return this.messages.slice(Math.max(0, this.messages.length - missed));
    }
}
