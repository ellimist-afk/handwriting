/**
 * A Chromium performance trace of the ink pipeline, recorded on demand.
 *
 * The ink metrics text says how long a stroke's frames took; a trace says
 * what the browser was doing inside them, down to the task and the GPU
 * submit. Electron's main-process `contentTracing` records one, and Obsidian
 * serves it to the renderer through @electron/remote, the same door
 * PresentProbe.ts uses for `capturePage`.
 *
 * Nothing here runs unless a command calls it: no listener, no timer, no
 * hook in the pen path. Resolution is a guarded runtime `require`, never a
 * top-level import, so mobile (no Electron) and a desktop build that does
 * not expose the module both get a plain "not available" and no throw.
 */

/** The slice of Electron's `contentTracing` this recorder touches. */
export interface ContentTracingLike {
	startRecording(options: { included_categories: string[]; recording_mode?: string }): Promise<void>;
	stopRecording(resultFilePath?: string): Promise<string>;
}

/**
 * Categories for an input-to-present read: the DevTools timeline set (tasks,
 * frames, paint), script execution, input routing and latency info, and the
 * compositor and GPU stages the stroke passes through on its way to glass.
 *
 * The last five name who posted a task that waits on the GPU and which GPU
 * command it waited for: task flows and their posting stacks, Blink's own
 * events, the GPU service side and the compositor's debug detail. A trace
 * without them showed long synchronous GPU waits on the main thread in
 * tasks with no poster recorded.
 */
export const INK_TRACE_CATEGORIES = [
	"devtools.timeline",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"toplevel",
	"blink.user_timing",
	"v8.execute",
	"input",
	"latencyInfo",
	"benchmark",
	"cc",
	"gpu",
	"viz",
	"toplevel.flow",
	"blink",
	"disabled-by-default-devtools.timeline.stack",
	"disabled-by-default-gpu.service",
	"disabled-by-default-cc.debug",
];

/** `contentTracing` from @electron/remote, or null wherever it is not served. */
export function resolveContentTracing(
	req: ((m: string) => unknown) | undefined = (typeof window === "undefined" ? undefined : (window as { require?: (m: string) => unknown }).require)
): ContentTracingLike | null {
	if (typeof req !== "function") return null;
	const pick = (m: string): ContentTracingLike | null => {
		try {
			const mod = req(m) as { contentTracing?: ContentTracingLike; remote?: { contentTracing?: ContentTracingLike } } | undefined;
			const ct = m === "electron" ? mod?.remote?.contentTracing : mod?.contentTracing;
			return typeof ct?.startRecording === "function" && typeof ct.stopRecording === "function" ? ct : null;
		} catch {
			return null;
		}
	};
	return pick("@electron/remote") ?? pick("electron");
}

/** A trace file name that sorts by time and never collides within a second. */
export function inkTraceFileName(now: Date): string {
	return `ink-trace-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

/**
 * One recording at a time. Both calls return the Notice text and never
 * throw: a failed start leaves nothing recording, a failed stop leaves the
 * state as it found it so the command can be tried again.
 *
 * The trace lives in Electron's main process, not in this object. A reload
 * that keeps the process (Obsidian's "Reload app without saving") keeps the
 * trace running and hands the new plugin a recorder whose flag is false. So a
 * stop never trusts the flag alone: with the flag false it still calls
 * stopRecording, which Electron rejects when no trace runs. A trace this
 * recorder did not start is stopped without a path (Electron writes it to its
 * own temp file), never into the plugin folder: the vault syncs, and a full
 * buffer is hundreds of MB.
 */
export class InkTraceRecorder {
	private recording = false;

	constructor(
		private readonly tracing: () => ContentTracingLike | null,
		private readonly outDir: () => string | null,
		private readonly now: () => Date = () => new Date()
	) {}

	get isRecording(): boolean {
		return this.recording;
	}

	async start(): Promise<string> {
		if (this.recording) return "Handwriting: ink trace already recording";
		const ct = this.tracing();
		if (!ct) return "Handwriting: ink trace not available here (no Electron content tracing)";
		try {
			await ct.startRecording({ included_categories: INK_TRACE_CATEGORIES, recording_mode: "record-until-full" });
		} catch (e) {
			return `Handwriting: ink trace did not start (${String(e)})`;
		}
		this.recording = true;
		return "Handwriting: ink trace recording - draw, then stop ink trace";
	}

	/**
	 * `notify` gets "stopping" at once, before the write: a full buffer is a
	 * file of a hundred MB or more, and a notice that waits for it looks like
	 * a command that did nothing.
	 */
	async stop(notify?: (text: string) => void): Promise<string> {
		if (!this.recording) {
			const ct = this.tracing();
			if (!ct) return "Handwriting: no ink trace recording";
			try {
				await ct.stopRecording();
				return "Handwriting: stopped an ink trace left running from before; not saved";
			} catch {
				return "Handwriting: no ink trace recording";
			}
		}
		const ct = this.tracing();
		const dir = this.outDir();
		if (!ct) return "Handwriting: ink trace not available here (no Electron content tracing)";
		if (!dir) return "Handwriting: ink trace has nowhere to save (no plugin folder on disk)";
		notify?.("Handwriting: stopping ink trace, saving the file...");
		try {
			const saved = await ct.stopRecording(`${dir}/${inkTraceFileName(this.now())}`);
			this.recording = false;
			return `Handwriting: ink trace saved to ${saved}`;
		} catch (e) {
			return `Handwriting: ink trace did not stop (${String(e)})`;
		}
	}

	/**
	 * Plugin unload: stop whatever trace runs, this instance's or a leftover,
	 * without a path, so nothing lands in the vault. Nothing running is a
	 * rejection, swallowed. Never throws.
	 */
	async stopLeftover(): Promise<void> {
		this.recording = false;
		try {
			await this.tracing()?.stopRecording();
		} catch {
			// No trace running, or no tracer: nothing to stop.
		}
	}
}

/**
 * Unload runs for every user. Resolving the tracer loads @electron/remote,
 * and a stop would end a trace some other tool started, so unload stops a
 * trace only when this recorder started one or Developer diagnostics is on
 * (a trace left by an earlier instance can only come from the diagnostics
 * commands). Never throws.
 */
export async function stopTraceAtUnload(recorder: InkTraceRecorder | undefined, devDiagnostics: boolean): Promise<void> {
	if (!recorder || !(recorder.isRecording || devDiagnostics)) return;
	await recorder.stopLeftover();
}
