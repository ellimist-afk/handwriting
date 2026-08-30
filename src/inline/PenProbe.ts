/**
 * Pen spatial/latency probe: instrumentation for "the ink is not glued to
 * the nib".
 *
 * This measures the REAL production path. Nothing here reimplements the
 * pipeline; the overlay hands it the values it actually used, and the probe's
 * job is to make the chain visible and to prove (or disprove) that the
 * mapping is lossless:
 *
 *   clientX/Y  ->  note space  ->  drawn head endpoint  ->  back to client
 *
 * If the reconstructed client coordinate equals the original, every
 * coordinate stage (rect, ZoomScale, camera, builder dedupe, smoother head)
 * is spatially exact and the felt gap is delivery or presentation. If it does
 * NOT, the delta names the broken stage.
 *
 * Two on-screen markers make the same comparison visible on the Surface,
 * where the physical nib is the ground truth the software cannot see:
 *
 *   RED   the raw pointer, positioned straight from event.clientX/Y with
 *         position:fixed. It deliberately bypasses every piece of code
 *         under test (no rect, no scale, no camera, no canvas transform).
 *   CYAN  the drawn head endpoint, mapped BACK out of note space through the
 *         production transforms.
 *
 * Reading them: nib==red==cyan but ink trails => presentation/compositor.
 * red behind the nib => input delivery. cyan away from red => a mapping bug.
 */

export type ProbeSource = "down" | "rawupdate" | "move" | "coalesced";

export interface ProbeEntry {
	/** performance.now() when Handwriting handled it. */
	at: number;
	source: ProbeSource;
	/** Raw event coordinates, untouched. */
	clientX: number;
	clientY: number;
	/** event.timeStamp, and how old the event was when we ran. */
	eventTs: number;
	deliveryAgeMs: number;
	/** How many coalesced samples arrived in this delivery. */
	coalesced: number;
	/** Was this sample accepted by the builder, or deduped? */
	accepted: boolean;
	/** Note-space coordinate the pipeline produced for it. */
	noteX: number;
	noteY: number;
	/** The endpoint actually submitted for drawing (smoother head `to`). */
	headX: number;
	headY: number;
	/** Head endpoint mapped back out to client space. */
	backX: number;
	backY: number;
	/** |original client - reconstructed client|, in CSS px. */
	errPx: number;
	/** Distance from the raw pointer to the drawn endpoint, in CSS px. */
	tipGapPx: number;
}

export interface ProbeGeometry {
	rectLeft: number;
	rectTop: number;
	scale: number;
	dpr: number;
	backing: number;
	canvasCssW: number;
	canvasCssH: number;
	canvasBackingW: number;
	canvasBackingH: number;
	camX: number;
	camY: number;
	camZoom: number;
	contentLeft: number;
	documentTop: number;
	desynchronizedRequested: boolean;
	desynchronizedActual: string;
}

const MAX_ENTRIES = 600;

let enabled = false;
let entries: ProbeEntry[] = [];
let geometry: ProbeGeometry | null = null;
let strokeCount = 0;
let rawMarker: HTMLElement | null = null;
let mappedMarker: HTMLElement | null = null;

export function isPenProbeEnabled(): boolean {
	return enabled;
}

export function setPenProbeEnabled(on: boolean): void {
	enabled = on;
	if (!on) hideProbeMarkers();
}

export function clearPenProbe(): void {
	entries = [];
	strokeCount = 0;
	geometry = null;
}

export function noteProbeStroke(): void {
	if (enabled) strokeCount++;
}

export function setProbeGeometry(g: ProbeGeometry): void {
	if (enabled) geometry = g;
}

