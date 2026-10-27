/**
 * The commands of the plugin: every command, gated command and diagnostic command that onload registers, in the
 * order onload registered them. registerCommands is a method of HandwritingPlugin, installed on its prototype when
 * main.ts loads (installRegisterCommands at its bottom) and called from onload at the point the registrations held
 * before. Body moved unchanged from onload. The names main.ts declares at module level and the commands use come in
 * as one argument, so this file imports only types from main.
 */
import { Command, Notice, Platform } from "obsidian";
import { clearGatedCommandActions, inkColorNames, setGatedCommandAction, setRetiredCommandAction } from "../CommandPaletteSplit";
import { activeSlidesActions, slidesInkEnabled } from "../slides/SlidesInkSurface";
import { presentationCommands, requestSlidesAction } from "../slides/SlidesTools";
import { getEraserRadiusPx, getInkSizeMult, getInlineEraserMode, getInlineLassoMode, getInlinePanMode, getInlineSpaceMode, getInlineTool, inkExternallyReloaded, inlineInk, refreshAllStrips, refreshPenToolsAll, setInlineEraserMode, setInlineLassoMode, setInlinePanMode, setInlineSpaceMode, setInlineTool } from "../inline/InkOverlay";
import { INK_SIZE_STEPS, nextInkSize } from "../ink/InkSize";
import { nextEraserSize } from "../ink/EraserSize";
import { registerInkPresetCommands } from "../ink/InkPresetCommands";
import { colorsFor, getInkColorHex, HIGHLIGHTER_COLORS, nextInkColor } from "../ink/InkColor";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { mouseInkEnabled, setMouseInk } from "../inline/MouseInk";
import { nextPaperStyle } from "../inline/Paper";
import { markPenSeen, penSeenThisSession, PenToolsMode, penToolsVisible, setPenToolsMode } from "../inline/PenToolsMode";
import type { NoteCanvasChoice } from "../inline/CanvasNoteOverride";
import { PEN_INK_TOGGLE } from "../inline/MobileTools";
import { PenCommandHost, penOnOff, togglePenInput } from "../inline/PenCommand";
import { FORK_COPY_PLACEHOLDER, ForkHost, forkHostFor, refreshForks } from "../persistence/ForkResolution";
import { ForkResolutionModal } from "../persistence/ForkResolutionModal";
import { runDetached } from "../util/Detached";
import { installMethods } from "../inline/InstallMethods";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		registerCommands(deps: RegisterCommandsDeps): void;
	}
}

