/**
 * The plugin's settings model: the HandwritingSettings shape, DEFAULT_SETTINGS, and the pure helpers the settings read
 * and merge use (isPlainObject, pressureChoiceFrom). Moved unchanged from main.ts, which imports DEFAULT_SETTINGS and the
 * type back and re-exports the type, so every import of HandwritingSettings from main still resolves.
 */
import { DEFAULT_ERASER_RADIUS_PX } from "../ink/EraserSize";
import { InkPreset } from "../ink/InkPresets";
import { HIGHLIGHTER_COLORS, PEN_COLORS } from "../ink/InkColor";
import { PaperStyle } from "../inline/Paper";
import { PdfPageAssumption } from "../ink/InkPdf";
import { PenToolsMode } from "../inline/PenToolsMode";
import { NoteZoomControlsMode } from "../inline/NoteZoomControlsMode";
import { type BarsPair } from "../inline/BarsToggle";
import { DEFAULT_FOLD_ORDER } from "../inline/MobileTools";
import { DEFAULT_INK_FOLDER } from "../persistence/InkFolder";
import { DEFAULT_TOOLBAR_CORNER, ToolbarCorner } from "../inline/ToolbarCorner";

export interface HandwritingSettings {
	/** Named locations use their own schema; opaque records survive older builds. */
	savedViews: unknown[];
	/**
	 * Per-page camera, kept out of the synced note on purpose (§22). The retired
	 * canvas page's per-note cameras: read, copied and removed with their note,
	 * never interpreted.
	 */
	cameras: Record<string, Record<string, unknown>>;
	/** Nib size multipliers per tool (v0.13.6): 0.6 fine · 1 medium · 1.8 bold. */
	inkSizes: { pen: number; highlighter: number };
	/**
	 * Shaped ink rendering (v0.13.10): velocity thinning, filtered pressure
	 * Off pins pressure to its no-pressure value, so width stops following how
	 * hard you press. Speed thinning and the endpoint taper stay in both
	 * states. Applied at render time, so flipping this restyles every stroke
	 * ever written.
	 */
	pressureSensitivity: boolean;
	/**
	 * The same choice under a second key. A 1.4.20 build launching on a synced vault pins
	 * `pressureSensitivity` back to true and saves; it never touches this key, so this one keeps
	 * the real choice. Read first, and every save writes both. `pressureSensitivity` is never removed.
	 */
	pressureChoice: boolean;
	/** Shaped ribbon: velocity thinning and the start/end taper. */
	inkSmoothing: boolean;
	/**
	 * Draw near-black ink light on the DARK theme. Default on.
	 *
	 * One direction only: the light theme is left exactly as stored. Render
	 * time either way - the stroke keeps the colour it was written or
	 * imported with, and turning this off paints it again. It exists because
	 * OneNote exports its ink as #000000 and Obsidian's dark theme paints the
	 * page near-black, so an imported page reads as blank (alan, 2026-09-04).
	 */
	inkAdaptsToTheme: boolean;
	/**
	 * Guarantee exported ink is readable where it lands. Default ON.
	 *
	 * The opposite default to `inkAdaptsToTheme` above, and deliberately so
	 * (alan, 2026-09-08: "export toggle should default on"). On screen you are
	 * looking at your own canvas and the expected behaviour is the colour you
	 * picked; in an export you are producing something for elsewhere and the
	 * expected behaviour is that you can read it. Same principle, opposite
	 * answers - which is why the settings copy has to say so.
	 *
	 * Render time only, like the other one: nothing rewrites a stored colour.
	 */
	inkReadableInExports: boolean;
	/**
	 * Whether flattening ink into an existing PDF may assume that PDF's pages
	 * are white. Default true.
	 *
	 * Separate from the setting above because the two know different things.
	 * An export or a snip is a page Handwriting makes, so its colour is a fact;
	 * a flatten writes onto pages somebody else made, read as a dictionary and
	 * never as pixels, so white is a guess. It is the right guess for almost
	 * every document and the wrong one for grey or dark stock, where it makes
	 * light ink LESS readable than leaving it alone would. Render time only:
	 * nothing rewrites a stored colour.
	 */
	inkPdfColorMode: PdfPageAssumption;
	/** Vault folder holding the ink sidecars. Default `.handwriting`. */
	inkFolder: string;
	/** Which corner the floating pen toolbar parks in. Default top-right. */
	toolbarCorner: ToolbarCorner;
	/**
	 * The order the strip's buttons leave the first row in when the pane is
	 * too narrow for all of them (alan, 2026-09-05: "maybe we can have a way
	 * you can rearrange the symbols in the fold list").
	 *
	 * Command ids, and only ids that are allowed to fold - see
	 * `normalizeFoldOrder` in MobileTools.ts, which is what makes a file
	 * written by any build safe to read here. The default is
	 * `DEFAULT_FOLD_ORDER`, not restated in this file, so the ids have one
	 * home.
	 */
	stripFoldOrder: string[];
	/** Selected ink color per tool (v0.13.6), hex. */
	inkColors: { pen: string; highlighter: string };
	/**
	 * Which note owned each page id last session (v0.13.6). This is the
	 * cross-session evidence that lets a duplicate discovered at startup
	 * (a copy made while the app was closed) resolve safely: the remembered
	 * path is the original, everything else carrying the id is a copy.
	 */
	pageOwners: Record<string, string>;
	/** Eraser radius in screen px (v0.13.13): 8 fine, 14 medium, 28 bold. */
	eraserRadiusPx: number;
	/** Mouse-ink mode (v0.13.16): left mouse button draws like a pen tip. */
	mouseInk: boolean;
	strokePrediction: boolean;
	booxMode: boolean;
	/**
	 * Latch: has this vault already been told once that its ink is arriving
	 * late and Boox mode might help? Not a settings-UI row - it exists only
	 * so the hint (see EinkHint.ts) fires at most once per install rather
	 * than once per session.
	 */
	einkHintOffered: boolean;
	/**
	 * Latch: has this vault already seen the iPad Scribble warning? Internal
	 * persistence only, never a settings-UI row.
	 */
	scribbleHintOffered: boolean;
	/** Ruled paper background (v0.13.16): none, lines, grid or dots. Per device. */
	paperStyle: PaperStyle;
	extendCanvasWhileScrolling: boolean;
	/**
	 * Hide Obsidian's status bar while the ACTIVE note is a Handwriting page.
	 * OFF by default, so the status bar behaves exactly as Obsidian ships it.
	 *
	 * It exists because the bar is a fixed overlay in the bottom-right corner
	 * and on a Handwriting page it sits over the lower edge of the writing
	 * surface and the horizontal scrollbar, which no native setting moves.
	 * That is a real complaint, but it is not everyone's: the bar also carries
	 * word count, backlink and property counts and other plugins' items, and
	 * this shipped hiding it with no way to say no - the status bar vanished on
	 * every inked note, came back only by disabling the plugin, and survived a
	 * restart because the class is re-stamped at layout (Alan, 1.4.19). Hence
	 * opt-in: default behaviour is the expected one, the option is there for
	 * whoever wants the surface clear.
	 */
	hideStatusBarOnInkedNotes: boolean;
	/** Pen tools strip (v0.13.16): auto (pen summons it), show, or hide. */
	penTools: PenToolsMode;
	/** Note zoom bar: mirrors penTools exactly - auto steps aside while the
	 * pen inks, show is permanently on, hide is off. */
	noteZoomControls: NoteZoomControlsMode;
	/** What the "Toolbar on / off" command hid, put back by its next run; null when nothing is hidden by it. Only
	 * `penTools` is read back: the command stopped moving the zoom bar in 1.4.20, and the pair shape stays for data.json. */
	barsRestore: BarsPair | null;
	/** What the eraser erases, globally (1.0.9): whole strokes by default. */
	eraserMode: "stroke" | "reticle";
	/** The reticle that follows the pen tip (1.0.5). On by default. */
	penReticle: boolean;
	/** Hold-at-end snaps the figure to a clean shape (1.0.14). Default on. */
	shapeSnap: boolean;
	/** Shows the developer diagnostics commands in the palette. */
	devDiagnostics: boolean;
	/**
	 * Pen ink on the core Slides presentation (src/slides/SlidesInkSurface.ts).
	 *
	 * On by default: a reader who presents a note and draws on it expects the
	 * ink to be there next time, and the whole cost to a reader who never
	 * presents is one MutationObserver on `body` - which is not even installed
	 * while this is off.
	 */
	slidesInk: boolean;
	/** One command per colour and per nib size, for hotkeys. */
	colorSizeCommands: boolean;
	/**
	 * Quick pens (1.4.12 §4): the starred colour+size pairs, flat across both
	 * tools with each tool's own slot order preserved. Empty until somebody
	 * stars one - the feature costs a fresh install nothing but one small row
	 * inside a pop it already had.
	 */
	penPresets: InkPreset[];
	/**
	 * The version whose notes this vault has already been shown. Null until
	 * a release with notes has been seen. A brand new install is told apart
	 * by whether a settings file existed at all rather than trusting this.
	 */
	lastSeenVersion: string | null;
}

