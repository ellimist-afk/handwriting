/**
 * Insert space: the divider gesture's pure core.
 *
 * The gesture is overlay state (a world y, a frozen id list, an accumulated
 * dy) driving the SAME machinery the lasso drag uses: `moveStrokes` live,
 * one `move` op at release. What is genuinely new is the membership rule -
 * which strokes a divider takes with it - and that rule wants to be pure
 * and tested, because it is the part a user disagrees with when the gesture
 * "split the letters".
 *
 * Two rules were tried and both were wrong, for the same reason:
 *
 *   1. bbox TOP - tore a row apart, because a written row is not a band of
 *      uniform height and a divider in the gap between rows still sits
 *      below the tops of the taller letters in the lower row.
 *   2. the ink's centroid - better, and still wrong, because a letter is
 *      not always ONE stroke. The dot of an `i`, the cross of a `t`, the
 *      bar of an `A`: each is its own stroke with its own centroid, and a
 *      line drawn between a dot and its stem separates them.
 *
 * Both failed because they judge strokes INDIVIDUALLY. Any horizontal line
 * through a page of handwriting passes through something. So membership is
 * decided a ROW at a time instead. The nearest row edge determines which
 * whole rows move; it no longer relocates the visible insertion guide.
 * The overlay previews crossing groups explicitly so the line cannot imply
 * that a letter or a large transitive group will be cut apart.
 */

import type { BBox, InkStroke } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";

/** A row of writing: its vertical extent and the strokes that make it up. */
export interface InkRow {
	top: number;
	bottom: number;
	ids: string[];
}

/** Hover must not rescan every point in the note. Moves mutate strokes in
 * place, so both object identity and the renderer's revision are significant. */
export class InsertSpaceRows {
	private entries: {stroke: InkStroke; rev: number}[] = [];
	private rows: InkRow[] = [];
	get(strokes: readonly InkStroke[]): readonly InkRow[] {
		if (strokes.length !== this.entries.length || strokes.some((s,i)=>
			this.entries[i]!.stroke !== s || this.entries[i]!.rev !== strokeRev(s))) {
			this.entries = strokes.map(stroke=>({stroke,rev:strokeRev(stroke)}));
			this.rows = localRowsOf(strokes);
		}
		return this.rows;
	}
}

export interface SpaceBoundary { y: number; from: number; lineHeight: number; text?: boolean; blockFallback?: boolean }

export interface SpaceProtectedBlock { from: number; to: number; frontmatter?: boolean }

/** Block context for paragraph eligibility, cached per immutable CM document.
 * Setext underlines belong to the preceding nonblank paragraph; fence bodies
 * and leading YAML are not paragraphs even when their individual lines look
 * like ordinary words. Returned line numbers are one-based and inclusive. */
export function spaceProtectedBlocks(textAt:(line:number)=>string,count:number):SpaceProtectedBlock[] {
	const blocks:SpaceProtectedBlock[]=[];
	let paragraph=0,open:{from:number;mark:string;length:number;frontmatter?:boolean}|null=null;
	for(let n=1;n<=count;n++){
		const text=textAt(n);
		if(open){
			const close=open.frontmatter?/^(?:---|\.\.\.)\s*$/.test(text):
				new RegExp(`^ {0,3}${open.mark}{${open.length},}\\s*$`).test(text);
			if(close){blocks.push({from:open.from,to:n,frontmatter:open.frontmatter});open=null;}
			continue;
		}
		if(n===1&&/^\uFEFF?---\s*$/.test(text)){open={from:n,mark:"",length:0,frontmatter:true};paragraph=0;continue;}
		const fence=/^ {0,3}(`{3,}|~{3,})/.exec(text);
		if(fence){open={from:n,mark:fence[1]![0]!,length:fence[1]!.length};paragraph=0;continue;}
		if(!text.trim()){paragraph=0;continue;}
		if(paragraph&&/^ {0,3}(?:=+|-+)\s*$/.test(text)){
			blocks.push({from:paragraph,to:n});paragraph=0;continue;
		}
		if(!paragraph)paragraph=n;
	}
	if(open)blocks.push({from:open.from,to:count,frontmatter:open.frontmatter});
	return blocks;
}

/** Internal paragraph breaks are safe between ordinary words. Keep structured
 * Markdown lines whole rather than breaking a link, code span, emphasis,
 * heading or list marker across the new paragraph. No characters are removed. */
export function canSplitParagraph(text: string, offset: number): boolean {
	if(offset<=0||offset>=text.length)return false;
	if(!/\s/.test(text[offset-1]!)&&!/\s/.test(text[offset]!))return false;
	if(/^(?: {4}|\t| {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|~{3}))/.test(text))return false;
	return !/[`*_\\[\]<>|$]/.test(text);
}

/** Nearest eligible text seam, independent of ink group extents. The caller
 * previews whole-group membership separately instead of moving the guide. */
export function nearestSpaceBoundary(
	y: number,
	at: (y: number, direction: -1 | 1) => SpaceBoundary | null
): SpaceBoundary | null {
	const candidates: SpaceBoundary[] = [];
	for (const direction of [-1,1] as const) {
		const boundary=at(y,direction);
		if (boundary && Number.isFinite(boundary.y)) candidates.push(boundary);
	}
	return candidates.sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y)||b.y-a.y)[0]??null;
}