/** The module-level names of main.ts the commands use. */
interface RegisterCommandsDeps {
	TRACE_UPLOAD_URL: string;
	loadedBuild: (version: string) => { version: string; sourceCommit: string; sourceTree: string; dirtyStatus: string; verified: boolean };
	penInkCommandHost: PenCommandHost;
	penToggleNoticeText: (on: boolean) => string;
	platformOs: () => string;
	showPenToggleNotice: (message: string) => void;
	showEraserToggleNotice: (message: string) => void;
	showLassoToggleNotice: (message: string) => void;
	showSpaceToggleNotice: (message: string) => void;
	showPanToggleNotice: (message: string) => void;
	showMouseInkToggleNotice: (message: string) => void;
}

	function registerCommands(this: HandwritingPlugin, { TRACE_UPLOAD_URL, loadedBuild, penInkCommandHost, penToggleNoticeText, platformOs, showPenToggleNotice, showEraserToggleNotice, showLassoToggleNotice, showSpaceToggleNotice, showPanToggleNotice, showMouseInkToggleNotice }: RegisterCommandsDeps): void {
		// THE ONE PEN COMMAND (1.4.12). Alan, 2026-09-05: "there are two of
		// these Handwriting: Pen and Handwriting: toggle pen input on/off - i
		// think that's stupid there should only be one" -> "Pen on / off like
		// Mouse on / off". This kept the `inline-tool-pen` id, so a hotkey
		// bound to the old `Pen` still resolves; `pen-ink-toggle` left the
		// palette entirely, and only the palette - see `penInkCommandHost`
		// above and the `setRetiredCommandAction` call below for the strip's
		// keyboard button, which still flips the same switch by that same id.
		//
		// The rule is PenCommand.ts's, not this file's, so it can be tested
		// without an Obsidian; what stays here is the chrome the rule cannot
		// reach and the Notice, which is the pen toggle's own owned slot -
		// this command IS that toggle now, so it does not get a seventh.
		this.addCommand({
			id: "inline-tool-pen",
			name: "Pen on / off",
			callback: () => {
				// The toggle itself is NOT gated - `penOnOff` is what flips the
				// pen and it returns the new state. Only the toast is routine.
				const on = penOnOff(penInkCommandHost);
				if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(on));
			},
		});
		// The eraser used to need a pen with an eraser end. Plenty of pens do
		// not have one (and remote-desktop input drops the flag even when they
		// do), so the mode makes the tip erase. Toggle rather than a one-way
		// switch: the same key gets you out.
		// Mouse ink is a MODE, not a default: claiming the mouse costs text
		// selection, so it stays off until someone without a pen asks for it.
		this.addCommand({
			id: "mouse-ink-toggle",
			name: "Mouse on / off",
			// DECISION, "button should become the truth" addendum (2026-09-05):
			// on a pen-less device with a tool lit, this command's OFF press is
			// a NO-OP for whether the mouse actually draws. `mouseActsAsPen`
			// (MouseInk.ts) ORs this command's `enabled` flag with the derived
			// pen-less grant (`mouseDrawsFromLitTool`) precisely so a device
			// that has never seen a pen keeps drawing with whatever tool is lit
			// regardless of this flag - so toggling `enabled` off here leaves
			// the mouse still drawing via that grant, and the "Handwriting:
			// cursor" toast below is not fully true in that one case.
			// DELIBERATELY NOT CHANGED to compensate (e.g. by also turning pen
			// input off): every brief in this session repeats "leave
			// `mouse-ink-toggle` as the explicit override... exactly as it is",
			// and reaching into `setPenInk` from here to make the toast true
			// again would be exactly the opposite of that instruction. Left as
			// a stated, deliberate no-op rather than a silently-discovered one;
			// see the handoff for the same note.
			callback: () => {
				const on = !mouseInkEnabled();
				setMouseInk(on);
				// THE LOUD PATH, and the only one that writes this down (the
				// settings switch was the other, until 1.4.20 took the row
				// out). Asking for the mode BY NAME is
				// what earns a place in data.json; the strip's quiet arm and
				// put-down do not, and no longer get one - alan, 2026-09-04,
				// "dont persist a quiet arm". See MouseInk.ts for the reports
				// that ruling came out of.
				this.settings.mouseInk = on;
				runDetached(this.persistSettings(), "save the mouse ink setting");
				// Turning mouse ink on IS declaring yourself a pen person: the
				// strip appears without waiting for hardware that never comes.
				// Off puts the nib light out instead (alan, 2026-09-03: dark
				// "until you touch with your pen", and off "at any point").
				// Both surfaces' strip buttons route here rather than
				// touching the mode themselves - their hosts execute this
				// command - so this one branch covers the strip, the palette
				// and the hotkey alike - see `applyMouseInkUiFanout` for both
				// halves and why each needs what it calls.
				this.applyMouseInkUiFanout(on);
				// NAMES THE STATE - not a device, not a tool (alan,
				// 2026-09-05: "maybe Handwriting: ink" "instead of
				// handwriting: pen when you select handwriting: mouse in
				// command palette").
				//
				// This used to name the TOOL the mouse had picked up, under
				// the 2026-08-31 ruling that a pen holding the highlighter
				// says "highlighter". That ruling still governs the pen and
				// highlighter tool commands; it is superseded HERE, and only
				// here, because what this toggle turns on was never about the
				// mouse: "what if we are Handwriting: mouse drawing on and
				// then the dude touches with a pen?". After the switch,
				// whatever touches the glass inks - so a device or a nib in
				// the message is wrong the moment a pen arrives, while "ink"
				// is the state itself and stays true for everything in the
				// room. Echoing the command's own name ("mouse drawing on")
				// was considered and rejected for the same reason.
				//
				// The OFF word is unchanged, and `tipModeOffNotice` matches
				// it deliberately - read its doc comment before editing it.
				showMouseInkToggleNotice(on ? "Handwriting: ink" : "Handwriting: cursor");
			},
		});
		// THE ONLY WAY A PERSON CAN REACH A PRESERVED FORK. Adoption keeps both
		// revisions and says nothing on success (`d50534a`, settled), and both
		// artifacts live in the ink folder - `.handwriting` by default, which
		// Obsidian will not browse. Nothing else in the plugin enumerates them:
		// every folder sweep skips `.conflict-` names on purpose. Registered
		// outside the live-reload block above because `LiveReloadTestHarness`
		// slices that block out of this file and executes it with a fixed list
		// of injected names.
		this.addCommand({
			id: "resolve-ink-fork",
			name: FORK_COPY_PLACEHOLDER.commandName,
			callback: () => {
				const host: ForkHost = forkHostFor({
					adapter: this.app.vault.adapter,
					store: this.store,
					deviceId: this.installId(),
					// A scanned pair carries only a page id; these two name it. The
					// note lookup is the startup census, so it answers after a
					// restart; a closed PDF is named by its sidecar's own path.
					pathForNote: (pageId) => this.notePathFor(pageId),
					// A sidecar keeps every path it was claimed at; the first that still
					// exists is the PDF now, else the newest claim.
					pathForPdf: async (pageId) => {
						const claimed = (await this.store.readPdfPaths(pageId)) ?? [];
						return claimed.find((p) => this.app.vault.getFileByPath(p) !== null) ?? claimed[claimed.length - 1] ?? null;
					},
					// A restored page goes through the open note or PDF that
					// holds it, so the screen shows it and the next save keeps it.
					restoreOpen: async (pageId, data) => {
						const path = await inlineInk.restoreRevision(pageId, data);
						if (path) {
							inkExternallyReloaded(path);
							return true;
						}
						if (this.pdfStore.restoreRevision(pageId, data)) {
							for (const [root, controller] of this.pdfInk) {
								if (this.pdfIds.get(root) === pageId) controller.refresh();
							}
						}
						return false;
					},
				});
				// Every folder a page can be served from: a fork found at load
				// is preserved beside the served copy, which need not be in the
				// configured folder.
				runDetached(
					(async () => {
						for (const folder of this.store.inkFolders()) await refreshForks(host, folder);
						new ForkResolutionModal(this.app, host).open();
					})(),
					"open the fork resolution list"
				);
			},
		});
		for (const command of presentationCommands(
			() => activeSlidesActions(typeof activeDocument === "undefined" ? document : activeDocument),
			(target, action) => requestSlidesAction(this.app, target, action)
		)) this.addCommand(command);
		this.addCommand({
			id: "slides-ink-toggle",
			name: "Toggle slides ink",
			callback: () => {
				const on = !slidesInkEnabled();
				this.settings.slidesInk = on;
				runDetached(this.persistSettings(), "save the slides ink setting");
				this.applySlidesInk(on);
				new Notice(
					on
						? "Handwriting: slides ink on (start a presentation, then draw)"
						: "Handwriting: slides ink off"
				);
			},
		});
				this.addCommand({
			id: "paper-cycle",
			name: "Paper: none / lines / grid / dots",
			callback: () => {
				const next = nextPaperStyle(this.settings.paperStyle);
				this.settings.paperStyle = next;
				this.applyPaper(next);
				runDetached(this.persistSettings(), "save the paper style");
				if (routineNoticesVisible()) new Notice(`Handwriting: paper ${next}`);
			},
		});
		// INFINITE CANVAS FOR ONE NOTE. The setting is the default; a
		// note may say otherwise in its own frontmatter, exactly as it may
		// override the paper. Three choices, so one command cycles on -> off
		// -> use default rather than needing three ids or a modal: the same
		// shape as `paper-cycle` above, which is the command this feature was
		// asked to behave like.
		//
		// The notice is not gated on `routineNoticesVisible`, unlike the paper
		// cycle's: a frontmatter key is invisible until the user opens
		// Properties, so without a word on screen a three-way cycle gives no
		// way to tell which of the three you are now on.
		this.addCommand({
			id: "canvas-note-override-cycle",
			name: "Infinite canvas for this note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				// Markdown only: the override is a frontmatter key, and
				// `saveForPath` would refuse a PDF or a canvas file anyway.
				// Checked before the command is offered rather than after it
				// is run, so the palette does not list an id that cannot work.
				if (!file || file.extension !== "md") return false;
				if (checking) return true;
				const current: NoteCanvasChoice = this.canvasOverride?.choice(file.path) ?? "default";
				this.applyCanvasChoice(file.path, current === "default" ? true : current === true ? false : "default");
				return true;
			},
		});
		// The toolbar off and on from the palette or a hotkey, without the settings tab. Writes the same setting the
		// Toolbar visibility row writes, through the same applier, and remembers what it hid.
		// Registered outright: with the toolbar hidden it is the way back.
		//
		// THE TOOLBAR ONLY, since 1.4.20. It used to move the zoom bar with it. The zoom bar now
		// answers to its own row AND to Infinite Canvas, so a command that hid it took a decision away from both -
		// and with the canvas off there is no zoom bar on screen for this command to put back. `barsRestore` keeps
		// its shape in data.json: the zoom bar's mode is carried into the memory unchanged and never read back out.
		// The id does not move - a hotkey bound to it still resolves.
		this.addCommand({
			id: "toolbar-zoom-bar-toggle",
			name: "Toolbar on / off",
			callback: () => {
				// Decided from what is ON SCREEN, not from the setting alone: under Auto on desktop the strip
				// stays off until a pen is seen, and treating that as "on" saved "hide" with nothing to hide.
				// A remembered mode that would still leave the strip off comes back as "show".
				const onScreen = (m: PenToolsMode): boolean => penToolsVisible(m, Platform.isMobileApp, penSeenThisSession());
				const hidden = !onScreen(this.settings.penTools);
				const remembered = this.settings.barsRestore?.penTools;
				const next: PenToolsMode = hidden ? (remembered && onScreen(remembered) ? remembered : "show") : "hide";
				this.settings.barsRestore = hidden
					? null
					: { penTools: this.settings.penTools, noteZoomControls: this.settings.noteZoomControls };
				this.settings.penTools = next;
				setPenToolsMode(next);
				refreshPenToolsAll();
				runDetached(this.persistSettings(), "save the toolbar visibility");
				if (routineNoticesVisible()) new Notice(`Handwriting: toolbar ${next === "hide" ? "off" : "on"}`);
			},
		});
		// THE SPLIT (1.4.12). "Extra commands for hotkeys" gates REGISTRATION -
		// what the palette lists and what a hotkey can bind - and nothing else.
		// EXACTLY ONE of the two routes is live per command: registered here, or
		// filed with `setGatedCommandAction` for the strip - filed for the ones
		// kept OUT of the palette, and only those. The pen toolbar's own eraser,
		// lasso, insert-space and pan buttons run these ids through
		// `executeCommandById`, so un-registering them alone would have left four
		// dead buttons on a default install; filing an action for a command the
		// palette DOES hold would give the strip a second answer for it. (An
		// earlier version of this comment said the action was filed "either way",
		// which the two lines below have never done.) See CommandPaletteSplit.ts,
		// which also holds the table the settings row and the test read, so the
		// list under the switch is the list that registers here - and
		// `planGatedCommands`, which keeps the one-route rule when the switch
		// moves without a reload.
		clearGatedCommandActions();
		this.gatedCommandDefs.clear();
		// THE ONE ID THE PALETTE NO LONGER HOLDS, filed here because the strip
		// still names it. `pen-ink-toggle` left the palette in 1.4.12 (alan:
		// "there should only be one"), but the keyboard button's `commandId`,
		// `DEFAULT_FOLD_ORDER` and every fold order already saved to disk are
		// all written in it, so the button's `exec` still arrives with it in
		// hand. `setRetiredCommandAction` answers it forever and is invisible
		// to the "Extra commands for hotkeys" plan - which would otherwise
		// unfile it the moment the switch went on and leave the button dead.
		// See CommandPaletteSplit.ts's `retired` map for that trap in full.
		//
		// The button's MEANING is unchanged: flip the pen-input switch, and
		// nothing else. It is only built where a pen has been seen, and a pen
		// user coming back from typing is not asking to have the highlighter
		// taken out of their hand - so this is `togglePenInput`, not the
		// command's `penOnOff`. One flag either way, so the two never disagree.
		setRetiredCommandAction(PEN_INK_TOGGLE, () => {
			// As above: `togglePenInput` performs the toggle. Gate the toast only.
			const on = togglePenInput(penInkCommandHost);
			if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(on));
		});
		const addGatedCommand = (cmd: Command): void => {
			// Copied, and copied BEFORE registration. `addCommand` hands the
			// command back (obsidian.d.ts) and the palette shows these under the
			// plugin's own id and name, so a definition that has been through it
			// once is not one to hand back to it later.
			this.gatedCommandDefs.set(cmd.id, { ...cmd });
			if (this.settings.colorSizeCommands) this.addCommand(cmd);
			else if (cmd.callback) setGatedCommandAction(cmd.id, cmd.callback);
		};
		addGatedCommand({
			id: "inline-tool-eraser",
			name: "Toggle eraser on / off",
			callback: () => {
				const on = !getInlineEraserMode();
				setInlineEraserMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showEraserToggleNotice(on ? "Handwriting: eraser" : this.tipModeOffNotice());
			},
		});
		// Lasso as a mode: the side button was the only way in, and every
		// apple pencil and every mouse lacks one. Exclusive with the eraser.
		addGatedCommand({
			id: "inline-tool-lasso",
			name: "Toggle lasso on / off",
			callback: () => {
				const on = !getInlineLassoMode();
				setInlineLassoMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showLassoToggleNotice(on ? "Handwriting: lasso" : this.tipModeOffNotice());
			},
		});
		// Insert space as a mode, same shape as lasso: plant a divider with
		// the tip, drag down to open room, drag up to close it. Pen exits.
		addGatedCommand({
			id: "inline-tool-space",
			name: "Toggle insert space on / off",
			callback: () => {
				const on = !getInlineSpaceMode();
				setInlineSpaceMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showSpaceToggleNotice(on ? "Handwriting: insert space" : this.tipModeOffNotice());
			},
		});
		// Pan as a mode: touch already pans by finger, but a pen on glass had
		// no way to move the page without marking it.
		addGatedCommand({
			id: "inline-tool-pan",
			name: "Toggle pan on / off",
			callback: () => {
				const on = !getInlinePanMode();
				setInlinePanMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showPanToggleNotice(on ? "Handwriting: pan" : this.tipModeOffNotice());
			},
		});
		addGatedCommand({
			id: "eraser-size-cycle",
			name: "Eraser size: next",
			callback: () => {
				const next = nextEraserSize(getEraserRadiusPx());
				runDetached(this.setEraserSize(next.radiusPx, next.name), "save the eraser size", () =>
					new Notice("Handwriting: the eraser size changed, but the setting could not be saved")
				);
			},
		});
		// Nib sizes (OneNote-style): three steps on the ACTIVE tool, plus a
		// cycle command for a hotkey. Applies from the next stroke; persisted.
		// Eleven per-colour and per-size entries buried the pen commands:
		// the palette shows the same colours as swatches you can see, and
		// the cycle commands cover the rest. Behind a setting for anyone who
		// wants one hotkey per colour.
		// Quick pens' sixteen entries (design §10), behind the same switch as
		// every other per-value command and registered from their own file so
		// this gains one line rather than sixteen blocks.
		//
		// Through `addGatedCommand`, not `this.addCommand` behind a second
		// reading of `colorSizeCommands`: the switch is spelled ONCE in this
		// method, which is the whole point of the helper. `registerInkPresetCommands`
		// only wants something with `addCommand`, so the helper stands in as
		// that host and the preset table needs no knowledge of the split.
		registerInkPresetCommands({ addCommand: addGatedCommand });
		for (const step of INK_SIZE_STEPS) {
			addGatedCommand({
				id: `ink-size-${step.name}`,
				name: `Ink size: ${step.name}`,
				callback: () => {
					runDetached(this.setInkSize(step.mult, step.name), "save the ink size", () =>
						new Notice("Handwriting: the ink size changed, but the setting could not be saved.")
					);
				},
			});
		}
		addGatedCommand({
			id: "ink-size-cycle",
			name: "Ink size: next",
			callback: () => {
				const next = nextInkSize(getInkSizeMult(getInlineTool()));
				runDetached(this.setInkSize(next.mult, next.name), "save the ink size", () =>
					new Notice("Handwriting: the ink size changed, but the setting could not be saved")
				);
			},
		});
		// Ink colors: one command per palette name (union of both palettes),
		// acting on the ACTIVE tool, the same model as the size commands. A name
		// the active tool's palette lacks reports instead of guessing.
		{
			// The union, from the split table rather than spelled again here:
			// the settings row prints these names and this loop registers
			// them, and one list is the only way those two stay equal.
			const names = inkColorNames();
			{
				for (const name of names) {
					addGatedCommand({
						id: `ink-color-${name}`,
						name: `Ink color: ${name}`,
						callback: () => {
							const tool = getInlineTool();
							const choice = colorsFor(tool).find((c) => c.name === name);
							if (!choice) {
								new Notice(
									`Handwriting: the ${tool} has no ${name}. Its colors are ${colorsFor(tool)
										.map((c) => c.name)
										.join(", ")}.`
								);
								return;
							}
							// Picking a color from lasso or eraser mode picked
							// NOTHING up - white chosen, lasso still armed
							// (glass, 2026-08-31). Choosing a color reaches
							// for the nib that wears it, here like everywhere.
							this.pickUpNib(tool);
							runDetached(this.setInkColor(tool, choice.hex, choice.name), "save the ink color", () =>
								new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
							);
						},
					});
				}
				// Highlighter by name: one hotkey takes you from anything to
				// highlighting in that color. Its own palette's names only,
				// so there is no wrong-tool case to report.
				for (const c of HIGHLIGHTER_COLORS) {
					addGatedCommand({
						id: `highlighter-color-${c.name}`,
						name: `Highlighter color: ${c.name}`,
						callback: () => {
							this.pickUpNib("highlighter");
							runDetached(this.setInkColor("highlighter", c.hex, c.name), "save the ink color", () =>
								new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
							);
						},
					});
				}
			}
		}
		this.registerExportSelectionCommands();
		addGatedCommand({
			id: "ink-color-cycle",
			name: "Ink color: next",
			callback: () => {
				const tool = getInlineTool();
				const next = nextInkColor(tool, getInkColorHex(tool));
				this.pickUpNib(tool);
				runDetached(this.setInkColor(tool, next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		// "Ink color: next" answers for the tool in hand, and so do the
		// strip's swatches. These two each always mean their tool, and
		// choosing the color picks the tool up (pickUpNib) - one command
		// from anything to drawing in that color.
		addGatedCommand({
			id: "highlighter-color-cycle",
			name: "Highlighter color: next",
			callback: () => {
				const next = nextInkColor("highlighter", getInkColorHex("highlighter"));
				this.pickUpNib("highlighter");
				runDetached(this.setInkColor("highlighter", next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		addGatedCommand({
			id: "pen-color-cycle",
			name: "Pen color: next",
			callback: () => {
				const next = nextInkColor("pen", getInkColorHex("pen"));
				this.pickUpNib("pen");
				runDetached(this.setInkColor("pen", next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		this.addCommand({
			id: "inline-tool-highlighter",
			name: "Highlighter",
			callback: () => {
				// Asking for a pen tool is asking for the pen UI: without
				// this, the command worked invisibly when no pen had been seen
				// and the palette appeared to do nothing.
				markPenSeen();
				refreshPenToolsAll();
				setInlineTool("highlighter");
				setInlineEraserMode(false);
				setInlineLassoMode(false);
				setInlineSpaceMode(false);
				setInlinePanMode(false);
				// The tool state alone does not repaint a toolbar: without this the
				// Highlighter button stayed unlit after the command (audit 104).
				refreshAllStrips();
				if (routineNoticesVisible()) new Notice("Handwriting: highlighter");
			},
		});
		this.registerDiagCommands({ TRACE_UPLOAD_URL, loadedBuild, platformOs });
	}

export function installRegisterCommands(proto: HandwritingPlugin): void {
	installMethods(proto, {
		registerCommands,
	});
}
