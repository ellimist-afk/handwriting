import { ItemView, WorkspaceLeaf } from "obsidian";
import { showDiagnosticText } from "../diag/DiagnosticTextModal";

export const HANDWRITING_DIAGNOSTICS_VIEW_TYPE = "handwriting-pen-diagnostics";

interface LogEntry {
	seq: number;
	type: string;
	pointerType: string;
	pointerId: number;
	isPrimary: boolean;
	button: number;
	buttons: number;
	pressure: number;
	tangentialPressure: number;
	tiltX: number;
	tiltY: number;
	twist: number;
	width: number;
	height: number;
	x: number;
	y: number;
	coalesced: number;
	t: number;
}

const MEMORY_CAP = 5000;
const DOM_CAP = 300;

/**
 * Raw pointer event logger (handoff §68). Answers, from real hardware:
 * - what buttons/eraser the Slim Pen actually reports in this Electron build
 * - whether getCoalescedEvents works and how many samples it delivers
 * - real pressure/tilt/twist ranges
 * - what happens on hover, barrel button, eraser end, palm contact
 *
 * Scoped entirely to this view's capture area. The export opens as selected
 * text so copying remains an ordinary Ctrl+C operation.
 */
export class PenDiagnosticsView extends ItemView {
	private entries: LogEntry[] = [];
	private seq = 0;
	private paused = false;
	private logEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private captureEl!: HTMLElement;
	private disposers: Array<() => void> = [];

	// Aggregates
	private counts = new Map<string, number>();
	private maxCoalesced = 0;
	private minPressure = Infinity;
	private maxPressure = -Infinity;
	private buttonsSeen = new Set<number>();
	private buttonSeen = new Set<number>();
	private typesSeen = new Set<string>();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return HANDWRITING_DIAGNOSTICS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Handwriting pen diagnostics";
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen(): Promise<void> {
		const content = this.contentEl;
		content.empty();
		content.addClass("handwriting-diag");

		content.createEl("p", {
			cls: "handwriting-diag-help",
			text:
				"Use the pen in the box below: normal tip, barrel button held, eraser end, hover, " +
				"palm, touch, pen+touch together. Every raw PointerEvent is logged. " +
				"Show JSON opens selected text for analysis.",
		});

		const controls = content.createDiv({ cls: "handwriting-diag-controls" });
		const pauseBtn = controls.createEl("button", { text: "Pause" });
		pauseBtn.addEventListener("click", () => {
			this.paused = !this.paused;
			pauseBtn.setText(this.paused ? "Resume" : "Pause");
		});
		const clearBtn = controls.createEl("button", { text: "Clear" });
		clearBtn.addEventListener("click", () => this.clear());
		const showJsonBtn = controls.createEl("button", { text: "Show JSON" });
		showJsonBtn.addEventListener("click", () => {
			const payload = this.entries.map((e) => JSON.stringify(e)).join("\n");
			showDiagnosticText(this.app, "Handwriting pen diagnostics JSON", payload);
		});
		const showSummaryBtn = controls.createEl("button", { text: "Show summary" });
		showSummaryBtn.addEventListener("click", () => {
			showDiagnosticText(
				this.app,
				"Handwriting pen diagnostics summary",
				this.summaryText()
			);
		});

		this.captureEl = content.createDiv({ cls: "handwriting-diag-capture" });
		this.captureEl.setText("write / touch / hover here");

		this.statsEl = content.createDiv({ cls: "handwriting-diag-stats" });
		this.logEl = content.createDiv({ cls: "handwriting-diag-log" });

		const types: Array<keyof HTMLElementEventMap> = [
			"pointerdown",
			"pointermove",
			"pointerup",
			"pointercancel",
			"pointerenter",
			"pointerleave",
			"gotpointercapture",
			"lostpointercapture",
		];
		for (const type of types) {
			const fn = (ev: Event) => this.record(type, ev as PointerEvent);
			this.captureEl.addEventListener(type, fn);
			this.disposers.push(() => this.captureEl.removeEventListener(type, fn));
		}
		// pointerrawupdate is not in TS lib but exists in Chromium.
		const rawFn = (ev: Event) => this.record("pointerrawupdate", ev as PointerEvent);
		this.captureEl.addEventListener("pointerrawupdate" as never, rawFn as never);
		this.disposers.push(() =>
			this.captureEl.removeEventListener("pointerrawupdate" as never, rawFn as never)
		);
		const downCapture = (ev: Event) => {
			// Keep pen from selecting/scrolling; keep events flowing.
			(ev as PointerEvent).preventDefault();
			try {
				this.captureEl.setPointerCapture((ev as PointerEvent).pointerId);
			} catch {
				this.recordNote("setPointerCapture threw");
			}
		};
		this.captureEl.addEventListener("pointerdown", downCapture);
		this.disposers.push(() => this.captureEl.removeEventListener("pointerdown", downCapture));
		const ctx = (ev: Event) => ev.preventDefault();
		this.captureEl.addEventListener("contextmenu", ctx);
		this.disposers.push(() => this.captureEl.removeEventListener("contextmenu", ctx));

		// LOG-ONLY document-level tracer (capture phase). The capture box never
		// received pen pointerdown/up on the test Surface even though the canvas view does;
		// this logs where in the DOM pen contact events actually land. It never
		// calls preventDefault/stopPropagation; observation only. Removed on
		// close.
		const trace = (ev: Event) => {
			const e = ev as PointerEvent;
			if (e.pointerType !== "pen") return;
			const t = ev.target as HTMLElement | null;
			const desc = t
				? `<${t.tagName?.toLowerCase() ?? "?"}> cls="${
						typeof t.className === "string" ? t.className.slice(0, 80) : ""
				  }"`
				: "(no target)";
			this.recordNote(
				`DOC ${ev.type} pen id=${e.pointerId} btn=${e.button}/${e.buttons} ` +
					`p=${round3(e.pressure)} target=${desc}`
			);
		};
		for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
			document.addEventListener(type, trace, { capture: true });
			this.disposers.push(() =>
				document.removeEventListener(type, trace, { capture: true })
			);
		}

