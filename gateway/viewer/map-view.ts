// A top-down canvas map in world units for the viewer pages: camera (pan, zoom
// around the cursor, centre, fit), grid, zone outlines, a label queue that
// skips overlaps, hit testing and pointer handling. The page draws through a
// callback that runs on the next animation frame after invalidate().
//
// The logic is app.ts's, made into a class so a page can own one map without
// module globals; app.ts keeps its own copy for now. World +y is screen down
// (no flip), like the game's region coordinates.

import { arr, clamp, num } from './ui-kit';

export interface ZoneRect { id: number; name: string; xOffset: number; yOffset: number; width: number; height: number }
/** GET /zones/<regionId> */
export interface RegionData {
    regionId: number;
    region: { id: number; name: string; description: string } | null;
    zones: ZoneRect[];
    zonePoints: { id: number; x: number; y: number; targetRegion: number }[];
    bindpoints: { x: number; y: number; radius: number }[];
}

export interface Pt { x: number; y: number }

/** DAoC heading (0 = +Y, clockwise, 4096 per turn) → unit vector in world/screen space. */
export const headingVec = (h: number): Pt => {
    const a = (num(h) * 2 * Math.PI) / 4096;
    return { x: -Math.sin(a), y: Math.cos(a) };
};

/** The smallest round grid step of at least `minWorld` units. */
export function niceStep(minWorld: number): number {
    const steps = [10, 25, 50, 100, 250, 500, 1000, 2000, 4096, 8192, 16384, 32768, 65536];
    return steps.find(s => s >= minWorld) ?? 65536;
}

interface PendingLabel { text: string; x: number; y: number; color: string; force: boolean; prio: number }
interface Hit<T> { sx: number; sy: number; r: number; item: T }

export interface MapViewOptions<T extends { key: string }> {
    /** localStorage key for the zoom level. */
    scaleKey: string;
    /** Draws one frame: hits and labels start empty each time. */
    draw(view: MapView<T>): void;
    /** A click that was not a drag: the nearest hit, or null on empty ground. */
    onClick?(hit: T | null, world: Pt): void;
    onDblClick?(hit: T | null): void;
    /** The pointer moved: the hit under it (null for none) at canvas position sx, sy; null hit and NaN when it left. */
    onHover?(hit: T | null, sx: number, sy: number): void;
    /** The user dragged the map (pages stop following). */
    onPan?(): void;
}

export class MapView<T extends { key: string }> {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;
    readonly cam = { x: 0, y: 0, scale: 0.2 };
    width = 0;
    height = 0;
    /** While the page keeps the camera on something, zooming keeps the centre instead of the point under the cursor. */
    following = false;
    /** Pointer position over the canvas, null when outside. */
    mouse: Pt | null = null;
    /** Key of the hit under the pointer. */
    hoverKey: string | null = null;
    private dirty = true;
    private hits: Hit<T>[] = [];
    private labels: PendingLabel[] = [];
    private drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
    private drawFailed = false;
    private readonly opts: MapViewOptions<T>;

    constructor(canvas: HTMLCanvasElement, opts: MapViewOptions<T>) {
        this.canvas = canvas;
        this.opts = opts;
        this.ctx = canvas.getContext('2d')!;
        try {
            const saved = parseFloat(localStorage.getItem(opts.scaleKey) ?? '');
            if (Number.isFinite(saved) && saved > 0) this.cam.scale = clamp(saved, 0.004, 4);
        } catch {}
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.bindPointer();
    }

    toScreen = (x: number, y: number): Pt => ({ x: (x - this.cam.x) * this.cam.scale + this.width / 2, y: (y - this.cam.y) * this.cam.scale + this.height / 2 });
    toWorld = (sx: number, sy: number): Pt => ({ x: (sx - this.width / 2) / this.cam.scale + this.cam.x, y: (sy - this.height / 2) / this.cam.scale + this.cam.y });

    /** Whether a screen point is on the canvas, with `pad` pixels to spare. */
    onScreen(s: Pt, pad = 30): boolean {
        return s.x >= -pad && s.y >= -pad && s.x <= this.width + pad && s.y <= this.height + pad;
    }

