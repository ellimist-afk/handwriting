/**
 * The diagnostics commands: the bug report, the traces, the probes and the reports, in the order registerCommands
 * registered them. registerDiagCommands is a method of HandwritingPlugin, installed on its prototype when main.ts
 * loads and called once from registerCommands at the point the registrations held before. Body moved unchanged.
 */
import { installMethods } from "../inline/InstallMethods";
import { Notice, Platform, requestUrl } from "obsidian";
import { formatHost } from "../diag/PlatformCapabilities";
import { copyInlineInkMetrics, copyInlineZoomReport, copyPresentationReport, copyRegionCensus, refreshAllStrips } from "../inline/InkOverlay";
import { captureInlinePenTrace, clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouter";
import { clearHitProbe, formatHitReport, isHitProbeEnabled, setHitProbeEnabled } from "../inline/PenHitProbe";
import { clearScrollProbe, formatScrollProbe } from "../inline/ScrollProbe";
import { diagnosticsEnabled, diagnosticsEpoch, endRecordingIfCurrent, setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { mouseInkEnabled } from "../inline/MouseInk";
import { DiagnosticTextModal, showDiagnosticText } from "../diag/DiagnosticTextModal";
import { pdfInkReport } from "../pdf/PdfInkReport";
import { clearPdfPanTrace, formatPdfPanTrace } from "../pdf/PdfPanTrace";
import { runDetached } from "../util/Detached";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		registerDiagCommands(deps: RegisterDiagCommandsDeps): void;
	}
}

