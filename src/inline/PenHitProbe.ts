/**
 * Pointer hit probe. Answers "what did the PAGE see at this spot when the
 * pen misbehaved", for regions where pen contact appears to do nothing.
 *
 * While enabled it keeps a small ring of samples:
 *
 *   hover   throttled elementFromPoint stacks under the hovering pen, deduped
 *           by (top element, ~20px cell), so sweeping the pen across a dead
 *           region records what is under it without flooding the ring.
 *   down    every pen pointerdown the router sees (claimed or ignored), with
 *           the event's composedPath, its target, whether a window-capture
 *           listener saw the same contact, and the overlay's own coordinate
 *           context (note-space point, granted extent, scroll position).
 *
 * The report prints, per sample, the element stack with pointer-events /
 * touch-action / z-index / position / overflow (the properties that make a
 * region eat, deflect, or re-arbitrate input; a nested scroll container
 * re-enables panning under the standing guard), plus `inside=YES/NO`
 * against the granted surface extent.
 *
 * RECONSTRUCTION NOTE (2026-08-21): rebuilt from the deployed 2026-08-20
 * hardware build (source lost with its session container); behavior matches.
 */

export interface HitProbeContext {
	noteX: number;
	noteY: number;
	scrollLeft: number;
	scrollTop: number;
	grantedX: number;
	grantedY: number;
	scale: number;
}

interface StackedEl {
	desc: string;
	rect: string;
	pointerEvents: string;
	/** Computed touch-action: a nested scroller re-enables pan here (RC3). */
	touchAction: string;
	zIndex: string;
	position: string;
	overflow: string;
}

interface HitEntry {
	t: number;
	kind: "hover" | "down";
	x: number;
	y: number;
	top: string;
	stack: StackedEl[];
	composed: string[];
	scrollerInPath: boolean;
	globalSaw: boolean;
	routerSaw: boolean;
	claimed: boolean;
	downTarget: string;
	ctx: HitProbeContext | null;
}

const MAX_ENTRIES = 80;
const HOVER_THROTTLE_MS = 200;

let contextProvider: ((clientX: number, clientY: number) => HitProbeContext | null) | null =
	null;

/** The overlay registers this so probe rows carry its coordinate context. */
export function setHitProbeContext(
	fn: ((clientX: number, clientY: number) => HitProbeContext | null) | null
): void {
	contextProvider = fn;
}

const entries: HitEntry[] = [];
let enabled = false;
let lastHoverAt = 0;
let lastHoverKey = "";
/** Window-capture pointerdown seen and not yet matched to a router down. */
let pendingGlobalDown: { id: number; at: number } | null = null;
let windowDownFn: ((e: Event) => void) | null = null;

export function isHitProbeEnabled(): boolean {
	return enabled;
}

export function setHitProbeEnabled(on: boolean): void {
	if (on === enabled) return;
	enabled = on;
	if (on) {
		const fn = (e: Event) => {
			const pe = e as PointerEvent;
			if (pe.pointerType === "pen") {
				pendingGlobalDown = { id: pe.pointerId, at: performance.now() };
			}
		};
		windowDownFn = fn;
		window.addEventListener("pointerdown", fn, { capture: true });
	} else if (windowDownFn) {
		window.removeEventListener("pointerdown", windowDownFn, { capture: true });
		windowDownFn = null;
		pendingGlobalDown = null;
	}
}

export function clearHitProbe(): void {
	entries.length = 0;
	lastHoverKey = "";
}

export function describeEl(el: EventTarget | Element | null | undefined): string {
	if (!el) return "(none)";
	const e = el as Element;
	const cls =
		typeof e.className === "string" && e.className
			? `.${e.className.trim().split(/\s+/).join(".")}`
			: "";
	const id = e.id ? `#${e.id}` : "";
	return `${e.tagName?.toLowerCase?.() ?? "(non-element)"}${id}${cls}`;
}

function describeStacked(el: Element): StackedEl {
	const cs = getComputedStyle(el);
	const r = el.getBoundingClientRect();
	return {
		desc: describeEl(el),
		rect: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
		pointerEvents: cs.pointerEvents,
		touchAction: cs.touchAction,
		zIndex: cs.zIndex,
		position: cs.position,
		overflow: `${cs.overflowX}/${cs.overflowY}`,
	};
}

