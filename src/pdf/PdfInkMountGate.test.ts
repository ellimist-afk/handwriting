/**
 * Nothing binds after unmount (audit item 7, 2026-09-01).
 *
 * `sync()` is the only path here that BINDS: it probes the viewer and, when
 * the scroller it finds is not the one it holds, builds a router that
 * installs capture listeners ahead of the whole page. `schedule()` queues it
 * on a frame, and both `refresh()` (called from the store when ink changes
 * anywhere) and the resize observer reach it. A frame already queued when a
 * pane closes, or a refresh arriving just after, therefore rebuilt exactly
 * the listeners unmount had just torn down - one leak per closed PDF, one
 * frame later.
 *
 * The DOM half of mount/unmount cannot run here (no jsdom), so these drive
 * the gate itself.
 */

import { describe, expect, it, vi } from "vitest";

import { PdfInkController } from "./PdfInkController";

type Private = { mounted: boolean; schedule(): void; sync(): void; probe(): unknown };

function makeController() {
	const frames: FrameRequestCallback[] = [];
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
	};
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => [],
		() => "doc-1"
	);
	return { controller, priv: controller as unknown as Private, frames };
}

describe("the sync gate", () => {
	it("queues nothing before mount", () => {
		const { priv, frames } = makeController();
		priv.schedule();
		expect(frames.length).toBe(0);
	});

	it("queues a frame while mounted", () => {
		const { priv, frames } = makeController();
		priv.mounted = true;
		priv.schedule();
		expect(frames.length).toBe(1);
	});

	it("a frame queued before unmount does not probe or bind after it", () => {
		const { priv, frames } = makeController();
		priv.mounted = true;
		priv.schedule();
		const probe = vi.spyOn(priv, "probe");

		priv.mounted = false; // what unmount() does first
		frames[0]!(0);
		expect(probe).not.toHaveBeenCalled();
	});

	it("a refresh arriving after unmount queues nothing", () => {
		const { controller, priv, frames } = makeController();
		priv.mounted = true;
		priv.mounted = false;
		controller.refresh();
		expect(frames.length).toBe(0);
	});
});
