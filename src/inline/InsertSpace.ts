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
import { inkRevision, strokeRev } from "../ink/StrokeRev";

/** A row of writing: its vertical extent and the strokes that make it up. */
export interface InkRow {
	top: number;
	bottom: number;
	ids: string[];
}

/** Hover must not rescan every point in the note. Moves mutate strokes in
 * place, so both object identity and the renderer's revision are significant.
 * Hover must not read every stroke either: an ask with the list, length and
 * ink revision of the last confirmed one is a hit without looking further. */
export class InsertSpaceRows {
	private entries: {stroke: InkStroke; rev: number}[] = [];
	/** The list and ink revision `entries` were last confirmed against. */
	private seen: {list: readonly InkStroke[]; ink: number} | null = null;
	private rows: InkRow[] = [];
	/** Each row's horizontal extent, index for index with `rows`. */
	private spans: {left: number; right: number}[] = [];
	/** The first-pass groups the rows were made from (localRowsOf). */
	private groups: Group[] = [];
	/** Each stroke's extent, index for index with `entries`. */
	private extents: Extent[] = [];
	/** A shift waiting for its task (queueShift). */
	private queued: {rows: readonly InkRow[]; ids: readonly string[]; steps: readonly number[]} | null = null;
	get(strokes: readonly InkStroke[]): readonly InkRow[] {
		// An ask that comes before the queued shift's task runs the shift itself, once.
		if (this.queued) this.runQueued(strokes);
		const ink = inkRevision(), seen = this.seen;
		if (seen && seen.list === strokes && seen.ink === ink && strokes.length === this.entries.length) return this.rows;
		this.seen = {list: strokes, ink};
		if (strokes.length !== this.entries.length || strokes.some((s,i)=>
			this.entries[i]!.stroke !== s || this.entries[i]!.rev !== strokeRev(s))) {
			this.entries = strokes.map(stroke=>({stroke,rev:strokeRev(stroke)}));
			({extents:this.extents,groups:this.groups,rows:this.rows,spans:this.spans} = localRowsOf(strokes));
		}
		return this.rows;
	}

	/** Hold a shift (arguments as `shift`) for a task after the release paint, so
	 * the release frame does not pay it; runQueued or the next get runs it. */
	queueShift(rows: readonly InkRow[], ids: readonly string[], steps: readonly number[]): void {
		this.queued = {rows, ids, steps};
	}

	/** Run the queued shift against `strokes`, if one is waiting. */
	runQueued(strokes: readonly InkStroke[]): boolean {
		const q = this.queued;
		if (!q) return false;
		this.queued = null;
		return this.shift(strokes, q.rows, q.ids, q.steps);
	}