/** The module-level names of main.ts this phase uses. */
interface RegisterDiagCommandsDeps {
	TRACE_UPLOAD_URL: string;
	loadedBuild: (version: string) => { version: string; sourceCommit: string; sourceTree: string; dirtyStatus: string; verified: boolean };
	platformOs: () => string;
}

	function registerDiagCommands(this: HandwritingPlugin, { TRACE_UPLOAD_URL, loadedBuild, platformOs }: RegisterDiagCommandsDeps): void {
		// The pen lifecycle trace. To capture one failing stroke: turn
		// diagnostics recording on, clear the trace, draw the stroke, show the
		// trace, turn recording off.
		this.addCommand({
			id: "copy-inline-pen-trace",
			name: "Bug report: show as text",
			callback: () => {
				if (this.guardEmptyTrace()) return;
				// Viewing a report is the end of the capture: what you see
				// is what you deliver, and recording stops here so nobody
				// has to remember a toggle before they're done. Only Bug
				// report: record starts it again (Alan, 2026-09-02: "yes
				// viewing a bug report should stop recording" - "i dont
				// want them to have to toggle recording off, that's an
				// extra step no one will do").
				setDiagnosticsEnabled(false);
				this.syncRecordingBadge();
				refreshAllStrips();
				const epochAtOpen = diagnosticsEpoch();
				new DiagnosticTextModal(
					this.app,
					"Handwriting pen trace",
					formatInlinePenTrace(),
					undefined,
					() => {
						// A newer recording began while this window was open: not ours to end.
						if (!endRecordingIfCurrent(epochAtOpen)) return;
						// Cleared as well: a delivered report is DONE. Leaving the
						// rows made the next send show stale data while new
						// scribbles went unrecorded - the same dead-recorder trap
						// wearing a different face. The open modal keeps its own
						// snapshot, so every button in it still works.
						clearInlinePenTrace();
						this.syncRecordingBadge();
						refreshAllStrips();
					}
				).open();
			},
		});
		// The machine-readable twin: what becomes a replay fixture in
		// test/traces/. The table above stays for humans and GitHub issues;
		// this one carries floats, coalesced samples, and the world the
		// events landed in - a pointerdown at (400, 300) means nothing
		// without dpr, viewport and settings.
		this.addCommand({
			id: "copy-inline-pen-trace-json",
			name: "Bug report: send",
			callback: () => {
				if (this.guardEmptyTrace()) return;
				// Viewing a report is the end of the capture: what you see
				// is what you deliver, and recording stops here so nobody
				// has to remember a toggle before they're done. Only Bug
				// report: record starts it again (Alan, 2026-09-02: "yes
				// viewing a bug report should stop recording" - "i dont
				// want them to have to toggle recording off, that's an
				// extra step no one will do").
				setDiagnosticsEnabled(false);
				this.syncRecordingBadge();
				refreshAllStrips();
				const capture = captureInlinePenTrace({
					loadedBuild: loadedBuild(this.manifest.version),
					// Host flags, not navigator.userAgent: the directory review
					// reads a UA lookup as OS sniffing, and Platform answers the
					// same question honestly. The device model goes with it.
					host: formatHost({
						isDesktopApp: Platform.isDesktopApp,
						isMobileApp: Platform.isMobileApp,
						isIosApp: Platform.isIosApp,
						isAndroidApp: Platform.isAndroidApp,
						isTablet: Platform.isTablet,
						isPhone: Platform.isPhone,
					}),
					os: platformOs(),
					dpr: window.devicePixelRatio,
					viewport: { w: window.innerWidth, h: window.innerHeight },
					settings: {
						inkSmoothing: this.settings.inkSmoothing,
						strokePrediction: this.settings.strokePrediction,
						booxMode: this.settings.booxMode,
						pressureSensitivity: this.settings.pressureSensitivity,
						mouseInk: this.settings.mouseInk,
						// Both, because since the quiet arm stopped being written
						// down these two disagree: a mouse click on a tool arms
						// the mode for the session over a stored `false`, and a
						// trace that reported only the setting said the mouse was
						// not inking while the strokes in the same file came off
						// a mouse.
						mouseInkLive: mouseInkEnabled(),
						eraserMode: this.settings.eraserMode,
						eraserRadiusPx: this.settings.eraserRadiusPx,
					},
				});
				const epochAtOpen = diagnosticsEpoch();
				new DiagnosticTextModal(
					this.app,
					"Handwriting pen trace (replay JSON)",
					JSON.stringify(capture, null, "\t"),
					TRACE_UPLOAD_URL === ""
						? undefined
						: async (text: string) => {
								const res = await requestUrl({
									url: TRACE_UPLOAD_URL + "/upload",
									method: "POST",
									contentType: "application/json",
									body: text,
									throw: false,
								});
								// `json` is typed any: read the one field through a shape, so
								// nothing else in the body is trusted.
								const id: unknown = (res.json as { id?: unknown } | null | undefined)?.id;
								const accepted = typeof id === "number" || (typeof id === "string" && id !== "");
								if (res.status !== 200 || !accepted) {
									throw new Error(`upload refused (${res.status})`);
								}
								return String(id);
							}
,
					// Delivering the report - by ANY door - ends the recording.
					() => {
						// A newer recording began while this window was open: not ours to end.
						if (!endRecordingIfCurrent(epochAtOpen)) return;
						// Cleared as well: a delivered report is DONE. Leaving the
						// rows made the next send show stale data while new
						// scribbles went unrecorded - the same dead-recorder trap
						// wearing a different face. The open modal keeps its own
						// snapshot, so every button in it still works.
						clearInlinePenTrace();
						this.syncRecordingBadge();
						refreshAllStrips();
					}				).open();
			},
		});
		// The deep diagnostics are instruments, not features. Off by
		// default so the palette shows the pen before the probes; the
		// developer diagnostics setting brings them back after a reload.
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "toggle-pdf-ink-calibration",
			name: "Diagnostics: PDF ink calibration marks",
			callback: () => {
				// The M1 oracle: green crosses at the same coordinates the test
				// fixture prints its red registration marks at. If the two
				// coincide, ink stored in page points is drawn where those
				// points say. Page 1 and every tenth page, so page SELECTION is
				// checked too and not just position.
				this.pdfCalibration = !this.pdfCalibration;
				this.syncPdfControllers();
				for (const c of this.pdfInk.values()) c.refresh();
				new Notice(
					this.pdfCalibration
						? "Handwriting: PDF calibration marks on (page 1 and every 10th)"
						: "Handwriting: PDF calibration marks off"
				);
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "show-pdf-view-report",
			name: "Diagnostics: show PDF view report",
			callback: () => {
				const controllers = [...this.pdfInk.values()]
					.map((c, i) => `--- ink controller ${i + 1} ---\n${c.describe()}`)
					.join("\n");
				const body =
					`${pdfInkReport(this.app)}\n\n` +
					`reload poll: ${this.pollStats.ticks} ticks, ${this.pollStats.checks} checks ` +
					`(${this.pollStats.hidden} skipped hidden, ${this.pollStats.spaced} spaced ` +
					`out; every tick was a check before today)\n` +
					`calibration marks: ${this.pdfCalibration ? "ON" : "off"}\n` +
					`${controllers || "(no ink controller attached)"}`;
				showDiagnosticText(this.app, "Handwriting PDF view report", body);
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "show-ink-metrics",
			name: "Diagnostics: show ink metrics",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting ink metrics", copyInlineInkMetrics());
			},
		});
		if (this.settings.devDiagnostics) {
			// A Chromium trace of the ink pipeline, saved into the plugin folder.
			this.addCommand({
				id: "start-ink-trace",
				name: "Diagnostics: start ink trace",
				callback: async () => {
					new Notice(await this.inkTrace.start());
				},
			});
			this.addCommand({
				id: "stop-ink-trace",
				name: "Diagnostics: stop ink trace",
				callback: async () => {
					new Notice(await this.inkTrace.stop((text) => new Notice(text)));
				},
			});
		}
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "clear-inline-pen-trace",
			name: "Diagnostics: clear pen trace",
			callback: () => {
				clearInlinePenTrace();
				new Notice("Handwriting: pen trace cleared");
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "copy-inline-zoom-report",
			name: "Diagnostics: show zoom report",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting zoom report", copyInlineZoomReport());
			},
		});

		// Dead-region diagnosis: what the page has under a client point, and
		// what every pen pointerdown's dispatch actually looked like.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "toggle-inline-hit-probe",
				name: "Diagnostics: toggle pointer hit probe",
				callback: () => {
					const on = !isHitProbeEnabled();
					setHitProbeEnabled(on);
					if (on) clearHitProbe();
					new Notice(`Handwriting: pointer hit probe ${on ? "on. Hover, then touch down." : "off"}`);
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-inline-hit-report",
				name: "Diagnostics: show pointer hit report",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting pointer hit report", formatHitReport());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-inline-hit-probe",
				name: "Diagnostics: clear pointer hit probe",
				callback: () => {
					clearHitProbe();
					new Notice("Handwriting: pointer hit probe cleared");
				},
			});
		}
		// Touchpad dead-zone diagnosis: the wheel/scroll/repaint pipeline,
		// always recording. Capture: clear -> touchpad-scroll -> draw inside
		// and outside the dead zone -> show the report. Then repeat with touchscreen
		// scrolling as the control.
		// Presentation ground truth: what is actually in the composited frame
		// and what paints above the ink at the last stroke's screen box.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-region-census",
				name: "Diagnostics: show region census",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting region census", copyRegionCensus());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-presentation-capture",
				name: "Diagnostics: show presentation capture",
				callback: () => {
					runDetached(
						copyPresentationReport().then((report) =>
							showDiagnosticText(this.app, "Handwriting presentation capture", report)
						),
						"prepare a presentation capture",
						() =>
							new Notice(
								"Handwriting: could not prepare the presentation capture. See the developer console."
							)
					);
				},
			});
		}
		// Investigation instruments (scroll trace, pen trace, presentation
		// capture) are kept but explicitly invoked: recording is OFF by
		// default and costs one boolean check per event while off.
		this.addCommand({
			id: "toggle-diagnostics",
			name: "Bug report: record",
			callback: () => {
				const on = !diagnosticsEnabled();
				setDiagnosticsEnabled(on);
				this.syncRecordingBadge();
				refreshAllStrips();
				new Notice(`Handwriting: recording ${on ? "on" : "off"}`);
			},
		});
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-inline-scroll-trace",
				name: "Diagnostics: show scroll trace",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting scroll trace", formatScrollProbe(loadedBuild(this.manifest.version)));
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-inline-scroll-trace",
				name: "Diagnostics: clear scroll trace",
				callback: () => {
					clearScrollProbe();
					new Notice("Handwriting: scroll trace cleared");
				},
			});
		}
		// What this plugin costs on a moving pdf (PdfPanTrace.ts): one row per
		// Pan-tool move, and - since 1.4.12 - one per NATIVE scroll of the
		// viewer, which is the half a pan trace could never see. The command
		// keeps the name it was registered under; the rows say which kind
		// they are.
		//
		// The same pan measured on this desktop showed nothing at all, so the
		// columns that matter are the ones a desktop mouse could not vary -
		// the pointerType holding the page and whether Chromium delivered the
		// batch coalesced - beside the handler time and the wait for the next
		// animation frame.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-pdf-pan-trace",
				name: "Diagnostics: show PDF pan trace",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting PDF pan trace", formatPdfPanTrace());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-pdf-pan-trace",
				name: "Diagnostics: clear PDF pan trace",
				callback: () => {
					clearPdfPanTrace();
					new Notice("Handwriting: PDF pan trace cleared");
				},
			});
		}

		// The probe view is the whole point of this build, and a registered view
		// with nothing to open it is unreachable: there is no UI in Obsidian for
		// opening a view type by name. A remote tester needs one palette entry.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "open-pen-diagnostics",
				name: "Diagnostics: open pen probe",
				callback: () => {
					runDetached(this.openPenDiagnostics(), "open the pen probe");
				},
			});
		}
	}

export function installRegisterDiagCommands(proto: HandwritingPlugin): void {
	installMethods(proto, {
		registerDiagCommands,
	});
}