export const DEFAULT_SETTINGS: HandwritingSettings = {
	cameras: {},
	savedViews: [],
	inkSizes: { pen: 1, highlighter: 1 },
	pressureSensitivity: true,
	pressureChoice: true,
	inkSmoothing: true,
	/*
	 * OFF BY DEFAULT, on the owner's ruling: "leave it off default, because
	 * expected behaviour should be default and then the option if they need
	 * it". Black ink drawn black is what a reader expects; drawing it light
	 * on a dark theme is the surprising thing, however useful it is for an
	 * imported page that would otherwise read as blank.
	 *
	 * This arrived ON by default with the slides port, which would have
	 * changed how every dark-theme user's existing ink looked the moment
	 * they updated, with nothing in the release notes to warn them. The
	 * LOAD COERCION below has to agree with this line or the default here
	 * is decorative - a vault with no stored value is decided there, not
	 * here, and that is every existing user.
	 */
	inkAdaptsToTheme: false,
	/**
	 * ON by default, on Alan's ruling ("export toggle should default on") -
	 * the opposite answer to the line above, for the reason recorded on the
	 * interface field.
	 *
	 * THE SAME TRAP APPLIES HERE AND IT POINTS THE OTHER WAY. Two places
	 * decide a default and only the LOAD COERCION decides for a vault that
	 * has never stored the key, which is every existing user. For default-ON
	 * the coercion must read `!== false` (absence counts as on); `=== true`
	 * would leave this line decorative and ship the fix switched off for
	 * everyone who already has a vault - exactly how `inkAdaptsToTheme` went
	 * wrong once, with the signs reversed.
	 */
	inkReadableInExports: true,
	/**
	 * ON, on Alan's ruling of 2026-09-08 ("ink readable on white pages" then
	 * "with a toggle in the setings"): the common page is white, so the
	 * guarantee holds by default and the toggle is there for the pages where
	 * assuming white costs more than it pays. Its load coercion is `!== false`
	 * for the reason spelled out beside `inkReadableInExports`.
	 */
	inkPdfColorMode: "darken",
	inkColors: { pen: PEN_COLORS[0]!.hex, highlighter: HIGHLIGHTER_COLORS[0]!.hex },
	pageOwners: {},
	eraserRadiusPx: DEFAULT_ERASER_RADIUS_PX,
	mouseInk: false,
	// On by default since 1.4.5. It was off for e-ink's sake (see
	// StrokePrediction.ts); e-ink has Boox mode now, so the default serves
	// everyone else.
	strokePrediction: true,
	booxMode: false,
	einkHintOffered: false,
	scribbleHintOffered: false,
	paperStyle: "none",
	extendCanvasWhileScrolling: false,
	/*
	 * OFF, on Alan's ruling: status bar visible by default, with the toggle
	 * for people who want the old hide-on-inked-note behaviour. Default-OFF,
	 * so its load coercion below must read `=== true` - absence counts as off.
	 * `!== false` there would leave this line decorative and ship the hiding
	 * switched ON for every existing vault, which is the defect being fixed.
	 */
	hideStatusBarOnInkedNotes: false,
	penTools: "auto",
	noteZoomControls: "auto",
	barsRestore: null,
	eraserMode: "stroke",
	penReticle: true,
	shapeSnap: true,
	devDiagnostics: false,
	slidesInk: true,
	colorSizeCommands: false,
	penPresets: [],
	lastSeenVersion: null,
	toolbarCorner: DEFAULT_TOOLBAR_CORNER,
	// A COPY, not the exported array itself: this object is handed out as the
	// starting point for a vault's settings and is written through, and a
	// shared reference would let one vault's reorder rewrite the default every
	// other read of it sees.
	stripFoldOrder: [...DEFAULT_FOLD_ORDER],
	inkFolder: DEFAULT_INK_FOLDER,
};

/** A map-like setting value: an object that is not an array and not null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored pressure choice: `pressureChoice` when it is a boolean, else `pressureSensitivity`, else the
 * retired `inkShaping` key (a missing value is on). See `HandwritingSettings.pressureChoice`.
 */
export function pressureChoiceFrom(
	raw: (Partial<HandwritingSettings> & { inkShaping?: boolean }) | null | undefined
): boolean {
	if (typeof raw?.pressureChoice === "boolean") return raw.pressureChoice;
	return raw?.pressureSensitivity ?? raw?.inkShaping !== false;
}
