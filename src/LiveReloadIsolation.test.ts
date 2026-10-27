import { describe, expect, it } from "vitest";
import { installLiveReloadPoll as install } from "./testUtils/LiveReloadTestHarness";
import type { ExternalAdoptionResult } from "./inline/InlineInkStore";

type Options = {
	check?: (id: string) => boolean | Promise<boolean>;
	reload?: (id: string) => boolean | Promise<boolean>;
	paint?: (id: string) => void;
};

function harness(options: Options = {}) {
	const events: string[] = [];
	const errors: unknown[][] = [];
	const detachedErrors: unknown[] = [];
	const queued = new Set<string>();
	const document = { hidden: false };
	let callback!: () => void;
	let pending = Promise.resolve();
	const controllers = [0, 1].map(index => ({
		idle: true,
		refresh() {
			const id = `pdf-${index}`;
			events.push(`paint:${id}`);
			options.paint?.(id);
		},
	}));
	const roots = [{ isConnected: true }, { isConnected: true }];
	const reload = async (id: string) => {
		events.push(`reload:${id}`);
		return options.reload ? options.reload(id) : true;
	};
	const inlineAdopt = async () => {
		// This reduced dependency models the preserving adoption contract. The
		// legacy event label is retained so the isolation assertions keep proving
		// ordering and fault containment rather than implementation vocabulary.
		const changed = await reload("note");
		return {
			outcome: "adopted" as const,
			changed,
			outgoingPath: ".handwriting/note.conflict-external-test-outgoing.json",
			incomingPath: ".handwriting/note.conflict-external-test-incoming.json",
		};
	};
	const pdfAdopt = async (id: string): Promise<ExternalAdoptionResult> => {
		// Same executable poll contract as production: the test's `reload` seam
		// models a completed preserving adoption, never fallback authority.
		const changed = await reload(id);
		return {
			outcome: "adopted" as const,
			changed,
			outgoingPath: `.handwriting/${id}.conflict-external-test-outgoing.json`,
			incomingPath: `.handwriting/${id}.conflict-external-test-incoming.json`,
		};
	};
	const host = {
		pdfInk: new Map(roots.map((root, index) => [root, controllers[index]!])),
		pdfIds: new Map(roots.map((root, index) => [root, `pdf-${index}`])),
		store: {
			externallyChanged(id: string) {
				events.push(`check:${id}`);
				return options.check ? options.check(id) : Promise.resolve(true);
			},
			hasQueuedWrite: (id: string) => queued.has(id),
		},
		pdfStore: { adoptExternal: pdfAdopt },
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval(handle: number) { expect(handle).toBe(17); },
	};
	install.call(host,
		{ setInterval(fn: () => void, delay: number) {
			expect(delay).toBe(1000);
			callback = fn;
			return 17;
		} },
		document,
		(promise: Promise<void>, context: string) => {
			expect(context).toBe("live-reload poll");
			pending = promise.catch(error => { detachedErrors.push(error); });
		},
		() => ["note.md"],
		{ pageIdOf: () => "note", adoptExternal: inlineAdopt },
		() => events.push("paint:note"),
		() => events.push("notify:note"),
		() => "deck.slides",
		() => reload("deck.slides"),
		{ error: (...args: unknown[]) => errors.push(args) },
		() => () => true, // Explicit quiet binding in this reduced host.
	);
	return {
		events, errors, detachedErrors, queued, document, controllers, roots, host,
		fire: () => callback(),
		settle: () => pending,
		async tick() { callback(); await pending; },
	};
}

const healthyEvents = [
	"check:pdf-0", "reload:pdf-0", "paint:pdf-0",
	"check:pdf-1", "reload:pdf-1", "paint:pdf-1",
	"check:note", "reload:note", "paint:note", "notify:note",
	"check:deck.slides", "reload:deck.slides",
];
const laterDocuments = healthyEvents.slice(3);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

