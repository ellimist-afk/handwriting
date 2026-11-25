/**
 * A Live Preview table widget's DOM for the attach rigs, built from the table's markdown as Obsidian 1.15.1 draws it
 * (recorded in the app 2026-11-17, AttachTableArm.fixture.json): div.cm-embed-block.cm-table-widget.markdown-rendered >
 * div.table-wrapper > table.table-editor > thead/tbody > tr > th/td > div.table-cell-wrapper, each word in a text node
 * under the wrapper (bold in strong, links in a.internal-link / a.external-link). The cell under edit keeps its resting
 * wrapper with display none and adds a second wrapper holding a nested div.cm-editor with the cell's source text.
 *
 * Geometry is the recorded one, in px relative to the widget's top-left: the table inset 16 px, rows 37.975 px, the
 * letters 22.77 px high and 7.33 px (header) or 7.64 px (body) under the row's top, the first column's text at its cell's
 * left and the others 10.3 px in; recorded word widths for the recorded words, 11.3 px a character otherwise, a space 6.1.
 * Options: a cell's wrap width (wrapped lines 29.57 px apart, recorded), the cells' vertical alignment, and the table's
 * sideways scroll. The Rogue record (attach-in-table/rogue-arm/run-20261117T081911Z-run, its T2/T3/T9 lines): a one-line
 * cell beside a wrapped one sits at its row's top (gaps 7.6 / 66.88), so "top" is the default and "middle" stays for a
 * theme that centres; a wide table scrolls in div.cm-table-widget itself, not div.table-wrapper (no read here takes
 * scrollLeft: only the rects move, as scrollLeft lays them); a short body row is drawn to the header's count of cells.
 *
 * The fake DOM has the standard members a place read uses: nodeType, parentNode, childNodes, children, textContent,
 * tagName, className, classList, style, matches, closest, querySelector(All) for tag, .class and tag.class tokens (comma
 * lists and descendant chains), getBoundingClientRect, getClientRects, ownerDocument.createRange with setStart, setEnd,
 * selectNodeContents, getClientRects and getBoundingClientRect, and defaultView.getComputedStyle (display only).
 * A display-none subtree has no rects.
 */

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number }
const box = (l: number, t: number, r: number, b: number): Box => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t });
const ZERO = box(0, 0, 0, 0);
const rectList = (rs: Box[]) => Object.assign([...rs], { item: (i: number) => rs[i] ?? null });

export class FNode {
	parentNode: FEl | null = null;
	readonly childNodes: FNode[] = [];
	constructor(readonly nodeType: number, readonly ownerDocument: FDoc) {}
	get parentElement(): FEl | null { return this.parentNode; }
	get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
	get firstChild(): FNode | null { return this.childNodes[0] ?? null; }
	get lastChild(): FNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
	get nextSibling(): FNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
	get previousSibling(): FNode | null { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] ?? null : null; }
	get isConnected(): boolean { return true; }
	/** Hidden by a display-none ancestor or itself. */
	hidden(): boolean {
		if (this instanceof FEl && this.style.display === "none") return true;
		for (let n = this.parentNode; n; n = n.parentNode) if (n.style.display === "none") return true;
		return false;
	}
	contains(n: FNode | null): boolean {
		for (let m = n; m; m = m.parentNode) if (m === this) return true;
		return false;
	}
}

export class FText extends FNode {
	/** Each character's box, screen px; set by the layout. */
	chars: Box[] = [];
	constructor(public data: string, doc: FDoc) { super(3, doc); }
	get nodeValue(): string { return this.data; }
	get length(): number { return this.data.length; }
	override get textContent(): string { return this.data; }
	/** Boxes of characters [a, b), one per visual row; a collapsed range: a zero-width box at a's left (or b-1's right). */
	rects(a: number, b: number): Box[] {
		if (this.hidden() || !this.chars.length) return [];
		if (a >= b) {
			const c = this.chars[a] ?? this.chars[this.chars.length - 1]!, x = this.chars[a] ? c.left : c.right;
			return [box(x, c.top, x, c.bottom)];
		}
		const out: Box[] = [];
		for (let i = a; i < b && i < this.chars.length; i++) {
			const c = this.chars[i]!, last = out[out.length - 1];
			if (last && Math.abs(last.top - c.top) < 1) out[out.length - 1] = box(last.left, last.top, c.right, last.bottom);
			else out.push(c);
		}
		return out;
	}
}

