// Small browser helpers for the viewer pages: escaping, number guards, time
// formats, bars, a cached section renderer, toasts and a guard for drawing
// passes. Used by group.ts (app.ts keeps its own copies for now). Nothing here
// touches the DOM at import, so tests and other modules can import it freely.

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const REALM_HEX: Record<string, string> = { albion: '#ff5a5a', midgard: '#5a9bff', hibernia: '#59d46b', none: '#cccccc' };

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock HH:MM:SS of a ms epoch; '' for anything else. */
export function clock(ms: unknown): string {
    const t = num(ms);
    if (!t) return '';
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A duration in words: "12 s", "4 m", "2 h 5 m". */
export function dur(ms: number): string {
    const s = Math.max(0, Math.round(num(ms) / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} m`;
    const m = Math.floor(s / 60);
    return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
}

/** "12 s ago" from a timestamp and the current time on the same clock; '' without a timestamp. */
export function ago(at: unknown, now = Date.now()): string {
    const t = num(at);
    return t ? `${dur(now - t)} ago` : '';
}

/** m:ss, or h:mm:ss past an hour, for run-relative times and countdowns. */
export function mmss(ms: number): string {
    const s = Math.max(0, Math.floor(num(ms) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A labelled bar like the bot page's health and power bars. */
export function bar(labelText: string, value: number, max: number, color: string, right?: string): string {
    const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
    return `<div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>`
        + `<div class="label"><span>${esc(labelText)}</span><span>${esc(right ?? `${Math.round(value)} / ${Math.round(max)}`)}</span></div></div>`;
}

/** A thin unlabelled bar for one percentage (member rows). */
export function miniBar(percent: number, color: string, title = ''): string {
    return `<span class="mini-bar" title="${esc(title)}"><i style="width:${clamp(num(percent), 0, 100).toFixed(0)}%;background:${color}"></i></span>`;
}

/**
 * A section renderer: skips identical HTML, keeps the scroll position of every
 * [data-scroll="<key>"] child, and keeps a [data-stick] child at the bottom
 * when it was there (a log that follows new lines until you scroll up).
 */
export function sections(lookup: (id: string) => HTMLElement | null = id => document.getElementById(id)) {
    const cache = new Map<string, string>();
    return (id: string, html: string): void => {
        if (cache.get(id) === html) return;
        const el = lookup(id);
        if (!el) return;
        cache.set(id, html);
        const scrolls = new Map<string, { top: number; atBottom: boolean }>();
        el.querySelectorAll<HTMLElement>('[data-scroll]').forEach(s => {
            scrolls.set(s.dataset.scroll!, { top: s.scrollTop, atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 4 });
        });
        el.innerHTML = html;
        el.querySelectorAll<HTMLElement>('[data-scroll]').forEach(s => {
            const prev = scrolls.get(s.dataset.scroll!);
            if (s.dataset.stick !== undefined && (!prev || prev.atBottom)) s.scrollTop = s.scrollHeight;
            else if (prev) s.scrollTop = prev.top;
        });
    };
}

const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Show a short message in `el` for 3.5 s (red when bad). */
export function toast(el: HTMLElement | null, text: string, bad = false): void {
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.color = bad ? 'var(--bad)' : '';
    const prev = toastTimers.get(el);
    if (prev) clearTimeout(prev);
    toastTimers.set(el, setTimeout(() => { el.style.display = 'none'; }, 3500));
}

const failed = new Set<string>();

/**
 * Run one drawing or rendering pass. A throw (odd data from a newer runner, a
 * bug) is logged once per label and the rest of the page keeps going.
 */
export function safely<T>(label: string, fn: () => T): T | undefined {
    try {
        return fn();
    } catch (error) {
        if (!failed.has(label)) {
            failed.add(label);
            console.error(`viewer: ${label} failed`, error);
        }
        return undefined;
    }
}

/**
 * One map drawing pass under safely(), between ctx.save() and ctx.restore(): an
 * alpha, dash or font a pass leaves behind (an early return, a throw half way)
 * never reaches the next one.
 */
export function drawPass(ctx: { save(): void; restore(): void }, label: string, fn: () => void): void {
    ctx.save();
    try {
        safely(label, fn);
    } finally {
        ctx.restore();
    }
}
