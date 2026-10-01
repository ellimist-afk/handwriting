import { describe, expect, it } from "vitest";
import { INK_TRACE_CATEGORIES, InkTraceRecorder, inkTraceFileName, resolveContentTracing, stopTraceAtUnload, type ContentTracingLike } from "./InkTrace";

/**
 * The "start/stop ink trace" commands. Every path returns Notice text and
 * none throws: no Electron content tracing (mobile, or a desktop build that
 * does not serve it) is a sentence, not an exception.
 */
function fakeTracing(opts: { failStart?: boolean; failStop?: boolean } = {}) {
	const calls: string[] = [];
	// Electron rejects a stop when no trace runs; the recorder now relies on it.
	let live = false;
	const ct: ContentTracingLike = {
		startRecording: async (o) => {
			calls.push(`start ${o.included_categories.length}`);
			if (opts.failStart) throw new Error("busy");
			live = true;
		},
		stopRecording: async (p) => {
			calls.push(`stop ${p}`);
			if (opts.failStop) throw new Error("disk");
			if (!live) throw new Error("Failed to stop tracing - no trace in progress");
			live = false;
			return p ?? "";
		},
	};
	return { ct, calls };
}

const AT = new Date("2026-09-26T04:30:00.123Z");

describe("ink trace recorder", () => {
	it("records into the plugin folder and says where the file went", async () => {
		const { ct, calls } = fakeTracing();
		const r = new InkTraceRecorder(() => ct, () => "C:/vault/.obsidian/plugins/handwriting", () => AT);

		expect(await r.start()).toBe("Handwriting: ink trace recording - draw, then stop ink trace");
		expect(r.isRecording).toBe(true);
		const text = await r.stop();

		expect(text).toBe("Handwriting: ink trace saved to C:/vault/.obsidian/plugins/handwriting/ink-trace-2026-09-26T04-30-00-123Z.json");
		expect(r.isRecording).toBe(false);
		expect(calls[1]).toBe("stop C:/vault/.obsidian/plugins/handwriting/ink-trace-2026-09-26T04-30-00-123Z.json");
	});

	it("does nothing and says so when content tracing is absent", async () => {
		const r = new InkTraceRecorder(() => null, () => "C:/p");

		await expect(r.start()).resolves.toBe("Handwriting: ink trace not available here (no Electron content tracing)");
		expect(r.isRecording).toBe(false);
		await expect(r.stop()).resolves.toBe("Handwriting: no ink trace recording");
	});

	it("a failed start leaves nothing recording; a failed stop can be retried", async () => {
		const bad = fakeTracing({ failStart: true });
		const r1 = new InkTraceRecorder(() => bad.ct, () => "C:/p");
		await expect(r1.start()).resolves.toContain("ink trace did not start");
		expect(r1.isRecording).toBe(false);

		const flaky = fakeTracing({ failStop: true });
		const r2 = new InkTraceRecorder(() => flaky.ct, () => "C:/p", () => AT);
		await r2.start();
		await expect(r2.stop()).resolves.toContain("ink trace did not stop");
		expect(r2.isRecording).toBe(true);
	});

	it("refuses a second start and a stop with no folder, without calling the tracer", async () => {
		const { ct, calls } = fakeTracing();
		const r = new InkTraceRecorder(() => ct, () => null);
		await r.start();

		expect(await r.start()).toBe("Handwriting: ink trace already recording");
		expect(await r.stop()).toBe("Handwriting: ink trace has nowhere to save (no plugin folder on disk)");
		expect(calls).toHaveLength(1);
	});

	it("resolves content tracing only where remote serves it, and never throws", () => {
		const ct = fakeTracing().ct;
		expect(resolveContentTracing(undefined)).toBeNull();
		expect(resolveContentTracing(() => { throw new Error("no module"); })).toBeNull();
		expect(resolveContentTracing((m) => (m === "@electron/remote" ? { contentTracing: ct } : undefined))).toBe(ct);
		expect(resolveContentTracing((m) => (m === "electron" ? { remote: { contentTracing: ct } } : undefined))).toBe(ct);
		expect(resolveContentTracing(() => ({ contentTracing: {} }))).toBeNull();
	});

	it("names trace files by UTC time with no path-hostile characters", () => {
		expect(inkTraceFileName(AT)).toBe("ink-trace-2026-09-26T04-30-00-123Z.json");
	});

	it("records the categories that name who posted a GPU wait and which GPU command it was, until the buffer is full", async () => {
		const seen: { included_categories: string[]; recording_mode?: string }[] = [];
		const ct: ContentTracingLike = {
			startRecording: async (o) => { seen.push(o); },
			stopRecording: async (p) => p ?? "",
		};
		await new InkTraceRecorder(() => ct, () => "C:/p").start();

		for (const c of ["toplevel.flow", "blink", "disabled-by-default-devtools.timeline.stack", "disabled-by-default-gpu.service", "disabled-by-default-cc.debug"]) {
			expect(INK_TRACE_CATEGORIES, `category ${c}`).toContain(c);
			expect(seen[0]!.included_categories, `category ${c} reaches the tracer`).toContain(c);
		}
		expect(seen[0]!.recording_mode).toBe("record-until-full");
	});

	it("says it is stopping at once, before a long write, then says where the file went when the write ends", async () => {
		let finish: (path: string) => void = () => {};
		const ct: ContentTracingLike = {
			startRecording: async () => {},
			stopRecording: (p) => new Promise<string>((resolve) => { finish = () => resolve(p ?? ""); }),
		};
		const r = new InkTraceRecorder(() => ct, () => "C:/p", () => AT);
		await r.start();
		const shown: string[] = [];

		const done = r.stop((text) => shown.push(text));
		await Promise.resolve();
		expect(shown, "the first notice is up while the file is still being written").toEqual(["Handwriting: stopping ink trace, saving the file..."]);

		finish("");
		expect(await done).toBe("Handwriting: ink trace saved to C:/p/ink-trace-2026-09-26T04-30-00-123Z.json");
		expect(shown, "no second early notice").toHaveLength(1);
	});

	it("posts no stopping notice when there is nothing to stop", async () => {
		const shown: string[] = [];
		const r = new InkTraceRecorder(() => fakeTracing().ct, () => "C:/p");
		expect(await r.stop((text) => shown.push(text))).toBe("Handwriting: no ink trace recording");
		expect(shown).toEqual([]);
	});
});