type Sel = { tag?: string; cls: string[] }[];
const parseSel = (s: string): Sel[] => s.split(",").map((part) => part.trim().split(/\s+/).map((tok) => {
	const [tag, ...cls] = tok.split(".");
	return { tag: tag ? tag.toUpperCase() : undefined, cls };
}));

export class FEl extends FNode {
	readonly tagName: string;
	className: string;
	readonly style: { display?: string } = {};
	readonly attrs: Record<string, string> = {};
	/** Its own box, screen px; set by the layout. */
	rect: Box = ZERO;
	constructor(tag: string, cls: string, doc: FDoc) {
		super(1, doc);
		this.tagName = tag.toUpperCase();
		this.className = cls;
	}
	get children(): FEl[] { return this.childNodes.filter((c): c is FEl => c instanceof FEl); }
	get classList() {
		const list = () => this.className.split(/\s+/).filter(Boolean);
		return { contains: (c: string) => list().includes(c), add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(" "); } };
	}
	get nodeName(): string { return this.tagName; }
	getAttribute(k: string): string | null { return k === "class" ? this.className : this.attrs[k] ?? null; }
	append(...kids: FNode[]): this {
		for (const k of kids) { k.parentNode = this; this.childNodes.push(k); }
		return this;
	}
	private one(s: { tag?: string; cls: string[] }): boolean {
		return (!s.tag || s.tag === this.tagName) && s.cls.every((c) => this.classList.contains(c));
	}
	matches(sel: string): boolean {
		return parseSel(sel).some((chain) => {
			if (!this.one(chain[chain.length - 1]!)) return false;
			let i = chain.length - 2;
			for (let p = this.parentNode; p && i >= 0; p = p.parentNode) if (p.one(chain[i]!)) i--;
			return i < 0;
		});
	}
	closest(sel: string): FEl | null {
		if (this.matches(sel)) return this;
		for (let n = this.parentNode; n; n = n.parentNode) if (n.matches(sel)) return n;
		return null;
	}
	querySelectorAll(sel: string): FEl[] {
		this.ownerDocument.counted("walk");
		const out: FEl[] = [];
		const walk = (e: FEl) => { for (const k of e.children) { if (k.matches(sel)) out.push(k); walk(k); } };
		walk(this);
		return out;
	}
	querySelector(sel: string): FEl | null { return this.querySelectorAll(sel)[0] ?? null; }
	getBoundingClientRect(): Box { this.ownerDocument.counted("rect"); return this.hidden() ? ZERO : this.rect; }
	getClientRects() { this.ownerDocument.counted("rect"); return rectList(this.hidden() ? [] : [this.rect]); }
}

