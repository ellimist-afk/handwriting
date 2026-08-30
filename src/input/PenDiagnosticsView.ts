import { ItemView, Platform, WorkspaceLeaf, apiVersion } from "obsidian";
import { showDiagnosticText } from "../diag/DiagnosticTextModal";
import {
	formatCapabilities,
	readCapabilities,
	type PointerObservations,
} from "../diag/PlatformCapabilities";

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

/**
 * A tester-placed divider in the log. A remote session runs a scripted list of
 * gestures with no chance to check in between them, so the rows have to say
 * which gesture they belong to or the export is one undifferentiated stream.
 */
interface MarkEntry {
	seq: number;
	type: "mark";
	label: string;
	t: number;
}

type LogRecord = LogEntry | MarkEntry;

/**
 * A scripted remote session is roughly ten gestures of five to fifteen seconds
 * each. At 120 Hz with coalescing that clears 5000 events several times over,
 * and the old cap dropped the earliest gestures silently. The tester would
 * finish the script, send the report, and the first half of it would be gone.
 * Sized for the whole session instead, and trimmed in batches: the old
 * per-event `shift()` is O(n) on an array this size.
 */
const MEMORY_CAP = 50000;
const TRIM_SLACK = 2000;
const DOM_CAP = 300;
/**
 * The stats block used to be rebuilt on every event, and the visible log grew a
 * row per event with a `scrollIntoView` after it. Both are layout work on the
 * input path of the thing being measured: the probe was slowing down the event
 * rate the view is there to measure. Stats are throttled, and the move stream
 * touches the DOM at all.
 */
const STATS_INTERVAL_MS = 100;

/**
 * Raw pointer event logger (handoff §68). Answers, from real hardware:
 * - what buttons/eraser the Slim Pen actually reports in this Electron build
 * - whether getCoalescedEvents works and how many samples it delivers
 * - real pressure/tilt/twist ranges
 * - what happens on hover, side button, eraser end, palm contact
 *
 * Scoped entirely to this view's capture area. Every export leads with the
 * platform capability header, because the question a remote session is sent to
 * answer (can inline ink draw on this device at all) is decided by which
 * pointer APIs exist. Nothing the tester can see on screen settles it.
 */
export class PenDiagnosticsView extends ItemView {
	private entries: LogRecord[] = [];
	private seq = 0;
	private paused = false;
	private logEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private captureEl!: HTMLElement;
	private disposers: Array<() => void> = [];

	/** Which scripted gesture the incoming rows belong to. */
	private testIndex = 0;
	private nextBtn: HTMLButtonElement | null = null;
	/** Throttle gate for the stats block. */
	private lastStatsAt = 0;
	/**
	 * The capture box's rect, read once per contact instead of once per event.
	 * `getBoundingClientRect()` forces layout, and at input rate that was the
	 * probe's single largest self-inflicted cost.
	 */
	private captureRect: { left: number; top: number } = { left: 0, top: 0 };