describe("the registered live-reload poll", () => {
	it("checks and reloads every surface in order on consecutive healthy ticks", async () => {
		const h = harness();
		for (let tick = 0; tick < 2; tick++) {
			h.events.length = 0;
			await h.tick();
			expect(h.events).toEqual(healthyEvents);
		}
		expect(h.errors).toEqual([]);
		expect(h.detachedErrors).toEqual([]);
		expect(h.host.pollStats).toEqual({ ticks: 2, hidden: 0, spaced: 0, checks: 2 });
	});

	it.each(["check rejection", "check throw", "reload rejection", "reload throw", "paint throw"])(
		"contains a first-PDF %s with document context on this and the next tick", async fault => {
			const error = new Error(`injected ${fault}`);
			const fail = () => {
				if (fault.endsWith("rejection")) return Promise.reject(error);
				throw error;
			};
			const h = harness({
				check: id => id === "pdf-0" && fault.startsWith("check") ? fail() : true,
				reload: id => id === "pdf-0" && fault.startsWith("reload") ? fail() : true,
				paint: id => { if (id === "pdf-0" && fault === "paint throw") throw error; },
			});
			for (let tick = 0; tick < 2; tick++) {
				h.events.length = 0;
				await h.tick();
				expect(h.events.slice(-laterDocuments.length)).toEqual(laterDocuments);
			}
			expect(h.errors).toHaveLength(2);
			for (const report of h.errors) {
				expect(report[0]).toMatch(/live-reload poll failed.*pdf-0/);
				expect(report[1]).toBe(error);
			}
			expect(h.detachedErrors).toEqual([]);
		},
	);

	it("does not repaint a PDF whose reload reports no adoption", async () => {
		const h = harness({ reload: id => id !== "pdf-0" });
		await h.tick();
		expect(h.events).toEqual(healthyEvents.filter(event => event !== "paint:pdf-0"));
	});

	it.each(["held", "unavailable"] as const)(
		"never falls back when a PDF adoption is %s",
		async (outcome) => {
			const h = harness();
			h.host.pdfStore.adoptExternal = async () => outcome === "held"
				? { outcome, changed: false, reason: "missing-capability" }
				: { outcome, changed: false };
			await h.tick();
			expect(h.events).not.toContain("reload:pdf-0");
			expect(h.events).not.toContain("reload:pdf-1");
			expect(h.events).toContain("reload:note");
			expect(h.events).toContain("reload:deck.slides");
		}
	);

	it.each(["active gesture", "missing id", "queued write"])("preserves the initial %s guard", async guard => {
		const h = harness();
		if (guard === "active gesture") h.controllers[0]!.idle = false;
		if (guard === "missing id") h.host.pdfIds.delete(h.roots[0]!);
		if (guard === "queued write") h.queued.add("pdf-0");
		await h.tick();
		expect(h.events).toEqual(guard === "queued write" ? ["check:pdf-0", ...laterDocuments] : laterDocuments);
		h.controllers[0]!.idle = true;
		h.host.pdfIds.set(h.roots[0]!, "pdf-0");
		h.queued.clear();
		h.events.length = 0;
		await h.tick();
		expect(h.events).toEqual(healthyEvents);
	});

	it.each(["active gesture", "queued write"])("rechecks a %s that starts during the awaited stat", async guard => {
		const stat = deferred<boolean>();
		const h = harness({ check: id => id === "pdf-0" ? stat.promise : true });
		h.fire();
		expect(h.events).toEqual(["check:pdf-0"]);
		if (guard === "active gesture") h.controllers[0]!.idle = false;
		else h.queued.add("pdf-0");
		stat.resolve(true);
		await h.settle();
		expect(h.events).toEqual(["check:pdf-0", ...laterDocuments]);
		h.controllers[0]!.idle = true;
		h.queued.clear();
		h.events.length = 0;
		await h.tick();
		expect(h.events).toEqual(healthyEvents);
	});

	it("skips hidden ticks and catches up immediately when visible, even after quiet backoff", async () => {
		let changed = false;
		const h = harness({ check: () => changed });
		for (let tick = 0; tick < 6; tick++) await h.tick();
		h.events.length = 0;
		h.document.hidden = true;
		await h.tick();
		await h.tick();
		expect(h.events).toEqual([]);
		expect(h.host.pollStats.hidden).toBe(2);
		h.document.hidden = false;
		changed = true;
		await h.tick();
		expect(h.events).toEqual(healthyEvents);
		expect(h.host.pollStats.checks).toBe(7);
	});

	it("ignores an overlapping interval while a stat is in flight, then releases the busy guard", async () => {
		const stat = deferred<boolean>();
		const h = harness({ check: id => id === "pdf-0" ? stat.promise : true });
		h.fire();
		h.fire();
		expect(h.events).toEqual(["check:pdf-0"]);
		expect(h.host.pollStats.ticks).toBe(1);
		stat.resolve(true);
		await h.settle();
		expect(h.events).toEqual(healthyEvents);
		h.events.length = 0;
		await h.tick();
		expect(h.events).toEqual(healthyEvents);
		expect(h.host.pollStats.ticks).toBe(2);
	});

	it("resets real quiet backoff when a PDF was adopted but its repaint throws", async () => {
		let changed = false;
		const error = new Error("paint failed after adoption");
		let paintFailed = false;
		const h = harness({
			check: id => changed && id === "pdf-0",
			paint: id => { if (id === "pdf-0" && !paintFailed) { paintFailed = true; throw error; } },
		});
		for (let tick = 0; tick < 7; tick++) await h.tick();
		expect(h.host.pollStats).toEqual({ ticks: 7, hidden: 0, spaced: 1, checks: 6 });
		changed = true;
		h.events.length = 0;
		await h.tick(); // Tick 8 adopts; the other surfaces all report no change.
		expect(h.events).toContain("reload:pdf-0");
		changed = false;
		h.events.length = 0;
		await h.tick(); // Tick 9 would be spaced out if adoption had not reset quietTicks.
		expect(h.host.pollStats).toEqual({ ticks: 9, hidden: 0, spaced: 1, checks: 8 });
		expect(h.events).toEqual(["paint:pdf-0", "check:pdf-0", "check:pdf-1", "check:note", "check:deck.slides"]);
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]![1]).toBe(error);
		expect(h.detachedErrors).toEqual([]);
	});

	it("backs the sidecar check off to one tick in five on a long quiet run and no further", async () => {
		const h = harness({ check: () => false });
		// The stride grows by one for every five quiet checks and stops at five: from the twenty-first quiet check on,
		// every window of fifty ticks holds exactly ten checks.
		for (let tick = 0; tick < 200; tick++) await h.tick();
		const before = h.host.pollStats.checks;
		for (let tick = 0; tick < 50; tick++) await h.tick();
		expect(h.host.pollStats.checks - before).toBe(10);
		expect(h.host.pollStats.ticks).toBe(250);
	});

	it.each(["note", "deck.slides"])("preserves existing isolation of a failed %s reload", async id => {
		const error = new Error(`injected ${id} failure`);
		const h = harness({ reload: current => current === id ? Promise.reject(error) : true });
		for (let tick = 0; tick < 2; tick++) {
			h.events.length = 0;
			await h.tick();
			expect(h.events.slice(0, 6)).toEqual(healthyEvents.slice(0, 6));
			expect(h.events).toContain("reload:deck.slides");
		}
		expect(h.errors).toHaveLength(2);
		expect(h.errors[0]![0]).toMatch(id === "note" ? /note\.md/ : /presentation/);
		expect(h.errors[0]![1]).toBe(error);
		expect(h.detachedErrors).toEqual([]);
	});
});