    resize(): void {
        const dpr = window.devicePixelRatio || 1;
        this.width = this.canvas.clientWidth;
        this.height = this.canvas.clientHeight;
        this.canvas.width = Math.max(1, Math.round(this.width * dpr));
        this.canvas.height = Math.max(1, Math.round(this.height * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.dirty = true;
    }

    setScale(next: number, anchor?: Pt): void {
        const scale = clamp(next, 0.004, 4);
        if (anchor && !this.following) {
            const w = this.toWorld(anchor.x, anchor.y);
            this.cam.scale = scale;
            this.cam.x = w.x - (anchor.x - this.width / 2) / scale;
            this.cam.y = w.y - (anchor.y - this.height / 2) / scale;
        } else {
            this.cam.scale = scale;
        }
        try { localStorage.setItem(this.opts.scaleKey, String(this.cam.scale)); } catch {}
        this.dirty = true;
    }

    zoom(factor: number): void { this.setScale(this.cam.scale * factor); }

    centre(x: number, y: number): void {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x === this.cam.x && y === this.cam.y) return;
        this.cam.x = x;
        this.cam.y = y;
        this.dirty = true;
    }

    /** Centre on the points and zoom so they all fit, `margin` pixels from the edges (never closer than 0.4 px per unit). */
    fit(points: Pt[], margin = 80): void {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        if (minX === Infinity) return;
        this.centre((minX + maxX) / 2, (minY + maxY) / 2);
        const w = maxX - minX, h = maxY - minY;
        if ((w > 0 || h > 0) && this.width > 2 * margin && this.height > 2 * margin) {
            this.setScale(Math.min((this.width - 2 * margin) / Math.max(1, w), (this.height - 2 * margin) / Math.max(1, h), 0.4));
        }
        this.dirty = true;
    }

    invalidate(): void { this.dirty = true; }

    /** Start the animation-frame loop; it draws only after invalidate(). */
    start(): void {
        const frame = () => {
            if (this.dirty) this.render();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    private render(): void {
        this.dirty = false;
        this.hits = [];
        this.labels = [];
        try {
            this.opts.draw(this);
        } catch (error) {
            // The page guards its own passes; this keeps the loop alive whatever slips through.
            if (!this.drawFailed) { this.drawFailed = true; console.error('viewer: map draw failed', error); }
        }
        this.ctx.setLineDash([]);
        this.ctx.globalAlpha = 1;
    }

    /** Grid lines about every 70 px; returns the step in world units. */
    drawGrid(): number {
        const { ctx } = this;
        const step = niceStep(70 / this.cam.scale);
        const tl = this.toWorld(0, 0);
        const br = this.toWorld(this.width, this.height);
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
            const sx = Math.round(this.toScreen(x, 0).x) + 0.5;
            ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height);
        }
        for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
            const sy = Math.round(this.toScreen(0, y).y) + 0.5;
            ctx.moveTo(0, sy); ctx.lineTo(this.width, sy);
        }
        ctx.stroke();
        return step;
    }