	// Aggregates
	private counts = new Map<string, number>();
	private maxCoalesced = 0;
	/** Whether any real event carried getCoalescedEvents, prototype aside. */
	private coalescedSeen = false;
	private minPressure = Infinity;
	private maxPressure = -Infinity;
	private buttonsSeen = new Set<number>();
	private buttonSeen = new Set<number>();
	private typesSeen = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly pluginVersion = "(unknown)"
	) {
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
				"Do each gesture in the box below, and press Next test between them. " +
				"When the script is finished, press Show JSON and then Copy. " +
				"The moving pen does not print rows here on purpose; the counts above the " +
				"log are how you can tell it is recording.",
		});

		const controls = content.createDiv({ cls: "handwriting-diag-controls" });
		this.nextBtn = controls.createEl("button", { text: "Next test (1)", cls: "mod-cta" });
		this.nextBtn.addEventListener("click", () => {
			this.testIndex++;
			this.mark(`test ${this.testIndex} finished, test ${this.testIndex + 1} started`);
			this.syncNextLabel();
		});
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
			showDiagnosticText(
				this.app,
				"Handwriting pen diagnostics JSON",
				`${this.capabilityHeader()}\n\n${this.summaryText()}\n\n---- events ----\n${payload}`
			);
		});
		const showSummaryBtn = controls.createEl("button", { text: "Show summary" });
		showSummaryBtn.addEventListener("click", () => {
			showDiagnosticText(
				this.app,
				"Handwriting pen diagnostics summary",
				`${this.capabilityHeader()}\n\n${this.summaryText()}`
			);
		});

		this.captureEl = content.createDiv({ cls: "handwriting-diag-capture" });
		this.captureEl.setText("Write / touch / hover here");

		this.statsEl = content.createDiv({ cls: "handwriting-diag-stats" });
		this.logEl = content.createDiv({ cls: "handwriting-diag-log" });

		// The capture rect is cached instead of read per event. It is also
		// refreshed on contact inside record(), which is what covers the case
		// this listener cannot: a rotation or split-view change between
		// gestures on a tablet.
		const refreshRect = () => this.refreshCaptureRect();
		window.requestAnimationFrame(refreshRect);
		window.addEventListener("resize", refreshRect);
		this.disposers.push(() => window.removeEventListener("resize", refreshRect));

		this.mark("test 1 started");

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
		this.coalescedSeen = false;
		this.minPressure = Infinity;
		this.maxPressure = -Infinity;
		this.buttonsSeen.clear();
		this.buttonSeen.clear();
		this.typesSeen.clear();
		this.logEl.empty();
		this.testIndex = 0;
		this.lastStatsAt = 0;
		this.syncNextLabel();
		this.mark("test 1 started");
		this.updateStats();
	}

	private syncNextLabel(): void {
		this.nextBtn?.setText(`Next test (${this.testIndex + 1})`);
	}

	private recordNote(text: string): void {
		const row = this.logEl.createDiv({ cls: "handwriting-diag-row handwriting-diag-note", text });
		this.trimDom();
		row.scrollIntoView({ block: "nearest" });
	}

	private record(type: string, e: PointerEvent): void {
		if (this.paused) return;
		// Contact is the one moment the box is guaranteed to be where the
		// tester just touched, and it runs before this view's own capture
		// handler, so the refresh belongs here.
		if (type === "pointerdown" || type === "pointerenter") this.refreshCaptureRect();
		const rect = this.captureRect;
		// Counted for the raw stream too: on Chromium that is where the ink
		// actually comes from, and the two numbers together are what says
		// whether a pointermove path can match the rawupdate one.
		const isMoveLike = type === "pointermove" || type === "pointerrawupdate";
		const hasCoalesced = typeof e.getCoalescedEvents === "function";
		if (isMoveLike && hasCoalesced) this.coalescedSeen = true;
		const coalesced = isMoveLike && hasCoalesced ? e.getCoalescedEvents().length : 0;
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
		// Batched: a per-event shift() on a 50k array is O(n) at input rate.
		if (this.entries.length > MEMORY_CAP + TRIM_SLACK) {
			this.entries.splice(0, this.entries.length - MEMORY_CAP);
		}

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

		// DOM row. The whole move stream is skipped now, contact included:
		// a row plus a scrollIntoView per sample is layout work on the input
		// path, and it depressed the very event rate this view reports.
		// Memory keeps every one of them for the export.
		const isSpammy = type === "pointermove" || type === "pointerrawupdate";
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
		// Throttled: rebuilding the summary string and writing it into the DOM
		// on every sample is the other half of the measurement distortion.
		const now = e.timeStamp;
		if (isSpammy && now - this.lastStatsAt < STATS_INTERVAL_MS) return;
		this.lastStatsAt = now;
		this.updateStats();
	}

	/** One row the tester placed, so the export says which gesture is which. */
	private mark(label: string): void {
		this.entries.push({ seq: this.seq++, type: "mark", label, t: Math.round(performance.now()) });
		const row = this.logEl?.createDiv({
			cls: "handwriting-diag-row handwriting-diag-mark",
			text: `---- ${label} ----`,
		});
		this.trimDom();
		row?.scrollIntoView({ block: "nearest" });
	}

	private refreshCaptureRect(): void {
		if (!this.captureEl) return;
		const r = this.captureEl.getBoundingClientRect();
		this.captureRect = { left: r.left, top: r.top };
	}

	/**
	 * What the handlers actually received. The capability verdict is decided
	 * from these instead of from a feature test, because Chromium fires
	 * `pointerrawupdate` without advertising it anywhere detectable.
	 */
	private observations(): PointerObservations {
		let rawUpdateEvents = 0;
		let moveEvents = 0;
		for (const [key, n] of this.counts) {
			if (key.endsWith(":pointerrawupdate")) rawUpdateEvents += n;
			else if (key.endsWith(":pointermove")) moveEvents += n;
		}
		return {
			rawUpdateEvents,
			moveEvents,
			maxCoalesced: this.maxCoalesced,
			coalescedSeen: this.coalescedSeen,
		};
	}

	/** The platform preamble every export leads with. */
	private capabilityHeader(): string {
		try {
			return formatCapabilities(
				readCapabilities(
					this.pluginVersion,
					{
						isMobileApp: Platform.isMobileApp,
						isIosApp: Platform.isIosApp,
						isAndroidApp: Platform.isAndroidApp,
						isTablet: Platform.isTablet,
						isPhone: Platform.isPhone,
						isDesktopApp: Platform.isDesktopApp,
					},
					apiVersion,
					this.observations()
				)
			);
		} catch (err) {
			return `(could not read platform capabilities: ${String(err)})`;
		}
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
			`current test: ${this.testIndex + 1}`,
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
