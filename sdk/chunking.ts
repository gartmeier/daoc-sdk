/**
 * Chat message chunking, shared by the SDK's say()/send() and the gateway's
 * HTTP say endpoint. Lives in its own module so the gateway can import it
 * without pulling in the full SDK.
 *
 * DAoC chat travels as a slash command through 0xAF, read server-side with
 * ReadString(255) (GameServer/packets/Client/168/PlayerCommandHandler.cs:15).
 * Strings are CP1252, one byte per char, so the char count is the byte count
 * once the "&say " / "&send <name> " prefix is accounted for.
 */

/** Wire budget for the whole command string (PlayerCommandHandler.cs:15). */
export const MAX_COMMAND_BYTES = 255;

/**
 * Default per-message text cap. Leaves room for "&send " plus a 24-char name
 * and a separator inside the 255-byte command budget.
 */
export const DEFAULT_MAX_MESSAGE_LENGTH = 200;

/**
 * Split text into chunks on word boundaries so each chunk fits `maxLen`
 * chars. Words too big for one chunk are hard-split so nothing is dropped.
 */
export function chunkMessage(text: string, maxLen: number): string[] {
    const limit = Math.max(1, Math.floor(maxLen));
    const chunks: string[] = [];
    let current = '';
    const trimmed = text.trim();
    if (!trimmed) return [];
    for (const word of trimmed.split(/\s+/)) {
        if (word.length > limit) {
            if (current) { chunks.push(current); current = ''; }
            for (let i = 0; i < word.length; i += limit) {
                chunks.push(word.slice(i, i + limit));
            }
            continue;
        }
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= limit) {
            current = candidate;
        } else {
            if (current) chunks.push(current);
            current = word;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}