/**
 * A trace lives in Electron's main process, so it outlives the plugin: a
 * "Reload app without saving" keeps the process and its trace, and hands the
 * new plugin a fresh recorder whose flag says nothing is recording. A trace
 * left running records every frame with the GPU and stack categories on until
 * the buffer is full. Electron rejects stopRecording when no trace runs.
 */
function mainProcessTracer(live: boolean) {
	const calls: string[] = [];
	const ct: ContentTracingLike = {
		startRecording: async () => {
			calls.push("start");
			live = true;
		},
		stopRecording: async (p) => {
			calls.push(`stop ${p ?? "(no path)"}`);
			if (!live) throw new Error("Failed to stop tracing - no trace in progress");
			live = false;
			return p ?? "C:/Temp/trace-leftover.json";
		},
	};
	return { ct, calls, isLive: () => live };
}

describe("ink trace left running by an earlier plugin instance", () => {
	it("stop after a reload stops the live trace and writes nothing into the vault", async () => {
		const t = mainProcessTracer(true);
		const fresh = new InkTraceRecorder(() => t.ct, () => "C:/vault/.obsidian/plugins/handwriting", () => AT);
		expect(fresh.isRecording, "a fresh recorder knows nothing of the old trace").toBe(false);

		const text = await fresh.stop();

		expect(t.isLive(), "the main-process trace is stopped").toBe(false);
		expect(t.calls).toEqual(["stop (no path)"]);
		expect(text).toBe("Handwriting: stopped an ink trace left running from before; not saved");
	});

	it("stop with no trace anywhere says so and posts no stopping notice", async () => {
		const t = mainProcessTracer(false);
		const shown: string[] = [];
		const r = new InkTraceRecorder(() => t.ct, () => "C:/p", () => AT);

		expect(await r.stop((s) => shown.push(s))).toBe("Handwriting: no ink trace recording");
		expect(shown).toEqual([]);
	});

	it("stopLeftover stops a live trace without a vault path, and never throws", async () => {
		const t = mainProcessTracer(true);
		await new InkTraceRecorder(() => t.ct, () => "C:/p").stopLeftover();
		expect(t.isLive()).toBe(false);
		expect(t.calls).toEqual(["stop (no path)"]);

		const idle = mainProcessTracer(false);
		await expect(new InkTraceRecorder(() => idle.ct, () => "C:/p").stopLeftover()).resolves.toBeUndefined();
		await expect(new InkTraceRecorder(() => null, () => "C:/p").stopLeftover()).resolves.toBeUndefined();
		const thrower = () => { throw new Error("remote gone"); };
		await expect(new InkTraceRecorder(thrower, () => "C:/p").stopLeftover()).resolves.toBeUndefined();
	});

	it("stopLeftover also ends this instance's own recording", async () => {
		const t = mainProcessTracer(false);
		const r = new InkTraceRecorder(() => t.ct, () => "C:/p", () => AT);
		await r.start();
		await r.stopLeftover();
		expect(t.isLive()).toBe(false);
		expect(r.isRecording).toBe(false);
	});

	it("constructing the recorder resolves no tracer", () => {
		let asked = 0;
		new InkTraceRecorder(() => { asked++; return null; }, () => "C:/p");
		expect(asked).toBe(0);
	});
});