function extentOf(stroke: InkStroke): { top: number; bottom: number; left:number; right:number } {
	const pts = stroke.points;
	if (pts.length === 0) return { top: stroke.bbox.y, bottom: stroke.bbox.y + stroke.bbox.height, left:stroke.bbox.x, right:stroke.bbox.x+stroke.bbox.width };
	let top = Infinity;
	let bottom = -Infinity;
	let left = Infinity, right = -Infinity;
	for (const p of pts) {
		if (p.y < top) top = p.y;
		if (p.y > bottom) bottom = p.y;
		if (p.x < left) left = p.x;
		if (p.x > right) right = p.x;
	}
	return { top, bottom, left, right };
}

/** Existing PDF grouping: retain its globally snapped guide contract. Ordinary
 * notes opt into local groups through InsertSpaceRows instead. */
export function rowsOf(strokes: readonly InkStroke[]): InkRow[] {
	const spans = new Map<string, { left: number; right: number }>();
	for (const s of strokes) spans.set(s.id, { left: s.bbox.x, right: s.bbox.x + s.bbox.width });
	const items = strokes
		.map((s) => ({ id: s.id, ...extentOf(s) }))
		.sort((a, b) => a.top - b.top);

	const rows: InkRow[] = [];
	for (const it of items) {
		const cur = rows[rows.length - 1];
		if (cur && it.top < cur.bottom) {
			cur.ids.push(it.id);
			if (it.bottom > cur.bottom) cur.bottom = it.bottom;
			continue;
		}
		rows.push({ top: it.top, bottom: it.bottom, ids: [it.id] });
	}

	// Second pass: attach floating marks to the row they belong to.
	//
	// A dot never touches its stem and a `t` bar often clears its own row's
	// tallest letter, so overlap alone leaves them stranded as rows of their
	// own - which is exactly how a letter came apart. Such a mark is small,
	// sits directly OVER one letter of the row beneath it, and is closer to
	// that row than a line of writing would be. Two genuine rows never match
	// all three: they are the same width as each other, not a fraction of it.
	for (let i = rows.length - 2; i >= 0; i--) {
		const mark = rows[i]!;
		const host = rows[i + 1]!;
		const gap = host.top - mark.bottom;
		if (gap < 0 || gap > host.bottom - host.top) continue;
		const m = xSpan(mark.ids, spans);
		const h = xSpan(host.ids, spans);
		if (m === null || h === null) continue;
		const narrow = m.right - m.left <= (h.right - h.left) * 0.34;
		const over = m.left >= h.left - 1 && m.right <= h.right + 1;
		if (!narrow || !over) continue;
		host.ids.push(...mark.ids);
		host.top = mark.top;
		rows.splice(i, 1);
	}
	return rows;
}

function xSpan(
	ids: readonly string[],
	spans: ReadonlyMap<string, { left: number; right: number }>
): { left: number; right: number } | null {
	let left = Infinity;
	let right = -Infinity;
	for (const id of ids) {
		const s = spans.get(id);
		if (!s) continue;
		if (s.left < left) left = s.left;
		if (s.right > right) right = s.right;
	}
	return left === Infinity ? null : { left, right };
}

