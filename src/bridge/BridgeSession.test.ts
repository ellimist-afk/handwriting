/**
 * The session on a fake surface: what it tells the companion and when, how a
 * stroke finds the page mapping it was drawn under, and which pen contacts
 * it claims.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeSession, CLAIM_TTL_MS, type BridgeSurface } from "./BridgeSession";
import type { BridgeGeometry, BridgeOut, BridgePen, BridgePoint } from "./BridgeProtocol";

const GEOMETRY: BridgeGeometry = { kind: "note", rect: { x: 0, y: 100, w: 768, h: 600 }, exclude: [], viewport: { w: 768, h: 1024 }, dpr: 2 };
const PEN: BridgePen = { color: "#112233", width: 2 };
const POINTS: BridgePoint[] = [{ x: 10, y: 120, pressure: 0.5, t: 0 }, { x: 12, y: 121, pressure: 0.6, t: 5 }];

class FakeSurface implements BridgeSurface {
	place: BridgeGeometry | null = GEOMETRY;
	tip: BridgePen | null = PEN;
	scroll = 0;
	landed: Array<{ points: readonly BridgePoint[]; snapshot: unknown }> = [];
	accepts = true;
	geometry = (): BridgeGeometry | null => this.place;
	pen = (): BridgePen | null => this.tip;
	snapshot = (): unknown => ({ scroll: this.scroll });
	land = (points: readonly BridgePoint[], snapshot: unknown): boolean => {
		this.landed.push({ points, snapshot });
		return this.accepts;
	};
}

describe("BridgeSession", () => {
	let sent: BridgeOut[];
	let now: number;
	let session: BridgeSession;
	let surface: FakeSurface;
	const types = (): string[] => sent.map((m) => m.type);

	beforeEach(() => {
		sent = [];
		now = 1000;
		session = new BridgeSession((m) => (sent.push(m), true), () => now);
		surface = new FakeSurface();
	});

	it("says nothing until the companion is there", () => {
		session.attach(surface);
		session.sync();
		expect(sent).toEqual([]);
		expect(session.live).toBe(false);
	});

	it("sends the surface and the pen once connected, and nothing again while they hold", () => {
		session.attach(surface);
		session.connectionOpened();
		expect(sent).toEqual([{ type: "surface", rev: 1, ...GEOMETRY }, { type: "pen", ...PEN }]);
		expect(session.live).toBe(true);
		session.sync();
		session.sync();
		expect(sent.length).toBe(2);
	});

	it("sends a moved surface under a higher revision", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.place = { ...GEOMETRY, rect: { ...GEOMETRY.rect, h: 300 } };
		session.sync();
		expect(sent[2]).toEqual({ type: "surface", rev: 2, ...surface.place });
	});

	it("pauses while the tip is not the pen and resumes with the pen it comes back as", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.tip = null;
		session.sync();
		session.sync();
		expect(types()).toEqual(["surface", "pen", "pause"]);
		expect(session.live).toBe(false);
		surface.tip = { color: "#445566", width: 3 };
		session.sync();
		expect(types()).toEqual(["surface", "pen", "pause", "pen", "resume"]);
		expect(session.live).toBe(true);
	});

	it("closes when the surface leaves the screen or is detached, once", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.place = null;
		session.sync();
		session.sync();
		expect(types()).toEqual(["surface", "pen", "close"]);
		surface.place = GEOMETRY;
		session.sync();
		session.detach(surface);
		expect(types()).toEqual(["surface", "pen", "close", "surface", "pen", "close"]);
	});

	it("says everything again to a companion that reconnects", () => {
		session.attach(surface);
		session.connectionOpened();
		session.connectionClosed();
		expect(session.live).toBe(false);
		session.connectionOpened();
		expect(sent.slice(2)).toEqual([{ type: "surface", rev: 1, ...GEOMETRY }, { type: "pen", ...PEN }]);
	});

	it("places a stroke with the mapping taken when it began, not when it arrived", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.scroll = 40;
		session.handle({ type: "stroke-begin", id: 7, rev: 1 });
		surface.scroll = 400;
		session.handle({ type: "stroke", id: 7, rev: 1, points: POINTS });
		expect(surface.landed).toEqual([{ points: POINTS, snapshot: { scroll: 40 } }]);
		expect(sent[sent.length - 1]).toEqual({ type: "landed", ids: [7] });
	});

	it("lands a stroke on the surface it began on, even after another took over", () => {
		const other = new FakeSurface();
		session.attach(surface);
		session.connectionOpened();
		session.handle({ type: "stroke-begin", id: 1, rev: 1 });
		session.attach(other);
		session.handle({ type: "stroke", id: 1, rev: 1, points: POINTS });
		expect(surface.landed.length).toBe(1);
		expect(other.landed.length).toBe(0);
	});

	it("places a stroke whose beginning never arrived with the page as it is", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.scroll = 9;
		session.handle({ type: "stroke", id: 3, rev: 1, points: POINTS });
		expect(surface.landed[0]!.snapshot).toEqual({ scroll: 9 });
	});

	it("does not acknowledge a stroke the surface could not place", () => {
		session.attach(surface);
		session.connectionOpened();
		surface.accepts = false;
		session.handle({ type: "stroke", id: 3, rev: 1, points: POINTS });
		expect(types()).toEqual(["surface", "pen"]);
	});

	it("drops a stroke when there is no surface at all", () => {
		session.connectionOpened();
		session.handle({ type: "stroke", id: 3, rev: 1, points: POINTS });
		expect(sent).toEqual([]);
	});

	describe("claims", () => {
		beforeEach(() => {
			session.attach(surface);
			session.connectionOpened();
		});

		it("gives each begun stroke to exactly one contact", () => {
			expect(session.takeContact()).toBe(false);
			session.handle({ type: "stroke-begin", id: 1, rev: 1 });
			expect(session.takeContact()).toBe(true);
			expect(session.takeContact()).toBe(false);
		});

		it("a claim outlives a long stroke, and lapses a moment after the stroke ends", () => {
			session.handle({ type: "stroke-begin", id: 1, rev: 1 });
			now += 60_000;
			session.handle({ type: "stroke-begin", id: 2, rev: 1 });
			session.handle({ type: "stroke", id: 1, rev: 1, points: POINTS });
			now += CLAIM_TTL_MS + 1;
			// The first stroke ended long enough ago that the webview is not going to mention it; the second is still down.
			expect(session.takeContact()).toBe(true);
			expect(session.takeContact()).toBe(false);
		});

		it("a claim taken while its stroke is still down is still one claim", () => {
			session.handle({ type: "stroke-begin", id: 1, rev: 1 });
			expect(session.takeContact()).toBe(true);
			session.handle({ type: "stroke", id: 1, rev: 1, points: POINTS });
			expect(session.takeContact()).toBe(false);
		});

		it("a cancelled stroke gives its claim back", () => {
			session.handle({ type: "stroke-begin", id: 1, rev: 1 });
			session.handle({ type: "stroke-cancel", id: 1 });
			expect(session.takeContact()).toBe(false);
			session.handle({ type: "stroke", id: 1, rev: 1, points: POINTS });
			expect(surface.landed[0]!.snapshot).toEqual({ scroll: 0 });
		});

		it("losing the companion drops its claims", () => {
			session.handle({ type: "stroke-begin", id: 1, rev: 1 });
			session.connectionClosed();
			expect(session.takeContact()).toBe(false);
		});
	});
});