function stackAt(clientX: number, clientY: number): { top: string; stack: StackedEl[] } {
	const top = document.elementFromPoint(clientX, clientY);
	const all = document.elementsFromPoint(clientX, clientY);
	return { top: describeEl(top), stack: all.slice(0, 8).map(describeStacked) };
}

function record(entry: HitEntry): void {
	entries.push(entry);
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Throttled hover sampler; call from the router's pen-hover path. */
export function hitProbeHover(e: PointerEvent): void {
	if (!enabled) return;
	const now = performance.now();
	if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
	lastHoverAt = now;
	const { top, stack } = stackAt(e.clientX, e.clientY);
	const key = `${top}@${Math.round(e.clientX / 20)},${Math.round(e.clientY / 20)}`;
	if (key === lastHoverKey) return;
	lastHoverKey = key;
	record({
		t: now,
		kind: "hover",
		x: e.clientX,
		y: e.clientY,
		top,
		stack,
		composed: [],
		scrollerInPath: false,
		globalSaw: false,
		routerSaw: false,
		claimed: false,
		downTarget: "",
		ctx: contextProvider?.(e.clientX, e.clientY) ?? null,
	});
}

/** Every pen pointerdown the router received; `claimed` says what it did. */
export function hitProbeDown(e: PointerEvent, claimed: boolean, scrollEl: Element): void {
	if (!enabled) return;
	const { top, stack } = stackAt(e.clientX, e.clientY);
	const path = typeof e.composedPath === "function" ? e.composedPath() : [];
	record({
		t: performance.now(),
		kind: "down",
		x: e.clientX,
		y: e.clientY,
		top,
		stack,
		composed: path.slice(0, 8).map((el) => describeEl(el as Element)),
		scrollerInPath: path.includes(scrollEl),
		globalSaw: pendingGlobalDown !== null && pendingGlobalDown.id === e.pointerId,
		routerSaw: true,
		claimed,
		downTarget: describeEl(e.target),
		ctx: contextProvider?.(e.clientX, e.clientY) ?? null,
	});
	pendingGlobalDown = null;
	lastHoverKey = "";
}

/** A window-capture down the router never received is itself the finding. */
function flushOrphanDown(): void {
	if (!enabled || !pendingGlobalDown) return;
	record({
		t: performance.now(),
		kind: "down",
		x: -1,
		y: -1,
		top: "(orphan: window capture saw a pen pointerdown the router never received)",
		stack: [],
		composed: [],
		scrollerInPath: false,
		globalSaw: true,
		routerSaw: false,
		claimed: false,
		downTarget: "",
		ctx: null,
	});
	pendingGlobalDown = null;
}

export function formatHitReport(): string {
	flushOrphanDown();
	if (entries.length === 0) {
		return (
			"Handwriting pointer hit report: no samples.\n" +
			"Enable 'Dev: toggle pointer hit probe', hover the pen over the spot, then touch down."
		);
	}
	const t0 = entries[0]!.t;
	const lines: string[] = [
		`Handwriting pointer hit report: ${entries.length} sample(s)`,
		`probe ${enabled ? "ON" : "off"}`,
		"",
	];
	for (const e of entries) {
		const at = (e.t - t0).toFixed(0).padStart(7);
		const c = e.ctx;
		lines.push(
			`${at}ms  ${e.kind.toUpperCase().padEnd(5)} client(${e.x.toFixed(0)},${e.y.toFixed(0)})` +
				(c
					? `  note(${c.noteX.toFixed(0)},${c.noteY.toFixed(0)})  granted(${c.grantedX},${c.grantedY})` +
						`  scrollLeft=${c.scrollLeft}  inside=${c.noteX <= c.grantedX && c.noteY <= c.grantedY ? "YES" : "NO"}`
					: "")
		);
		lines.push(`         top: ${e.top}`);
		if (e.kind === "down") {
			lines.push(
				`         window-capture saw it: ${e.globalSaw}   router saw it: ${e.routerSaw}   CLAIMED: ${e.claimed}`
			);
			lines.push(`         pointerdown target: ${e.downTarget}`);
			lines.push(`         scroller in composed path: ${e.scrollerInPath}`);
			if (e.composed.length) {
				lines.push(`         composedPath: ${e.composed.join(" > ")}`);
			}
		}
		for (const s of e.stack) {
			lines.push(
				`           - ${s.desc.padEnd(34)} rect[${s.rect}] pe=${s.pointerEvents} ta=${s.touchAction} z=${s.zIndex} pos=${s.position} ovf=${s.overflow}`
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}