/**
 * Local whole handwriting groups. Two strokes join when their vertical
 * spans overlap and their horizontal gap is at most THREE times the shorter
 * stroke's height. This permits loose letter spacing, while a tall drawing
 * cannot enlarge a small word's reach to consume a distant column. Compare
 * actual constituent spans, never a growing group's union box. Touching rows
 * remain separate. Ratios use note geometry, so zoom/translation/uniform
 * scaling do not change membership. Detached marks attach in a second pass.
 * Groups in different columns may overlap vertically; they are not bands.
 */
function localRowsOf(strokes: readonly InkStroke[]): InkRow[] {
	const items = strokes
		.map((s) => ({ id: s.id, ...extentOf(s) }))
		.sort((a, b) => a.top - b.top || a.left-b.left);
	const parents=items.map((_,i)=>i);
	const root=(i:number):number=>{
		while(parents[i]!==i){parents[i]=parents[parents[i]!]!;i=parents[i]!;}
		return i;
	};
	let active:number[]=[];
	for(let i=0;i<items.length;i++){
		const a=items[i]!;
		active=active.filter(j=>items[j]!.bottom>a.top);
		for(const j of active){
			const b=items[j]!;
			if(a.bottom<=b.top)continue;
			const gap=Math.max(0,a.left-b.right,b.left-a.right);
			if(gap<=3*Math.min(a.bottom-a.top,b.bottom-b.top))parents[root(i)]=root(j);
		}
		active.push(i);
	}
	const grouped=new Map<number,InkRow & {left:number;right:number}>();
	items.forEach((s,i)=>{
		const key=root(i),row=grouped.get(key);
		if(row){row.ids.push(s.id);row.top=Math.min(row.top,s.top);row.bottom=Math.max(row.bottom,s.bottom);row.left=Math.min(row.left,s.left);row.right=Math.max(row.right,s.right);}
		else grouped.set(key,{top:s.top,bottom:s.bottom,left:s.left,right:s.right,ids:[s.id]});
	});
	const rows=[...grouped.values()].sort((a,b)=>a.top-b.top||a.left-b.left)
		.map((row,ord)=>({...row,ord}));
	// A floating mark chooses the nearest eligible LOCAL host below it,
	// regardless of interleaved groups in another column. The height-relative
	// width/overhang allowance also handles a dot above a lone vertical stem.
	//
	// A host starts at or below the mark (gap >= 0) and no further below it
	// than its own height, so only rows whose top lies within the tallest
	// row's height under the mark can qualify. `byTop` keeps the live rows
	// ordered by top, so each mark checks that window instead of every row:
	// the all-rows filter per mark was quadratic, 30-80 ms on a note of one
	// to two thousand written lines, after every ink change. The choice is
	// the one the filter-and-sort made: nearest gap, then centre offset, then
	// left, then the earlier row (`ord`, the stable sort's tie).
	const byTop=[...rows];
	const firstFrom=(y:number)=>{
		let lo=0,hi=byTop.length;
		while(lo<hi){const mid=(lo+hi)>>1;if(byTop[mid]!.top<y)lo=mid+1;else hi=mid;}
		return lo;
	};
	let tallest=0;
	for(const row of rows)tallest=Math.max(tallest,row.bottom-row.top);
	for(const mark of [...rows].reverse()){
		let host:(typeof rows)[number]|null=null,hostAt=-1;
		for(let i=firstFrom(mark.bottom);i<byTop.length;i++){
			const cand=byTop[i]!;
			if(cand.top-mark.bottom>tallest)break;
			if(cand===mark)continue;
			const height=cand.bottom-cand.top,gap=cand.top-mark.bottom;
			if(!(height>0 && gap>=0 && gap<=height && mark.bottom-mark.top<=height*.34 &&
				mark.right-mark.left<=Math.max(cand.right-cand.left,height*.25)*.34 &&
				mark.left>=cand.left-height*.1 && mark.right<=cand.right+height*.1))continue;
			if(host){
				const order=(cand.top-mark.bottom)-(host.top-mark.bottom)||
					Math.abs(cand.left+cand.right-mark.left-mark.right)-Math.abs(host.left+host.right-mark.left-mark.right)||
					cand.left-host.left||cand.ord-host.ord;
				if(!(order<0))continue;
			}
			host=cand;hostAt=i;
		}
		if(!host)continue;
		host.ids.push(...mark.ids);host.top=mark.top;
		host.left=Math.min(host.left,mark.left);host.right=Math.max(host.right,mark.right);
		tallest=Math.max(tallest,host.bottom-host.top);
		// The host's top moved up to the mark's: take it out and put it back
		// in order, then drop the mark, which has no other place to be.
		byTop.splice(hostAt,1);
		byTop.splice(firstFrom(host.top),0,host);
		byTop.splice(byTop.indexOf(mark),1);
	}
	return byTop.sort((a,b)=>a.top-b.top||a.left-b.left||a.ord-b.ord).map(({top,bottom,ids})=>({top,bottom,ids}));
}

