/**
 * The pdf half of the abandoned-stroke fix (D1 hardening).
 *
 * `7c95c39` taught the NOTE surface that a pane which changes document in
 * place must tell its router so: Obsidian reuses the editor, so the router
 * survives the switch holding whatever gesture was in flight, and a pen
 * contact whose lift never arrived (a finger resting on the glass through the
 * switch) left `activePenId` set forever - which kept `armOwnership`'s
 * window-capture click suppressor armed forever, which ate every future pen
 * tap on the toolbar strip. `f5f2333` added the second half: the abandoned
 * stroke had already run `stripPenDown` -> `setInking(true)`, and nothing put
 * it back, so the strip and its collapsed pill stayed `is-inking` (styles.css:
 * opacity 0 AND visibility hidden - unhit-testable, not merely invisible).
 *
 * The pdf surface got NEITHER. It is the same `InlinePenRouter`, mounted on a
 * pane main.ts also reuses across documents - `PdfInkController.forgetHistory()`
 * is what that switch calls (main.ts, the `path !== "" && this.pdfFiles.get(root)
 * !== path` branch) - and `grep abandonActiveStroke src/pdf` found nothing at
 * all. This is the tenth-shaped divergence the surface registry exists for, so
 * it is pinned here as behaviour AND in `InkSurfaceRules.test.ts` as presence.
 *
 * Built on `PdfInkMountGate.test.ts`'s `makeController` shape and for its
 * reason: no jsdom here, so the controller is constructed against the thinnest
 * stubs it will hold still for and the private router and strip are supplied
 * directly. What is pinned is the CALL - once, first, and the chrome
 * stand-down only when the router says a stroke was really torn down.
 */

import { describe, expect, it } from "vitest";

import { PdfInkController } from "./PdfInkController";

interface RouterStub {
	calls: number;
	/** What the gesture state looked like at the moment abandon was called. */
	sawGesture: Array<{ erasing: boolean; builder: boolean }>;
	abandonActiveStroke(): boolean;
}

interface ToolsStub {
	inking: boolean[];
	refreshes: number;
	setInking(on: boolean): void;
	refresh(): void;
	closeInkSliders(): void;
}

type Private = {
	router: unknown;
	tools: unknown;
	erasing: boolean;
	builder: unknown;
};

function routerStub(returns: boolean): RouterStub {
	const stub: RouterStub = {
		calls: 0,
		sawGesture: [],
		abandonActiveStroke: () => returns,
	};
	return stub;
}

function toolsStub(): ToolsStub {
	const stub: ToolsStub = {
		inking: [],
		refreshes: 0,
		setInking: (on: boolean) => void stub.inking.push(on),
		refresh: () => void stub.refreshes++,
		closeInkSliders: () => {},
	};
	return stub;
}

function makeController() {
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
	};
	const controller = new PdfInkController(
		// One member, and it is load-bearing: the teardown this file drives
		// now puts the reticle away too, and `hideCursor` probes the viewer to
		// find the scroller it hung the hover class on. `probeViewer` treats a
		// null scroller as "PDF ink is off this session" and returns null,
		// which is the answer a root with no viewer under it should give -
		// a root with no `querySelector` at all is not an answer, it is a
		// TypeError out of a cleanup path.
		{ querySelector: () => null } as unknown as HTMLElement,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => []
	);
	return { controller, priv: controller as unknown as Private };
}

/** `stripPenUp` defers its `refresh()` to a microtask; let it land. */
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe("PdfInkController.forgetHistory abandons a stroke the switch stranded", () => {
	it("asks the router exactly once", () => {
		const { controller, priv } = makeController();
		const router = routerStub(false);
		let calls = 0;
		router.abandonActiveStroke = () => {
			calls++;
			return false;
		};
		priv.router = router;

		controller.forgetHistory();

		expect(calls).toBe(1);
	});

	it("stands the strip chrome down when a live stroke was really torn down", async () => {
		const { controller, priv } = makeController();
		priv.router = routerStub(true);
		const tools = toolsStub();
		priv.tools = tools;

		controller.forgetHistory();
		await flushMicrotasks();

		// stripPenUp: setInking(false) now, refresh() on the microtask.
		expect(tools.inking).toEqual([false]);
		expect(tools.refreshes).toBe(1);
	});

	it("is a byte-for-byte no-op on the strip when nothing was live", async () => {
		// The half `f5f2333` is explicit about on the note side: a routine
		// switch with no stroke to abandon must not pay for a setInking or a
		// refresh, and must not put `is-inking` DOWN on a strip that a
		// perfectly healthy in-flight gesture on the NEW document just put up.
		const { controller, priv } = makeController();
		priv.router = routerStub(false);
		const tools = toolsStub();
		priv.tools = tools;

		controller.forgetHistory();
		await flushMicrotasks();

		expect(tools.inking).toEqual([]);
		expect(tools.refreshes).toBe(0);
	});

	it("abandons BEFORE the gesture state is reset, so the stroke is still describable", () => {
		// Ordering, not presence. `forgetHistory` calls `resetGestureState()`,
		// which nulls the builder and clears `erasing`; a router asked to
		// abandon after that would be tearing down a stroke this controller
		// could no longer say anything about - and any future teardown that
		// wants to know what the gesture WAS (a trace line, an erase batch
		// still owing a history entry) would read a blank.
		const { controller, priv } = makeController();
		const router = routerStub(true);
		router.abandonActiveStroke = () => {
			router.calls++;
			router.sawGesture.push({ erasing: priv.erasing, builder: priv.builder !== null });
			return true;
		};
		priv.router = router;
		priv.tools = toolsStub();
		priv.erasing = true;
		priv.builder = {};

		controller.forgetHistory();

		expect(router.sawGesture).toEqual([{ erasing: true, builder: true }]);
		// And the reset still happened afterwards.
		expect(priv.erasing).toBe(false);
		expect(priv.builder).toBe(null);
	});

	it("survives a switch with no router bound at all", async () => {
		// `unmount()` nulls the router, and main.ts can reach a controller
		// between an unmount and the next bind. Optional chaining, not a
		// guard clause, so this cannot become a throw on a code path whose
		// whole job is cleanup.
		const { controller, priv } = makeController();
		priv.router = null;
		const tools = toolsStub();
		priv.tools = tools;

		expect(() => controller.forgetHistory()).not.toThrow();
		await flushMicrotasks();

		expect(tools.inking).toEqual([]);
		expect(tools.refreshes).toBe(0);
	});
});
