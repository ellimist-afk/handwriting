import { describe, expect, it } from "vitest";
import { StrokeBuilder } from "./StrokeBuilder";
import { emptyPage, parsePage, serializePage } from "../model/PageData";

// New taps only: a pen
// contact whose builder accepted one point was drawn on screen as the nib dot,
// so it is saved as uniform ink, the shape a finger stroke already has.
const fields = (s: { widthMode?: string; pressureProfile?: string; device?: string }) =>
	({ widthMode: s.widthMode, pressureProfile: s.pressureProfile, device: s.device });

describe("a tap is one accepted point, saved as uniform ink", () => {
	it("a pen tap is saved uniform, with no pressure profile; points and pressure kept", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		b.add(10, 20, 0.9, 0);
		expect(b.add(10.05, 20, 0.95, 8)).toBeUndefined();
		const s = b.finishReleaseFiltered()[0]!;
		expect(fields(s)).toEqual({ widthMode: "uniform", pressureProfile: undefined, device: undefined });
		expect(s.points.map((p) => p.pressure)).toEqual([0.9, 0.9]);
		expect(s.width).toBe(2.2);
	});
	it("a mouse tap with the pen tool follows the same rule and keeps its device", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2, undefined, "mouse");
		b.start(0);
		b.add(10, 20, 0.5, 0);
		expect(fields(b.finish()!)).toEqual({ widthMode: "uniform", pressureProfile: undefined, device: "mouse" });
	});
	it("two accepted points under one nib of travel are saved as today", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		b.add(10, 20, 0.9, 0);
		b.add(10.5, 20, 0.9, 8);
		const s = b.finishReleaseFiltered()[0]!;
		expect(s.points).toHaveLength(2);
		expect(fields(s)).toEqual({ widthMode: undefined, pressureProfile: "exp7", device: undefined });
	});
	it("a finger tap and a highlighter tap are saved as today", () => {
		const finger = new StrokeBuilder("pen", "#000", 2.2, undefined, undefined, "uniform");
		finger.start(0);
		finger.add(10, 20, 0.5, 0);
		expect(fields(finger.finish()!)).toEqual({ widthMode: "uniform", pressureProfile: undefined, device: undefined });
		const hl = new StrokeBuilder("highlighter", "#ff0", 12);
		hl.start(0);
		hl.add(10, 20, 0.5, 0);
		expect(fields(hl.finish()!)).toEqual({ widthMode: undefined, pressureProfile: undefined, device: undefined });
	});
	it("the pause snapshot of a one-point contact is the tap the lift saves", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		b.add(10, 20, 0.7, 0);
		const snap = b.snapshotReleaseFiltered()[0]!;
		const saved = b.finishReleaseFiltered()[0]!;
		expect(fields(snap)).toEqual(fields(saved));
		expect(snap.points).toEqual(saved.points);
	});
	it("a uniform tap comes back from the ink file uniform, with no pressure profile", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		b.add(10, 20, 0.9, 0);
		const page = emptyPage("p1");
		page.strokes.push(b.finish()!);
		const back = parsePage(serializePage(page), "p1").data.strokes[0]!;
		expect(fields(back)).toEqual({ widthMode: "uniform", pressureProfile: undefined, device: undefined });
	});
	it("a contact the release filter cuts to one point is saved as today: it was drawn as a ribbon", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		b.add(0, 0, 0.4, 0);
		b.add(4, 0, 0.02, 10);
		const s = b.finishReleaseFiltered();
		expect(s).toHaveLength(1);
		expect(s[0]!.points.map((p) => p.x)).toEqual([0, 0.01]);
		expect(fields(s[0]!)).toEqual({ widthMode: undefined, pressureProfile: "exp7", device: undefined });
	});
});