	/**
	 * An insert space that opened space moved whole rows straight down: bring
	 * the rows up to date without reading every point in the note. On a
	 * 28555-stroke note the rebuild took about 61 ms, on the first hover after
	 * every insert.
	 *
	 * `rows` is the array this cache returned when the gesture began, `ids` the
	 * strokes it moved, and `steps` every dy it moved them by, in order, one
	 * moveStrokes call each. A first-pass group the move carried and that
	 * meets no staying group shifts by the same additions in the same order
	 * as its points took: rounding is monotone, so its top and bottom land
	 * where a rescan would find them, and its joins are the ones it had. A new
	 * join needs a moved stroke and a staying one that overlap vertically
	 * after the move (a group crossing the seam carries strokes above it down
	 * beside the staying ones) and lie close enough sideways: an ordinary
	 * join reaches three times the shorter stroke's height, a mark's join the
	 * taller one's. The groups of every such pair, judged by group extents and
	 * each group's tallest stroke (so the check only errs toward regrouping),
	 * are grouped again from the cached stroke extents, a moved stroke's
	 * shifted by the same steps, so no point is read. The floating-mark pass
	 * then runs over all the groups, as localRowsOf runs it.
	 *
	 * Returns false with the cache untouched, so the next get rebuilds, when
	 * anything changed since `rows` other than these steps over these ids, a
	 * group moved in part or did not end up lower, or two groups the shift
	 * placed share a top and left (localRowsOf breaks that tie by grouping
	 * order).
	 */
	shift(strokes: readonly InkStroke[], rows: readonly InkRow[], ids: readonly string[], steps: readonly number[]): boolean {
		if (rows !== this.rows || steps.length === 0 || strokes.length !== this.entries.length) return false;
		const moved = new Set(ids);
		if (moved.size !== ids.length) return false;
		let found = 0;
		for (let i = 0; i < strokes.length; i++) {
			const e = this.entries[i]!, s = strokes[i]!;
			const m = moved.has(s.id);
			if (m) found++;
			if (e.stroke !== s || strokeRev(s) !== e.rev + (m ? steps.length : 0)) return false;
		}
		if (found !== moved.size) return false;
		const f = (y: number) => { for (const d of steps) y += d; return y; };
		const groups = this.groups;
		let inGroups = 0;
		const isMoved: boolean[] = [];
		for (const g of groups) {
			let n = 0;
			for (const id of g.ids) if (moved.has(id)) n++;
			if ((n !== 0 && n !== g.ids.length) || (n > 0 && !(f(g.top) > g.top))) return false;
			inGroups += n;
			isMoved.push(n > 0);
		}
		if (inGroups !== moved.size) return false;
		// Groups are in top order and f keeps it, so the moved ones are in order of their new tops.
		const movedAt: number[] = [], stayAt: number[] = [];
		groups.forEach((_, i) => (isMoved[i] ? movedAt : stayAt).push(i));
		const newTop = movedAt.map(i => f(groups[i]!.top)), touched = new Set<number>();
		for (const si of stayAt) {
			const st = groups[si]!;
			for (let k = 0; k < movedAt.length && newTop[k]! <= st.bottom; k++) {
				const mv = groups[movedAt[k]!]!;
				if (f(mv.bottom) < st.top) continue;
				const apart = Math.max(0, st.left - mv.right, mv.left - st.right);
				const lo = Math.min(st.tallest, mv.tallest), hi = Math.max(st.tallest, mv.tallest);
				if (apart <= Math.max(3 * lo, hi) * (1 + 1e-9) + 1e-9) { touched.add(si); touched.add(movedAt[k]!); }
			}
		}
		const next: (Group & {kept: boolean})[] = [];
		groups.forEach((g, i) => {
			if (touched.has(i)) return;
			next.push(isMoved[i] ? { top: f(g.top), bottom: f(g.bottom), left: g.left, right: g.right, tallest: g.tallest, ids: g.ids, kept: false } : { ...g, kept: true });
		});
		// A moved stroke's extent is its cached one after the same steps (no point is read).
		const extents = this.extents.map(e => moved.has(e.id) ? { ...e, top: f(e.top), bottom: f(e.bottom) } : e);
		if (touched.size) {
			const again = new Set<string>();
			for (const i of touched) for (const id of groups[i]!.ids) again.add(id);
			for (const g of groupsOf(extents.filter(e => again.has(e.id)))) next.push({ ...g, kept: false });
		}
		next.sort((a, b) => a.top - b.top || a.left - b.left);
		for (let i = 1; i < next.length; i++) {
			const a = next[i - 1]!, b = next[i]!;
			if (a.top === b.top && a.left === b.left && !(a.kept && b.kept)) return false;
		}
		const nextGroups: Group[] = next.map(({ top, bottom, left, right, tallest, ids }) => ({ top, bottom, left, right, tallest, ids }));
		for (let i = 0; i < strokes.length; i++) if (moved.has(strokes[i]!.id)) this.entries[i] = { stroke: strokes[i]!, rev: strokeRev(strokes[i]!) };
		this.extents = extents;
		this.groups = nextGroups;
		({ rows: this.rows, spans: this.spans } = withMarks(nextGroups));
		// Every entry was just checked against `strokes`, so the next ask can hit.
		this.seen = { list: strokes, ink: inkRevision() };
		return true;
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
	//
	// Every mark is judged against its host as the first pass left it, kept in
	// `first`, so a row that already joined does not make the host taller or
	// wider for the next one and let a chain of marks pull in a line too far.
	const first = new Map(rows.map((r) => [r, { top: r.top, bottom: r.bottom, span: xSpan(r.ids, spans) }]));
	for (let i = rows.length - 2; i >= 0; i--) {
		const mark = rows[i]!;
		const host = rows[i + 1]!;
		const base = first.get(host)!;
		const gap = base.top - mark.bottom;
		if (gap < 0 || gap > base.bottom - base.top) continue;
		const m = first.get(mark)!.span;
		const h = base.span;
		if (m === null || h === null) continue;
		const narrow = m.right - m.left <= (h.right - h.left) * 0.34;
		const over = m.left >= h.left - 1 && m.right <= h.right + 1;
		if (!narrow || !over) continue;
		host.ids.push(...mark.ids);
		host.top = Math.min(host.top, mark.top);
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
function localRowsOf(strokes: readonly InkStroke[]): {extents: Extent[]; groups: Group[]; rows: InkRow[]; spans: {left: number; right: number}[]} {
	const extents = strokes.map((s) => ({ id: s.id, ...extentOf(s) }));
	const groups = groupsOf(extents);
	return {extents, groups, ...withMarks(groups)};
}

/** One stroke's id and the extent of its points. */
type Extent = {id: string; top: number; bottom: number; left: number; right: number};

/** A first-pass group: one component of the joins below, before floating marks attach. */
type Group = InkRow & {left: number; right: number; tallest: number};

/** The first pass of localRowsOf: components of the stroke joins, in (top, left) order.
 * Extents in store order. */
function groupsOf(extents: readonly Extent[]): Group[] {
	const items = [...extents].sort((a, b) => a.top - b.top || a.left-b.left);
	const parents=items.map((_,i)=>i);
	const root=(i:number):number=>{
		while(parents[i]!==i){parents[i]=parents[parents[i]!]!;i=parents[i]!;}
		return i;
	};
	// A mark (a full stop, a comma, a colon's dots, a dash) is too short for
	// the rule below: a tapped dot has no height, so it joined nothing and
	// Insert space left it behind its word. A stroke is a mark beside another
	// when its height is at most a quarter of the other's, its vertical span
	// lies inside the other's, and its width is at most 0.34 of the other's
	// height; it may then join across a gap of up to the larger of three of
	// its own heights and the other's height. A mark takes ONE such join, to
	// the nearest candidate (the first in sort order on a tie), so a full stop
	// between its word and a tall drawing never joins the two. A stroke that
	// joins a neighbour the ordinary way is not a mark: a letter of a word
	// passes the mark test beside a tall drawing, and would carry its word in.
	const markTo=items.map(()=>-1),markGap=items.map(()=>Infinity),joined=items.map(()=>false);
	const markJoin=(m:number,o:number,gap:number)=>{
		const mk=items[m]!,ot=items[o]!,hm=mk.bottom-mk.top,ho=ot.bottom-ot.top;
		if(!(hm<=ho/4&&mk.top>=ot.top&&mk.bottom<=ot.bottom&&mk.right-mk.left<=ho*.34&&gap<=Math.max(3*hm,ho)))return;
		if(gap<markGap[m]!||(gap===markGap[m]!&&o<markTo[m]!)){markGap[m]=gap;markTo[m]=o;}
	};
	let active:number[]=[];
	for(let i=0;i<items.length;i++){
		const a=items[i]!;
		active=active.filter(j=>items[j]!.bottom>a.top);
		for(const j of active){
			const b=items[j]!;
			if(a.bottom<=b.top)continue;
			const gap=Math.max(0,a.left-b.right,b.left-a.right);
			if(gap<=3*Math.min(a.bottom-a.top,b.bottom-b.top)){parents[root(i)]=root(j);joined[i]=joined[j]=true;}
			markJoin(i,j,gap);markJoin(j,i,gap);
		}
		active.push(i);
	}
	markTo.forEach((o,m)=>{if(o>=0&&!joined[m])parents[root(m)]=root(o);});
	const grouped=new Map<number,Group>();
	items.forEach((s,i)=>{
		const key=root(i),row=grouped.get(key);
		if(row){row.ids.push(s.id);row.top=Math.min(row.top,s.top);row.bottom=Math.max(row.bottom,s.bottom);row.left=Math.min(row.left,s.left);row.right=Math.max(row.right,s.right);row.tallest=Math.max(row.tallest,s.bottom-s.top);}
		else grouped.set(key,{top:s.top,bottom:s.bottom,left:s.left,right:s.right,tallest:s.bottom-s.top,ids:[s.id]});
	});
	return [...grouped.values()].sort((a,b)=>a.top-b.top||a.left-b.left);
}

/** The second pass of localRowsOf: floating marks onto their hosts. Groups in
 * (top, left) order; they are copied, never changed. */
function withMarks(groups: readonly Group[]): {rows: InkRow[]; spans: {left: number; right: number}[]} {
	// `g` is the row's first-pass group, the only geometry a mark or a host is
	// judged by; top, left, right and ids grow as the row takes marks, for the
	// row it reports.
	const rows=groups.map((g,ord)=>({g,ord,top:g.top,left:g.left,right:g.right,ids:[...g.ids]}));
	// A floating mark chooses the nearest eligible LOCAL host below it,
	// regardless of interleaved groups in another column. The height-relative
	// width/overhang allowance also handles a dot above a lone vertical stem.
	//
	// A host is judged by its own group, never by the marks it has taken. A
	// host judged grown was taller and wider after every mark, which made the
	// next row above it a mark too: on a heavy page one low wide drawing took
	// row after row up the page, and a note of 19,736 strokes became one row
	// from near its top to near its bottom, so a divider anywhere moved or
	// kept that whole row. Judged by its own group, a host takes only what
	// lies within its own height above its own top.
	//
	// A host starts at or below the mark (gap >= 0) and no further below it
	// than its own height, so only rows whose top lies within the tallest
	// group's height under the mark can qualify. `byTop` keeps the live rows
	// ordered by their group's top, so each mark checks that window instead
	// of every row: the all-rows filter per mark was quadratic, 30-80 ms on a
	// note of one to two thousand written lines, after every ink change. The
	// choice is the one the filter-and-sort made: nearest gap, then centre
	// offset, then left, then the earlier row (`ord`, the stable sort's tie).
	const byTop=[...rows];
	const firstFrom=(y:number)=>{
		let lo=0,hi=byTop.length;
		while(lo<hi){const mid=(lo+hi)>>1;if(byTop[mid]!.g.top<y)lo=mid+1;else hi=mid;}
		return lo;
	};
	let tallest=0;
	for(const {g} of rows)tallest=Math.max(tallest,g.bottom-g.top);
	for(const mark of [...rows].reverse()){
		const m=mark.g;
		let host:(typeof rows)[number]|null=null;
		for(let i=firstFrom(m.bottom);i<byTop.length;i++){
			const cand=byTop[i]!,c=cand.g;
			if(c.top-m.bottom>tallest)break;
			if(cand===mark)continue;
			const height=c.bottom-c.top,gap=c.top-m.bottom;
			if(!(height>0 && gap>=0 && gap<=height && m.bottom-m.top<=height*.34 &&
				m.right-m.left<=Math.max(c.right-c.left,height*.25)*.34 &&
				m.left>=c.left-height*.1 && m.right<=c.right+height*.1))continue;
			if(host){
				const h=host.g;
				const order=(c.top-m.bottom)-(h.top-m.bottom)||
					Math.abs(c.left+c.right-m.left-m.right)-Math.abs(h.left+h.right-m.left-m.right)||
					c.left-h.left||cand.ord-host.ord;
				if(!(order<0))continue;
			}
			host=cand;
		}
		if(!host)continue;
		host.ids.push(...mark.ids);host.top=mark.top;
		host.left=Math.min(host.left,mark.left);host.right=Math.max(host.right,mark.right);
		// Drop the mark, which has no other place to be and hosts nothing now.
		byTop.splice(byTop.indexOf(mark),1);
	}
	byTop.sort((a,b)=>a.top-b.top||a.left-b.left||a.ord-b.ord);
	return {rows:byTop.map(({top,g,ids})=>({top,bottom:g.bottom,ids})),spans:byTop.map(({left,right})=>({left,right}))};
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
		if (rowMoves(row, lineY)) for (const id of row.ids) moving.add(id);
	}
	// Store order, so z-order and the op's id list stay in the store's terms.
	return strokes.filter((s) => moving.has(s.id)).map((s) => s.id);
}

/** Whether a divider at world y moves the row: wholly below, or crossing it in its upper half (strokeIdsBelow). */
function rowMoves(row: InkRow, lineY: number): boolean {
	return row.top >= lineY || lineY < (row.top+row.bottom)/2;
}

/**
 * Whether dividers at world y `a` and `b` put every row on the same side: moving (rowMoves), staying (crossing the line
 * without moving) or neither. Then strokeIdsBelow and the staying list are the same at both.
 */
export function sameRowSides(rows: readonly InkRow[], a: number, b: number): boolean {
	if (a === b) return true;
	for (const row of rows) {
		const moves = rowMoves(row, a);
		if (moves !== rowMoves(row, b)) return false;
		// A row that does not move has its top above the line, so it stays exactly when its bottom is below it.
		if (!moves && (row.bottom > a) !== (row.bottom > b)) return false;
	}
	return true;
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
