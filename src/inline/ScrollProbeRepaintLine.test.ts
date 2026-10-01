import { afterEach, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearScrollProbe, formatScrollProbe, scrollProbeRepaint, scrollProbeSchedule } from "./ScrollProbe";

/**
 * The scroll probe's repaint line names what the frame painted and where its time went.
 *
 * On the device a scroll repaint with ink in view read 4 to 8 ms, and the line could not say why: its "+ms" is
 * stamped after the camera sync and the committed paint, so it holds both, and the work kind and the band move
 * were written to the trace mark only. The line now carries the work kind ("all" or the rect count), whether the
 * band moved and whether that move carried its pixels, and the two spans: syncCamera and paintCommittedWork.
 */
const base = {
	camX: -178.94736842105263, camY: -178.94736842105263, documentTop: 77.5, contentLeft: 300, rectLeft: 120, rectTop: -100,
	scale: 1.1176426850344592, scrollLeft: 113, scrollTop: 0, strokesDrawn: 1527, locked: false, driftX: 0, driftY: 0,
};

function repaintLines(): string[] {
	return formatScrollProbe().split("\n").filter(l => / repaint {2}\+/.test(l));
}

describe("scroll probe repaint line", () => {
	afterEach(() => { clearScrollProbe(); setDiagnosticsEnabled(false); });

	it("names the work kind, the band move, the carry and the two spans", () => {
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		scrollProbeSchedule("scroll");
		scrollProbeRepaint({ ...base, work: "all", bandMoved: true, carried: false, syncCameraMs: 0.25, paintMs: 4.5 });
		scrollProbeSchedule("scroll");
		scrollProbeRepaint({ ...base, scrollLeft: 131, work: "0 rect", bandMoved: false, carried: false, syncCameraMs: 0.04, paintMs: 0.01 });
		scrollProbeSchedule("scroll");
		scrollProbeRepaint({ ...base, scrollLeft: 225, work: "1 rect", bandMoved: true, carried: true, syncCameraMs: 0.1, paintMs: 0.6 });
		const lines = repaintLines();
		expect(lines.length, formatScrollProbe()).toBe(3);
		// The existing head of the line is unchanged, so readers of older pastes still parse it.
		for (const l of lines) expect(l).toMatch(/ repaint {2}\+\d+\.\dms {2}cam=\(-178\.95,-178\.95\) docTop=77\.50 contentLeft=300\.00 rect=\(120\.00,-100\.00\) scale=1\.1176426850344592 scroll=\(\d+,0\) strokes=1527/);
		expect(lines[0]).toContain(" work=all band=moved carry=no sync=0.25ms paint=4.50ms");
		expect(lines[1]).toContain(" work=0 rect band=still carry=no sync=0.04ms paint=0.01ms");
		expect(lines[2]).toContain(" work=1 rect band=moved carry=yes sync=0.10ms paint=0.60ms");
	});

	it("names what made a frame redraw everything, the camera move in exponent form, the pan bake and the damage queued", () => {
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		scrollProbeRepaint({ ...base, work: "all", bandMoved: false, carried: false, syncCameraMs: 0.1, paintMs: 4.2, allFrom: "camera", camDeltaX: 4.5e-6, camDeltaY: -1.5e-7, panBaked: false, damageIn: "0 rect" });
		scrollProbeRepaint({ ...base, work: "0 rect", bandMoved: false, carried: false, syncCameraMs: 0.1, paintMs: 0, allFrom: "", camDeltaX: 0, camDeltaY: 0, panBaked: false, damageIn: "0 rect" });
		scrollProbeRepaint({ ...base, work: "all", bandMoved: false, carried: false, syncCameraMs: 0, paintMs: 5, allFrom: "first", panBaked: true, damageIn: "all" });
		const lines = repaintLines();
		expect(lines.length, formatScrollProbe()).toBe(3);
		expect(lines[0]).toContain(" paint=4.20ms from=camera dcam=(4.50e-6,-1.50e-7) bake=no in=0 rect");
		expect(lines[1]).toContain(" paint=0.00ms from=- dcam=(0.00e+0,0.00e+0) bake=no in=0 rect");
		expect(lines[2]).toContain(" paint=5.00ms from=first dcam=- bake=yes in=all");
	});

	it("leaves the fields off a repaint whose caller did not give them", () => {
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		scrollProbeRepaint({ ...base });
		const lines = repaintLines();
		expect(lines.length).toBe(1);
		expect(lines[0]).not.toMatch(/work=|carry=|sync=|paint=|from=|dcam=|bake=|in=/);
	});
});