export function recordProbe(entry: ProbeEntry): void {
	if (!enabled) return;
	entries.push(entry);
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

// ---- on-screen markers ------------------------------------------------------

function makeMarker(color: string, size: number): HTMLElement {
	const el = document.body.createDiv();
	el.setCssStyles({
		position: "fixed",
		left: "0px",
		top: "0px",
		width: `${size}px`,
		height: `${size}px`,
		marginLeft: `${-size / 2}px`,
		marginTop: `${-size / 2}px`,
		borderRadius: "50%",
		border: `1.5px solid ${color}`,
		boxSizing: "border-box",
		pointerEvents: "none",
		zIndex: "99999",
		willChange: "transform",
	});
	return el;
}

/**
 * The raw pointer, straight from the event. Deliberately naive: `position:
 * fixed` + clientX/clientY, so it shares NO code with the path being tested.
 */
export function markRawPointer(clientX: number, clientY: number): void {
	if (!enabled) return;
	if (!rawMarker) rawMarker = makeMarker("#ff2d55", 15);
	rawMarker.setCssStyles({ transform: `translate(${clientX}px, ${clientY}px)`, display: "" });
}

/** The drawn head endpoint, mapped back out through the production transforms. */
export function markMappedTip(clientX: number, clientY: number): void {
	if (!enabled) return;
	if (!mappedMarker) mappedMarker = makeMarker("#00d4ff", 9);
	mappedMarker.setCssStyles({ transform: `translate(${clientX}px, ${clientY}px)`, display: "" });
}

export function hideProbeMarkers(): void {
	if (rawMarker) rawMarker.setCssStyles({ display: "none" });
	if (mappedMarker) mappedMarker.setCssStyles({ display: "none" });
}

export function destroyProbeMarkers(): void {
	rawMarker?.remove();
	mappedMarker?.remove();
	rawMarker = null;
	mappedMarker = null;
}

// ---- report -----------------------------------------------------------------

function stats(values: number[]): { min: number; max: number; mean: number; p95: number } {
	if (values.length === 0) return { min: 0, max: 0, mean: 0, p95: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
		mean: sum / values.length,
		p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
	};
}

function fmt(s: { min: number; max: number; mean: number; p95: number }, unit: string): string {
	return `min ${s.min.toFixed(2)}${unit}  mean ${s.mean.toFixed(2)}${unit}  p95 ${s.p95.toFixed(2)}${unit}  max ${s.max.toFixed(2)}${unit}`;
}

export function formatPenProbe(): string {
	if (entries.length === 0) {
		return "Handwriting pen probe: no samples. Enable the probe, then draw.";
	}
	const err = stats(entries.map((e) => e.errPx));
	const gap = stats(entries.map((e) => e.tipGapPx));
	const age = stats(entries.map((e) => e.deliveryAgeMs));
	const coal = stats(entries.map((e) => e.coalesced));
	const deduped = entries.filter((e) => !e.accepted).length;
	const bySource = new Map<string, number>();
	for (const e of entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);

	const lines: string[] = [
		`Handwriting pen probe: ${entries.length} sample(s), ${strokeCount} stroke(s)`,
		"",
		"VERDICT INPUTS",
		`  mapping round-trip error : ${fmt(err, "px")}`,
		`     (client -> note -> drawn head -> client. ~0 means every coordinate`,
		`      stage is exact and the felt gap is delivery or presentation.)`,
		`  raw pointer -> drawn tip : ${fmt(gap, "px")}`,
		`     (how far the newest drawn endpoint sits from the newest raw`,
		`      pointer. Should equal the dedupe threshold at most.)`,
		`  event delivery age       : ${fmt(age, "ms")}`,
		`     (event.timeStamp -> our handler. Large = input delivery lag.)`,
		`  coalesced per delivery   : ${fmt(coal, "")}`,
		`  deduped samples          : ${deduped} / ${entries.length}`,
		`  sources                  : ${[...bySource].map(([k, v]) => `${k}=${v}`).join("  ")}`,
		"",
	];

	if (geometry) {
		const g = geometry;
		lines.push(
			"GEOMETRY (at last pen-down)",
			`  overlay rect left/top : ${g.rectLeft.toFixed(2)} / ${g.rectTop.toFixed(2)}`,
			`  effective scale       : ${g.scale}`,
			`  devicePixelRatio      : ${g.dpr}   canvas backing factor: ${g.backing}`,
			`  canvas css            : ${g.canvasCssW.toFixed(2)} x ${g.canvasCssH.toFixed(2)}`,
			`  canvas backing store  : ${g.canvasBackingW} x ${g.canvasBackingH}`,
			`  camera origin/zoom    : ${g.camX.toFixed(2)}, ${g.camY.toFixed(2)} @ ${g.camZoom}`,
			`  contentLeft / docTop  : ${g.contentLeft.toFixed(2)} / ${g.documentTop.toFixed(2)}`,
			`  desynchronized        : requested ${g.desynchronizedRequested}, actual ${g.desynchronizedActual}`,
			""
		);
	}

	lines.push(
		"LAST SAMPLES (newest last)",
		"  t(ms)   src         client x,y            note x,y            head x,y            back x,y            err   gap   age  coal  acc"
	);
	const tail = entries.slice(-60);
	const t0 = tail[0]!.at;
	for (const e of tail) {
		lines.push(
			`  ${(e.at - t0).toFixed(1).padStart(7)}  ${e.source.padEnd(10)}  ` +
				`${e.clientX.toFixed(2).padStart(8)},${e.clientY.toFixed(2).padStart(8)}  ` +
				`${e.noteX.toFixed(2).padStart(8)},${e.noteY.toFixed(2).padStart(8)}  ` +
				`${e.headX.toFixed(2).padStart(8)},${e.headY.toFixed(2).padStart(8)}  ` +
				`${e.backX.toFixed(2).padStart(8)},${e.backY.toFixed(2).padStart(8)}  ` +
				`${e.errPx.toFixed(2).padStart(5)} ${e.tipGapPx.toFixed(2).padStart(5)} ` +
				`${e.deliveryAgeMs.toFixed(1).padStart(5)} ${String(e.coalesced).padStart(4)} ` +
				`${e.accepted ? "  y" : "  n"}`
		);
	}
	return lines.join("\n");
}
