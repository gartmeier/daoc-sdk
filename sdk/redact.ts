// Copied from sdk/redact.ts of rs-sdk (https://github.com/MaxBittker/rs-sdk), Copyright (c) 2025 Lost City, MIT License; see LICENSES/rs-sdk-MIT.txt.
/** Keep login URLs useful in diagnostics without exposing their credentials. */
export function redactCredentials(text: string): string {
    return text
        .replace(/([?&](?:password|token|secret|api[_-]?key)=)[^&#\s"'\\]*/gi, '$1[REDACTED]')
        .replace(/(\b(?:wss?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