		this.updateStats();
	}

	async onClose(): Promise<void> {
		for (const d of this.disposers) d();
		this.disposers = [];
	}

	private clear(): void {
		this.entries = [];
		this.seq = 0;
		this.counts.clear();
		this.maxCoalesced = 0;
		this.minPressure = Infinity;
		this.maxPressure = -Infinity;
		this.buttonsSeen.clear();
		this.buttonSeen.clear();
		this.typesSeen.clear();
		this.logEl.empty();
		this.updateStats();
	}

	private recordNote(text: string): void {
		const row = this.logEl.createDiv({ cls: "handwriting-diag-row handwriting-diag-note", text });
		this.trimDom();
		row.scrollIntoView({ block: "nearest" });
	}

	private record(type: string, e: PointerEvent): void {
		if (this.paused) return;
		const rect = this.captureEl.getBoundingClientRect();
		const coalesced =
			type === "pointermove" && typeof e.getCoalescedEvents === "function"
				? e.getCoalescedEvents().length
				: 0;
		const entry: LogEntry = {
			seq: this.seq++,
			type,
			pointerType: e.pointerType,
			pointerId: e.pointerId,
			isPrimary: e.isPrimary,
			button: e.button,
			buttons: e.buttons,
			pressure: round3(e.pressure),
			tangentialPressure: round3(e.tangentialPressure),
			tiltX: e.tiltX,
			tiltY: e.tiltY,
			twist: e.twist,
			width: round3(e.width),
			height: round3(e.height),
			x: round3(e.clientX - rect.left),
			y: round3(e.clientY - rect.top),
			coalesced,
			t: Math.round(e.timeStamp),
		};
		this.entries.push(entry);
		if (this.entries.length > MEMORY_CAP) this.entries.shift();

		// Aggregates
		const key = `${entry.pointerType || "?"}:${type}`;
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
		if (coalesced > this.maxCoalesced) this.maxCoalesced = coalesced;
		if (e.pointerType === "pen" && e.buttons > 0) {
			if (e.pressure < this.minPressure) this.minPressure = e.pressure;
			if (e.pressure > this.maxPressure) this.maxPressure = e.pressure;
		}
		this.buttonsSeen.add(e.buttons);
		if (type === "pointerdown") this.buttonSeen.add(e.button);
		this.typesSeen.add(e.pointerType || "?");

		// DOM row (skip raw hover-move spam in the visible log; memory keeps it)
		const isSpammy =
			(type === "pointermove" || type === "pointerrawupdate") && e.buttons === 0;
		if (!isSpammy) {
			const row = this.logEl.createDiv({ cls: "handwriting-diag-row" });
			row.setText(
				`#${entry.seq} ${type} ${entry.pointerType || "?"} id=${entry.pointerId} ` +
					`btn=${entry.button}/${entry.buttons} p=${entry.pressure} ` +
					`tilt=${entry.tiltX},${entry.tiltY} tw=${entry.twist} ` +
					`co=${entry.coalesced} @${entry.x},${entry.y}`
			);
			this.trimDom();
			row.scrollIntoView({ block: "nearest" });
		}
		this.updateStats();
	}

	private trimDom(): void {
		while (this.logEl.childElementCount > DOM_CAP) {
			this.logEl.firstElementChild?.remove();
		}
	}

	private summaryText(): string {
		const counts = [...this.counts.entries()]
			.sort()
			.map(([k, v]) => `${k}=${v}`)
			.join(", ");
		return [
			`Handwriting pen diagnostics summary`,
			`pointer types seen: ${[...this.typesSeen].join(", ")}`,
			`event counts: ${counts}`,
			`max coalesced per move: ${this.maxCoalesced}`,
			`pen pressure range (contact): ${
				this.minPressure === Infinity
					? "n/a"
					: `${round3(this.minPressure)}–${round3(this.maxPressure)}`
			}`,
			`distinct buttons bitmasks seen: ${[...this.buttonsSeen].sort((a, b) => a - b).join(", ")}`,
			`distinct pointerdown button values: ${[...this.buttonSeen].sort((a, b) => a - b).join(", ")}`,
			`entries in memory: ${this.entries.length}`,
		].join("\n");
	}

	private updateStats(): void {
		this.statsEl.setText(this.summaryText());
	}
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