export class FRange {
	startContainer: FNode | null = null; startOffset = 0; endContainer: FNode | null = null; endOffset = 0;
	/** The document that made it (createRange): its reads are counted there. A range a test builds itself is not counted. */
	constructor(readonly doc: FDoc | null = null) {}
	setStart(n: FNode, o: number): void { this.startContainer = n; this.startOffset = o; }
	setEnd(n: FNode, o: number): void { this.endContainer = n; this.endOffset = o; }
	selectNodeContents(n: FNode): void { this.setStart(n, 0); this.setEnd(n, n instanceof FText ? n.length : n.childNodes.length); }
	get collapsed(): boolean { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
	/** Text inside the range, as (node, from, to) runs in document order. */
	private runs(): [FText, number, number][] {
		const s = this.startContainer, e = this.endContainer;
		if (!s || !e) return [];
		if (s === e && s instanceof FText) return [[s, this.startOffset, this.endOffset]];
		const texts: FText[] = [];
		let root: FNode = s;
		while (root.parentNode && !root.contains(e)) root = root.parentNode;
		const walk = (n: FNode) => { if (n instanceof FText) texts.push(n); n.childNodes.forEach(walk); };
		walk(root);
		const startAt = (n: FNode, o: number) => (n instanceof FText ? { t: n, o } : null);
		const a = startAt(s, this.startOffset), b = startAt(e, this.endOffset);
		const out: [FText, number, number][] = [];
		let on = !a;
		for (const t of texts) {
			if (a && t === a.t) on = true;
			if (!on) continue;
			const from = a && t === a.t ? a.o : 0, to = b && t === b.t ? b.o : t.length;
			out.push([t, from, to]);
			if (b && t === b.t) break;
		}
		return out;
	}
	getClientRects() {
		this.doc?.counted("rect");
		const runs = this.runs();
		if (this.collapsed && runs.length) { const [t, a] = runs[0]!; return rectList(t.rects(a, a)); }
		return rectList(runs.flatMap(([t, a, b]) => t.rects(a, b)));
	}
	getBoundingClientRect(): Box {
		const doc = this.doc;
		(this as { doc: FDoc | null }).doc = null;
		doc?.counted("rect");
		let rs = rectList([]);
		try { rs = this.getClientRects(); } finally { (this as { doc: FDoc | null }).doc = doc; }
		if (!rs.length) return ZERO;
		return box(Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom)));
	}
}

