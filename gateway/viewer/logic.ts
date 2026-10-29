// DOM-free decisions used by app.ts, kept separate so they can be unit-tested.

/** After a failed /zones fetch, wait this long before asking for the same region again. */
export const REGION_RETRY_MS = 10_000;

/** Whether the page should fetch zone data for `regionId` now. */
export function shouldLoadRegion(
    regionId: number,
    loadedRegionId: number | null,
    loadingRegionId: number | null,
    failure: { regionId: number; at: number } | null,
    now: number,
): boolean {
    if (loadedRegionId === regionId || loadingRegionId === regionId) return false;
    if (failure && failure.regionId === regionId && now - failure.at < REGION_RETRY_MS) return false;
    return true;
}

/** Headers for the gateway's authenticated HTTP routes (/state): the typed password as a bearer token. */
export function authHeaders(password: string): Record<string, string> {
    return password ? { Authorization: `Bearer ${password}` } : {};
}