describe("plugin wiring for a leftover ink trace", () => {
	const MAIN = (import.meta.glob("../main.ts", { query: "?raw", import: "default", eager: true })["../main.ts"] as string).replace(/\r\n/g, "\n");
	const body = (sig: string): string => {
		const start = MAIN.indexOf(sig);
		expect(start, `${sig} found in main.ts`).toBeGreaterThan(0);
		const next = MAIN.indexOf("\n\t}\n", start);
		return MAIN.slice(start, next < 0 ? undefined : next);
	};

	it("onunload stops a trace only through the gated helper", () => {
		const onunload = body("\n\tonunload(): void {");
		expect(onunload).toMatch(/stopTraceAtUnload\(this\.inkTrace, this\.settings\?\.devDiagnostics === true\)/);
		expect(onunload, "no ungated stop").not.toMatch(/stopLeftover/);
	});

	// A guard, green before and after: the command callbacks inside onload
	// may name the recorder, but nothing in onload stops or probes a trace.
	it("onload makes no tracing call", () => {
		const onload = body("\n\tasync onload(): Promise<void> {");
		expect(onload).toContain('id: "stop-ink-trace"');
		expect(onload).not.toMatch(/stopLeftover|getTraceBufferUsage|stopRecording|startRecording/);
	});

	it("the commands use the recorder the unload stops", () => {
		expect(MAIN).not.toMatch(/const inkTrace = new InkTraceRecorder/);
		expect(MAIN).toMatch(/await this\.inkTrace\.start\(\)/);
		expect(MAIN).toMatch(/await this\.inkTrace\.stop\(/);
	});
});

/**
 * Unload runs for every user. Resolving the tracer loads @electron/remote,
 * and a stop would end a trace some other tool started, so unload stops a
 * trace only when this recorder started one or Developer diagnostics is on.
 */
describe("stop at unload is gated", () => {
	function counted(live: boolean) {
		const t = { resolved: 0, stops: [] as (string | undefined)[], live };
		const ct: ContentTracingLike = {
			startRecording: async () => { t.live = true; },
			stopRecording: async (p) => {
				t.stops.push(p);
				if (!t.live) throw new Error("Failed to stop tracing - no trace in progress");
				t.live = false;
				return p ?? "";
			},
		};
		const recorder = new InkTraceRecorder(() => { t.resolved++; return ct; }, () => "C:/p");
		return { t, recorder };
	}

	it("diagnostics off and nothing started here: no tracer call at all", async () => {
		const { t, recorder } = counted(true);
		await stopTraceAtUnload(recorder, false);
		expect(t.resolved, "the tracer is not even resolved").toBe(0);
		expect(t.stops).toEqual([]);
		expect(t.live, "a trace some other tool started keeps running").toBe(true);
	});

	it("diagnostics on: one stopRecording, no path", async () => {
		const { t, recorder } = counted(true);
		await stopTraceAtUnload(recorder, true);
		expect(t.stops).toEqual([undefined]);
		expect(t.live).toBe(false);
	});

	it("this recorder started a trace, diagnostics off: one stopRecording, no path", async () => {
		const { t, recorder } = counted(false);
		await recorder.start();
		t.resolved = 0;
		await stopTraceAtUnload(recorder, false);
		expect(t.stops).toEqual([undefined]);
		expect(t.live).toBe(false);
		expect(recorder.isRecording).toBe(false);
	});

	it("no recorder (an unload test's bare instance): nothing, no throw", async () => {
		await expect(stopTraceAtUnload(undefined, true)).resolves.toBeUndefined();
	});
});