export class FDoc {
	readonly defaultView = {
		getComputedStyle: (e: FEl) => ({ display: e.style.display ?? "block", getPropertyValue: (k: string) => (k === "display" ? e.style.display ?? "block" : "") }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
	};
	readonly visibilityState = "visible";
	/**
	 * Layout reads made through this document's nodes and ranges (rect: a getBoundingClientRect or getClientRects; walk: a
	 * querySelectorAll), and those made while `reading` says no measure's read phase is running (outside).
	 */
	readonly reads = { rect: 0, walk: 0, outside: [] as string[] };
	/** Whether a measure's read phase is running now; the rig sets it. Unset: every read counts as inside. */
	reading: (() => boolean) | null = null;
	counted(kind: "rect" | "walk"): void {
		this.reads[kind]++;
		if (this.reading && !this.reading()) this.reads.outside.push(kind);
	}
	createRange(): FRange { return new FRange(this); }
	createElement(tag: string): FEl { return new FEl(tag, "", this); }
	createTextNode(t: string): FText { return new FText(t, this); }
}

/** The recorded widths, px: words as drawn in the recording (Bahnschrift 26px). */
const WORD_W: Record<string, number> = {
	Name: 59.72, Note: 47.95, Link: 43.49, kilo: 36.73, beta: 44.11, gamma: 75.45, plain: 49.38, delta: 50.58, bold: 43.63,
	word: 51.54, other: 54.43, and: 37.09, site: 37.13, echo: 48.64, foxtrot: 67.43, hotel: 51.31, golf: 38.46,
};
export const TABLE_GEOM = { inset: 16, rowH: 37.975, letterH: 22.77, textTopHead: 7.33, textTopBody: 7.64, padIn: 10.3, firstPadR: 15.6, lastPadR: 20.4, space: 6.1, char: 11.3, wrapPitch: 29.57 };

/** Each character's width in `token` (no spaces): a recorded word split evenly; a recorded word with a prefix: the prefix at the plain width. */
function charWidths(token: string): number[] {
	const known = WORD_W[token];
	if (known !== undefined) return [...token].map(() => known / token.length);
	for (let i = 1; i < token.length; i++) {
		const tail = token.slice(i), w = WORD_W[tail];
		if (w !== undefined) return [...token.slice(0, i)].map(() => TABLE_GEOM.char).concat([...tail].map(() => w / tail.length));
	}
	return [...token].map(() => TABLE_GEOM.char);
}

/** A rendered piece of a cell: text in a node path (outermost first), or a line break. */
type Piece = { text: string; path: string[] } | { br: true };

/** One cell's markdown to rendered pieces: **bold**, [[link]], [[link\|alias]], [text](url), ![[embed\|size]], \|, <br>. */
export function renderCell(md: string): Piece[] {
	const out: Piece[] = [];
	// Also (trap shapes): an HTML tag other than <br> draws nothing of itself; a backslash escape draws its character; an
	// entity (&amp; &lt; &gt; &quot; &nbsp;) draws its one character; inline math ($x$) draws no text node (MathJax's
	// glyphs come from CSS, no width modelled here, so a math cell's places are not the app's).
	const re = /\*\*(.+?)\*\*|!\[\[([^\]]*?)\]\]|\[\[([^\]]*?)\]\]|\[([^\]]*?)\]\(([^)]*?)\)|<br\s*\/?>|\\\||\\([!-/:-@[-`{-~])|&(amp|lt|gt|quot|nbsp);|\$([^$\n]+)\$|<\/?[A-Za-z][^<>]*>/g;
	const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", nbsp: " " };
	let at = 0;
	const plain = (t: string) => { if (t) out.push({ text: t, path: [] }); };
	for (let m: RegExpExecArray | null; (m = re.exec(md)); ) {
		plain(md.slice(at, m.index));
		at = m.index + m[0].length;
		if (m[1] !== undefined) out.push({ text: m[1], path: ["strong"] });
		else if (m[2] !== undefined) out.push({ text: m[2].split("\\|")[0]!, path: ["span.internal-embed"] });
		else if (m[3] !== undefined) { const [link, alias] = m[3].split("\\|"); out.push({ text: alias ?? link!, path: ["a.internal-link"] }); }
		else if (m[4] !== undefined) out.push({ text: m[4], path: ["a.external-link"] });
		else if (m[0] === "\\|") plain("|");
		else if (m[6] !== undefined) plain(m[6]);
		else if (m[7] !== undefined) plain(ENT[m[7]]!);
		else if (m[8] !== undefined) continue;
		else if (/^<br/i.test(m[0])) out.push({ br: true });
	}
	plain(md.slice(at));
	// Merge adjacent plain pieces (an escaped pipe splits none).
	const merged: Piece[] = [];
	for (const p of out) {
		const last = merged[merged.length - 1];
		if (last && "text" in last && "text" in p && !last.path.length && !p.path.length) last.text += p.text;
		else merged.push(p);
	}
	return merged;
}

/** A row's source split into its cells' markdown: unescaped pipes; outer pipes optional (GFM). */
export function splitRow(src: string): string[] {
	let s = src.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
		if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
		cur += s[i];
	}
	cells.push(cur);
	return cells.map((c) => c.trim());
}
export const SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export interface TableOpts {
	/** The widget's width, px (the recorded 1212.34). */
	width?: number;
	/** A column's text wraps at this width, px. */
	wrapAt?: Record<number, number>;
	/** The cells' vertical alignment (recorded: top, the default; middle for a theme that centres). */
	valign?: "top" | "middle";
	/** The table's sideways scroll, px (the app scrolls div.cm-table-widget; here only the rects it lays move). */
	scrollLeft?: number;
	/** The cell under edit: [shown row (0 the header), column]. */
	underEdit?: [number, number];
	/**
	 * The editor's resting zoom: every rect of the DOM is this many times its layout px (screen px at that zoom, about the
	 * screen's origin). x0, y0 and the returned width and height stay layout px.
	 */
	scale?: number;
	/**
	 * A cell padding other than Live Preview's (a read-only view's own theme), px: `left` the padding inside every column
	 * after the first, `top` added above every cell's text. Unset: Live Preview's.
	 */
	pad?: { left?: number; top?: number };
}

/** Every rect and character box under `n`, times `k` about the origin. */
function scaleTree(n: FNode, k: number): void {
	const s = (b: Box) => box(b.left * k, b.top * k, b.right * k, b.bottom * k);
	if (n instanceof FEl) n.rect = s(n.rect);
	if (n instanceof FText) n.chars = n.chars.map(s);
	n.childNodes.forEach((c) => scaleTree(c, k));
}

/** The widget for `lines` (the table's source lines), at screen (x0, y0): its element and its height. */
export function tableWidget(doc: FDoc, lines: readonly string[], x0: number, y0: number, opts: TableOpts = {}): { el: FEl; table: FEl; wrapper: FEl; height: number; width: number; rows: number; cell: (row: number, col: number) => FEl | null } {
	const G = TABLE_GEOM, width = opts.width ?? 1212.34;
	const shown = lines.filter((l) => !SEPARATOR_ROW.test(l));
	const header = shown[0] ? splitRow(shown[0]) : [], ncol = header.length;
	// GFM: a body row's extra cells are not drawn; missing ones are drawn empty.
	const rows = shown.map((l) => { const c = splitRow(l).slice(0, ncol); while (c.length < ncol) c.push(""); return c.map(renderCell); });
	// Lay out each cell's pieces into lines of tokens at a column's wrap width.
	type Tok = { piece: number; from: number; to: number; w: number[]; x: number; line: number };
	const layCell = (pieces: Piece[], wrap: number) => {
		const toks: Tok[] = [];
		let x = 0, line = 0;
		pieces.forEach((p, pi) => {
			if (!("text" in p)) { line++; x = 0; return; }
			for (const m of p.text.matchAll(/\S+|\s+/g)) {
				const t = m[0], from = m.index, isSpace = /^\s/.test(t);
				const w = isSpace ? [...t].map(() => G.space) : charWidths(t), tw = w.reduce((a, b) => a + b, 0);
				if (!isSpace && x > 0 && x + tw > wrap) { line++; x = 0; }
				if (isSpace && x === 0 && line > 0) { toks.push({ piece: pi, from, to: from + t.length, w: w.map(() => 0), x, line }); continue; }
				toks.push({ piece: pi, from, to: from + t.length, w, x, line });
				x += tw;
			}
		});
		const lineW = (n: number) => toks.filter((t) => t.line === n).reduce((a, t) => Math.max(a, t.x + t.w.reduce((s, v) => s + v, 0)), 0);
		const nl = toks.length ? Math.max(...toks.map((t) => t.line)) + 1 : 1;
		let wmax = 0;
		for (let n = 0; n < nl; n++) wmax = Math.max(wmax, lineW(n));
		return { toks, lines: nl, w: wmax };
	};
	const laid = rows.map((r) => r.map((pieces, c) => layCell(pieces, opts.wrapAt?.[c] ?? Infinity)));
	const padL = (c: number) => (c === 0 ? 0 : opts.pad?.left ?? G.padIn), padR = (c: number) => (c === 0 ? G.firstPadR : c === ncol - 1 ? G.lastPadR : G.padIn);
	const colW = header.map((_, c) => padL(c) + Math.max(...laid.map((r) => r[c]!.w)) + padR(c));
	const rowH = laid.map((r) => G.rowH + (Math.max(...r.map((c) => c.lines)) - 1) * G.wrapPitch);
	const height = G.inset * 2 + rowH.reduce((a, b) => a + b, 0);
	const el = new FEl("div", "cm-embed-block cm-table-widget markdown-rendered", doc);
	el.attrs.contenteditable = "false";
	el.rect = box(x0, y0, x0 + width, y0 + height);
	const wrapper = new FEl("div", "table-wrapper", doc), table = new FEl("table", "table-editor", doc);
	const thead = new FEl("thead", "", doc), tbody = new FEl("tbody", "", doc);
	el.append(wrapper.append(table.append(thead, tbody)));
	wrapper.rect = box(x0 + G.inset, y0 + G.inset, x0 + width - G.inset, y0 + height - G.inset);
	const sx = opts.scrollLeft ?? 0, cells: FEl[][] = [];
	let top = y0 + G.inset;
	laid.forEach((r, ri) => {
		const tr = new FEl("tr", "", doc);
		(ri === 0 ? thead : tbody).append(tr);
		let left = x0 + G.inset - sx;
		const rowCells: FEl[] = [];
		r.forEach((c, ci) => {
			const td = new FEl(ri === 0 ? "th" : "td", "", doc);
			td.attrs.dir = "ltr";
			td.rect = box(left, top, left + colW[ci]!, top + rowH[ri]!);
			const wrap = new FEl("div", "table-cell-wrapper", doc);
			wrap.rect = box(left + padL(ci), top, left + colW[ci]! - padR(ci), top + rowH[ri]!);
			const textTop = (ri === 0 ? G.textTopHead : G.textTopBody) + (opts.pad?.top ?? 0) + ((opts.valign ?? "top") === "top" ? 0 : (rowH[ri]! - G.rowH - (c.lines - 1) * G.wrapPitch) / 2);
			const nodes: FText[] = [];
			rows[ri]![ci]!.forEach((p, pi) => {
				if (!("text" in p)) { wrap.append(new FEl("br", "", doc)); return; }
				const t = new FText(p.text, doc);
				t.chars = [...p.text].map(() => ZERO);
				for (const tok of c.toks.filter((k) => k.piece === pi)) {
					let x = left + padL(ci) + tok.x;
					const y = top + textTop + tok.line * G.wrapPitch;
					for (let i = tok.from; i < tok.to; i++) { const w = tok.w[i - tok.from]!; t.chars[i] = box(x, y, x + w, y + G.letterH); x += w; }
				}
				nodes.push(t);
				let host: FEl = wrap;
				for (const seg of p.path) {
					const [tag, ...cls] = seg.split(".");
					const e = new FEl(tag!, cls.join(" "), doc);
					host.append(e);
					host = e;
				}
				host.append(t);
				if (host !== wrap) {
					const r = new FRange();
					r.selectNodeContents(t);
					for (let h: FEl | null = host; h && h !== wrap; h = h.parentNode) h.rect = r.getBoundingClientRect();
				}
			});
			const colHandle = new FEl("div", "table-col-drag-handle", doc), rowHandle = new FEl("div", "table-row-drag-handle", doc);
			td.append(wrap, colHandle, rowHandle);
			if (opts.underEdit && opts.underEdit[0] === ri && opts.underEdit[1] === ci) {
				// The cell under edit: the resting wrapper hidden, a second one with a nested editor showing the cell's source.
				Object.assign(wrap.style, { display: "none" });
				const live = new FEl("div", "table-cell-wrapper", doc), ed = new FEl("div", "cm-editor", doc), scroller = new FEl("div", "cm-scroller", doc);
				const content = new FEl("div", "cm-content cm-lineWrapping", doc), line = new FEl("div", "cm-line", doc);
				const src = splitRow(shown[ri]!)[ci] ?? "", tn = new FText(src, doc);
				// The source's characters on one line, plain words at their drawn widths (the recorded nested editor's words sit
				// where the resting cell's did).
				const y = top + textTop;
				let x = left + padL(ci);
				for (const m of src.matchAll(/\S+|\s+/g)) {
					const ws = /^\s/.test(m[0]) ? [...m[0]].map(() => G.space) : charWidths(m[0]);
					for (let i = 0; i < ws.length; i++) { tn.chars[m.index + i] = box(x, y, x + ws[i]!, y + G.letterH); x += ws[i]!; }
				}
				line.rect = box(left + padL(ci), y - 3.33, left + colW[ci]! - padR(ci), y - 3.33 + G.wrapPitch);
				ed.rect = scroller.rect = content.rect = line.rect;
				live.rect = wrap.rect;
				td.childNodes.splice(1, 0, live);
				live.parentNode = td;
				live.append(ed.append(scroller.append(content.append(line.append(tn)))));
				td.classList.add("is-editing");
			}
			tr.append(td);
			tr.rect = box(x0 + G.inset - sx, top, left + colW[ci]!, top + rowH[ri]!);
			rowCells.push(td);
			left += colW[ci]!;
		});
		cells.push(rowCells);
		top += rowH[ri]!;
	});
	const tw = colW.reduce((a, b) => a + b, 0);
	table.rect = box(x0 + G.inset - sx, y0 + G.inset, x0 + G.inset - sx + tw, top);
	thead.rect = cells[0]?.[0] ? box(table.rect.left, cells[0][0].rect.top, table.rect.right, cells[0][0].rect.bottom) : ZERO;
	tbody.rect = box(table.rect.left, thead.rect.bottom, table.rect.right, top);
	if (opts.scale !== undefined && opts.scale !== 1) scaleTree(el, opts.scale);
	return { el, table, wrapper, height, width, rows: laid.length, cell: (r, c) => cells[r]?.[c] ?? null };
}