    /** Zone rects (the current one highlighted), zone exits and bind points of a region. */
    drawZones(region: RegionData | null, currentZoneId: number | null): void {
        if (!region) return;
        const { ctx } = this;
        const scale = this.cam.scale;
        ctx.font = '12px system-ui, sans-serif';
        for (const z of arr(region.zones)) {
            const a = this.toScreen(z.xOffset, z.yOffset);
            const w = z.width * scale;
            const h = z.height * scale;
            if (a.x > this.width || a.y > this.height || a.x + w < 0 || a.y + h < 0) continue;
            const current = currentZoneId !== null && z.id === currentZoneId;
            ctx.fillStyle = current ? 'rgba(90,169,255,0.035)' : 'rgba(255,255,255,0.012)';
            ctx.fillRect(a.x, a.y, w, h);
            ctx.strokeStyle = current ? 'rgba(90,169,255,0.55)' : 'rgba(180,190,200,0.28)';
            ctx.lineWidth = current ? 2 : 1;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(a.x, a.y, w, h);
            ctx.setLineDash([]);
            const lx = clamp(a.x + 6, 6, Math.max(6, a.x + w - 120));
            // Keep the label clear of the legend in the top-left corner.
            const ly = clamp(a.y + 16, 56, Math.max(56, a.y + h - 6));
            ctx.fillStyle = current ? 'rgba(140,195,255,0.85)' : 'rgba(180,190,200,0.5)';
            ctx.fillText(`${z.name} (${z.id})`, lx, ly);
        }
        for (const zp of arr(region.zonePoints)) {
            const s = this.toScreen(zp.x, zp.y);
            if (!this.onScreen(s, 20)) continue;
            ctx.fillStyle = '#d96cff';
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x + 6, s.y); ctx.lineTo(s.x, s.y + 6); ctx.lineTo(s.x - 6, s.y);
            ctx.closePath();
            ctx.fill();
            if (scale > 0.05) {
                ctx.font = '11px system-ui, sans-serif';
                ctx.fillText(`→ region ${zp.targetRegion}`, s.x + 8, s.y + 4);
            }
        }
        for (const b of arr(region.bindpoints)) {
            const s = this.toScreen(b.x, b.y);
            if (!this.onScreen(s, 50)) continue;
            ctx.strokeStyle = 'rgba(89,212,107,0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(s.x, s.y, Math.max(4, num(b.radius) * scale), 0, Math.PI * 2);
            ctx.stroke();
            if (scale > 0.05) {
                ctx.fillStyle = 'rgba(89,212,107,0.8)';
                ctx.font = '11px system-ui, sans-serif';
                ctx.fillText('bind', s.x + 6, s.y - 6);
            }
        }
    }

    // Labels are queued while drawing shapes and placed afterwards, most important
    // first (forced, then by prio), skipping ones that would overlap a placed one.
    label(text: string, x: number, y: number, color: string, force = false, prio = 3): void {
        this.labels.push({ text, x, y, color, force, prio: force ? -1 : prio });
    }

    flushLabels(): void {
        const { ctx } = this;
        const boxes: { x: number; y: number; w: number; h: number }[] = [];
        this.labels.sort((a, b) => a.prio - b.prio);
        ctx.textAlign = 'center';
        for (const l of this.labels) {
            ctx.font = l.force ? 'bold 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
            const w = ctx.measureText(l.text).width;
            const box = { x: l.x - w / 2 - 2, y: l.y - 11, w: w + 4, h: 13 };
            if (!l.force && boxes.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
            boxes.push(box);
            ctx.fillStyle = 'rgba(10,12,15,0.65)';
            ctx.fillRect(box.x, box.y, box.w, box.h);
            ctx.fillStyle = l.color;
            ctx.fillText(l.text, l.x, l.y);
        }
        ctx.textAlign = 'start';
        this.labels = [];
    }

    /** Register something clickable drawn at screen sx, sy with radius r. */
    hit(sx: number, sy: number, r: number, item: T): void {
        this.hits.push({ sx, sy, r, item });
    }

    /** The nearest hit within its radius (at least 9 px) of a screen point. */
    hitTest(sx: number, sy: number): T | null {
        let best: Hit<T> | null = null;
        let bestD = Infinity;
        for (const h of this.hits) {
            const d = Math.hypot(h.sx - sx, h.sy - sy);
            if (d <= Math.max(9, h.r + 4) && d < bestD) { best = h; bestD = d; }
        }
        return best?.item ?? null;
    }

    private bindPointer(): void {
        const { canvas } = this;
        canvas.addEventListener('pointerdown', ev => {
            if (ev.button !== 0) return;
            canvas.setPointerCapture(ev.pointerId);
            this.drag = { x: ev.offsetX, y: ev.offsetY, camX: this.cam.x, camY: this.cam.y, moved: false };
        });
        canvas.addEventListener('pointermove', ev => {
            this.mouse = { x: ev.offsetX, y: ev.offsetY };
            const drag = this.drag;
            if (drag) {
                const dx = ev.offsetX - drag.x;
                const dy = ev.offsetY - drag.y;
                if (!drag.moved && Math.hypot(dx, dy) > 4) {
                    drag.moved = true;
                    this.following = false;
                    this.opts.onPan?.();
                    canvas.classList.add('panning');
                }
                if (drag.moved) {
                    this.cam.x = drag.camX - dx / this.cam.scale;
                    this.cam.y = drag.camY - dy / this.cam.scale;
                    this.opts.onHover?.(null, NaN, NaN);
                    this.dirty = true;
                    return;
                }
            }
            const hit = this.hitTest(ev.offsetX, ev.offsetY);
            this.hoverKey = hit?.key ?? null;
            this.opts.onHover?.(hit, ev.offsetX, ev.offsetY);
            // Redraw for the hover ring and the HUD's cursor position.
            this.dirty = true;
        });
        canvas.addEventListener('pointerup', ev => {
            const drag = this.drag;
            this.drag = null;
            canvas.classList.remove('panning');
            if (!drag || drag.moved) return;
            this.opts.onClick?.(this.hitTest(ev.offsetX, ev.offsetY), this.toWorld(ev.offsetX, ev.offsetY));
        });
        canvas.addEventListener('pointerleave', () => {
            this.mouse = null;
            this.hoverKey = null;
            this.opts.onHover?.(null, NaN, NaN);
            this.dirty = true;
        });
        canvas.addEventListener('dblclick', ev => this.opts.onDblClick?.(this.hitTest(ev.offsetX, ev.offsetY)));
        canvas.addEventListener('wheel', ev => {
            ev.preventDefault();
            this.setScale(this.cam.scale * Math.pow(1.0015, -ev.deltaY), { x: ev.offsetX, y: ev.offsetY });
        }, { passive: false });
    }
}