/**
 * Nearest group edge, for callers needing a snapped position. Local groups
 * may overlap, so consider all crossing edges. Insert Space membership must
 * NOT use this global position: it judges each group at the original guide.
 */
export function snapLine(rows: readonly InkRow[], lineY: number): number {
	return rows.filter(row=>lineY>row.top&&lineY<row.bottom).flatMap(row=>[row.top,row.bottom])
		.sort((a,b)=>Math.abs(a-lineY)-Math.abs(b-lineY)||b-a)[0]??lineY;
}

/**
 * Which strokes an insert-space divider at world y moves, in store order.
 *
 * Each group uses the ORIGINAL line. Groups wholly below move; crossing
 * groups move only in their upper half, with midpoint ties staying. One
 * column's crossing group must never move the cut used by another column.
 */
export function strokeIdsBelow(strokes: readonly InkStroke[], lineY: number, rows: readonly InkRow[] = rowsOf(strokes)): string[] {
	const moving = new Set<string>();
	for (const row of rows) {
		if (row.top >= lineY || lineY < (row.top+row.bottom)/2) for (const id of row.ids) moving.add(id);
	}
	// Store order, so z-order and the op's id list stay in the store's terms.
	return strokes.filter((s) => moving.has(s.id)).map((s) => s.id);
}

/** The union box of the named strokes, or null when none are named. */
export function boundsOf(strokes: readonly InkStroke[], ids: readonly string[]): BBox | null {
	const wanted = new Set(ids);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let found = false;
	for (const s of strokes) {
		if (!wanted.has(s.id)) continue;
		found = true;
		const b = s.bbox;
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	if (!found) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The region a vertical shift of `dy` dirties: where the ink was, plus
 * where it lands, as ONE rect.
 *
 * Marking the whole page dirty per frame re-rasterized every stroke in the
 * note and the drag went visibly jagged on a full page. The moved ink is a
 * contiguous band travelling straight down, so its swept region is exactly
 * one rectangle - the shape the damage ledger is cheapest at, and the one
 * the lasso drag has always used.
 */
export function sweptRect(bounds: BBox, dy: number): BBox {
	return {
		x: bounds.x,
		y: dy < 0 ? bounds.y + dy : bounds.y,
		width: bounds.width,
		height: bounds.height + Math.abs(dy),
	};
}

/**
 * How many text lines a vertical shift is worth.
 *
 * Ink is world-anchored and text is not, so the two only stay aligned if
 * the ink lands on a whole number of line heights: the drag runs smooth,
 * and the release quantizes to the nearest line. Half a line of slack at
 * the end is invisible next to text and ink disagreeing forever.
 */
export function lineSteps(dyNote: number, lineHeightNote: number): number {
	if (!(lineHeightNote > 0)) return 0;
	return Math.round(dyNote / lineHeightNote);
}

/**
 * How many blank lines directly above `lineNumber` (1-based) may be taken
 * back, capped at `want`.
 *
 * Closing a gap must never eat writing. Dragging up removes only the empty
 * lines a previous insert-space put there; the moment a line has anything
 * on it the removal stops, and the ink simply moves further than the text
 * does - wrong by a line, where deleting a sentence would be unforgivable.
 */
export function blankLinesAbove(
	textAt: (lineNumber: number) => string,
	lineNumber: number,
	want: number
): number {
	// A reader rather than an array: the caller has a document, and
	// materializing every line of it to look at the handful directly above
	// the divider is work proportional to the whole note for an answer
	// bounded by `want`.
	let n = 0;
	let i = lineNumber - 1; // 1-based number of the line above
	while (n < want && i >= 1 && textAt(i).trim() === "") {
		n++;
		i--;
	}
	return n;
}
