/**
 * The note surface's viewport layout and box: taking the layout over from the
 * editor, measuring the natural column, and writing the scroll, the host
 * transform, the canvas layers and the box on every pan and pinch frame. They
 * are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads.
 */
import { installMethods } from "./InstallMethods";
import { Platform } from "obsidian";
import { contentOrigin } from "./ContentOrigin";
import { rasterScale, canvasLayerBox } from "./ZoomScale";
import { PAN_FIT_SLACK_PX, SCALE_EPSILON, PAPER_PROPERTIES, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		restoreViewportLayout(): void;
		prepareViewportLayout(): boolean;
		scheduleViewportStyleRefresh(): void;
		refreshViewportColumn(): boolean;
		measureNaturalColumn(box: { width: number; height: number } | null): { column: number; columnBox: number; lineContent: number; gutterX: number; sizerColumn: boolean; columnInset: boolean; ownLines: boolean; left: string; right: string; columnLocal: number | null; columnReserve: number; columnAuto: { lineWidth: number; fixed: number; scrollbar: number } | null };
		measureColumnAuto(hostWidth: number, ownLineBox?: number | null): { lineWidth: number; fixed: number; scrollbar: number } | null;
		setViewportScroll(left: number, top: number): void;
		setScrollResidual(x: number, y: number, left: number, top: number): void;
		hostTransform(k: number): string;
		scrollbarUnscaleAt(k: number): number | null;
		scrollbarLocalAt(bar: number, k: number): number;
		placeCanvasLayers(): void;
		applyViewportBox(next: number, deferPaper?: boolean): void;
		writeGutterTravel(next: number, release?: boolean): void;
		/** Host-local px the line-number gutter reaches past the content's left edge, read in an unowned layout (measureNaturalColumn). */
		columnGutterReserve?: number;
	}
}

 function restoreViewportLayout(this: InkOverlayPlugin):void {
  this.pinchPreview=false;
  // Before the no-layout return: an unmount at rest leaves nothing behind either.
  this.clearOwnPaperVars();
  // Reached from update() on a file switch, inside CodeMirror's own update:
  // the make-up measure waits a frame (a synchronous one would nest).
  this.releaseMeasures(true);
  this.clearViewportPan();
  this.clearPreviewInkOffset();
  this.hostTransformScale=null;this.scrollResidual={x:0,y:0,left:0,top:0};
  this.rasterColumnLocal=null; this.previewAnchorStale=false; this.clearDeferredRepaint();
  this.viewportGeneration++;
  this.viewportPaneObserver?.disconnect();this.viewportPaneObserver=null;
  this.aboveContentObserver?.disconnect();this.aboveContentObserver=null;
  this.viewportStyleObserver?.disconnect();this.viewportStyleObserver=null;
  this.viewportStyleDirty=null;
  if(this.viewportStyleFrame){this.winRef.cancelAnimationFrame(this.viewportStyleFrame);this.viewportStyleFrame=0;}
  const layout=this.viewportLayout;
  if(!layout) return;
  // At rest after the release the zoom is the external scale alone; the
  // measured cssScale still holds the gesture's until the next refresh.
  this.paperRestZoom=layout.externalScale;
  const host=this.view.dom;
  host.classList.remove("handwriting-note-viewport","handwriting-note-viewport-own-lines","handwriting-scrollbar-unscaled");this.scrollbarUnscale=null;
  layout.parent.classList.remove("handwriting-note-viewport-pane");
  for(const [name,saved] of layout.styles) {
   if(saved.value) host.style.setProperty(name,saved.value,saved.priority); else host.style.removeProperty(name);
  }
  this.viewportLayout=null;
 }

 function prepareViewportLayout(this: InkOverlayPlugin):boolean {
  const host=this.view.dom,parent=host.parentElement;
  if(!parent||!host.clientWidth||!host.clientHeight) return false;
  if(!this.viewportLayout) {
   // `zoom` is in the list because the release replays exactly what is named
   // here: a shrink the host was never given back would outlive the overlay,
   // with no counter-sized box left to justify it.
   // THE HOST'S OWN `zoom`, before the overlay writes one. `zoom` is a
   // single property, so the box write below REPLACES a theme's
   // `.cm-editor { zoom: 1.25 }` rather than composing with it, and the
   // camera would then be reading a scale the host is not at. Captured
   // here, once per takeover, and multiplied into every frame's write.
   // Read while no plugin zoom is on the host: the release replays the
   // saved inline value, so a later capture sees the theme's again.
   // Not a finite positive number - `normal`, or a rig with no `zoom` at
   // all - is a factor of 1, which writes exactly what it wrote before.
   const names=["width","height","transform","transform-origin","zoom","--handwriting-note-column-width","--handwriting-note-line-width","--handwriting-note-column-margin-left","--handwriting-note-column-margin-right","--handwriting-column-margin-left","--handwriting-column-auto-left","--handwriting-paper-pitch","--handwriting-paper-rule","--handwriting-paper-dot","--handwriting-paper-phase","--handwriting-paper-phase-x","--handwriting-scrollbar-unscale"];
   const layout:NonNullable<InkOverlayPlugin["viewportLayout"]>={parent,paneWidth:parent.clientWidth,paneHeight:parent.clientHeight,externalScale:this.cssScale/this.pinchScaleNow,baseTransform:this.winRef.getComputedStyle(host).transform,baseZoom:(()=>{const z=Number.parseFloat(this.winRef.getComputedStyle(host).zoom);return Number.isFinite(z)&&z>0?z:1;})(),width:Number.parseFloat(this.winRef.getComputedStyle(host).width)||host.clientWidth,height:Number.parseFloat(this.winRef.getComputedStyle(host).height)||host.clientHeight,column:0,columnBox:0,lineContent:0,gutterX:0,gutterScreen:0,sizerColumn:false,columnInset:false,ownLines:false,left:"",right:"",columnLocal:null,columnReserve:0,columnAuto:null,styles:new Map(names.map(n=>[n,{value:host.style.getPropertyValue(n),priority:host.style.getPropertyPriority(n)}]))};
   this.viewportLayout=layout;
   {
    const sc0=this.view.scrollDOM,r0=sc0.getBoundingClientRect();
    const st0=this.winRef.getComputedStyle(sc0);
    const bx0=(Number.parseFloat(st0.borderLeftWidth)||0)+(Number.parseFloat(st0.borderRightWidth)||0);
    const gl0=Math.max(0,sc0.offsetWidth-sc0.clientWidth-bx0);
    const gs0=sc0.offsetWidth>0&&r0.width>0?gl0*r0.width/sc0.offsetWidth:0;
    if(Number.isFinite(gs0)&&gs0>=0)layout.gutterScreen=gs0;
   }
   // Paper values that are the overlay's own at-rest plan are not the host's
   // to be given back: a release takes them off (clearOwnPaperVars) and the
   // paper is planned at rest again, rather than replaying a plan made before
   // the gesture. A host's own inline value (a theme's,
   // or one set with a priority) is still restored as it was found.
   for(const name of PAPER_PROPERTIES){const saved=layout.styles.get(name);if(saved?.value&&!saved.priority&&saved.value===this.paperWritten?.get(name))layout.styles.delete(name);}
   // The same measurement a resize and a theme refresh take, so the frozen
   // value they compare against was read in the same basis. The saved styles
   // above are captured first: the measurement writes the host's box.
   const natural=this.measureNaturalColumn(null);
   layout.column=natural.column;layout.columnBox=natural.columnBox;layout.lineContent=natural.lineContent;layout.gutterX=natural.gutterX;layout.sizerColumn=natural.sizerColumn;layout.columnInset=natural.columnInset;layout.ownLines=natural.ownLines;layout.left=natural.left;layout.right=natural.right;layout.columnLocal=natural.columnLocal;layout.columnReserve=natural.columnReserve;layout.columnAuto=natural.columnAuto;
  }
  this.observeAboveContent();
  if(!this.viewportPaneObserver) {
   this.viewportPaneObserver=new ResizeObserver(()=>this.handleResize());
   this.viewportPaneObserver.observe(parent);
   const doc=host.ownerDocument;
   // The pane's class TOKENS minus the overlay's own, never its class string:
   // removing the token from the string left a trailing space, so the first
   // owned box write changed the stamp and scheduled a refresh after every
   // takeover - a forced layout, and a re-commit that could retire a pending
   // settle. Tokens compare the same however the list was edited.
   const stamp=()=>[doc.documentElement.className,doc.documentElement.getAttribute("style"),doc.body.className,doc.body.getAttribute("style"),Array.from(parent.classList).filter(token=>token!=="handwriting-note-viewport-pane").join(" "),parent.getAttribute("style")].join("|");
   this.viewportStyleStamp=stamp();
   this.viewportStyleObserver=new MutationObserver(records=>{
    const next=stamp();
    if(next===this.viewportStyleStamp&&!records.some(r=>doc.head.contains(r.target)))return;
    this.viewportStyleStamp=next;
    this.viewportStyleDirty={path:this.filePath(),container:this.container};
    this.scheduleViewportStyleRefresh();
   });
   this.viewportStyleObserver.observe(doc.head,{childList:true,subtree:true,characterData:true});
   for(const el of new Set([doc.documentElement,doc.body,parent]))this.viewportStyleObserver.observe(el,{attributes:true,attributeFilter:["class","style"]});
  }
  return true;
 }

 function scheduleViewportStyleRefresh(this: InkOverlayPlugin):void {
  if(!this.viewportStyleDirty||this.viewportStyleFrame)return;
  this.viewportStyleFrame=this.winRef.requestAnimationFrame(()=>{
   this.viewportStyleFrame=0;
   const dirty=this.viewportStyleDirty;
   if(!dirty)return;
   if(dirty.path!==this.filePath()||dirty.container!==this.container){this.viewportStyleDirty=null;return;}
   // Keep one dirty marker; pen-up schedules the single retry, never a loop.
   if(this.frame.locked||this.deferPinchRaster()||!this.viewportLayout?.parent.clientWidth||!this.viewportLayout.parent.clientHeight)return;
   if(this.refreshViewportColumn())this.viewportStyleDirty=null;
  });
 }

 /** Re-measure the ordinary column when a theme changes at constant pane size. */
 function refreshViewportColumn(this: InkOverlayPlugin):boolean {
  const layout=this.viewportLayout;
  if(!layout||this.frame.locked||!this.container)return false;
  const scroller=this.view.scrollDOM;
  const savedLeft=scroller.scrollLeft,savedTop=scroller.scrollTop;
  const {column,columnBox,lineContent,gutterX,sizerColumn,columnInset,ownLines,left,right,columnLocal,columnReserve,columnAuto}=this.measureNaturalColumn({width:layout.width,height:layout.height});
  // columnBox and sizerColumn are in the compare because a theme change can move the column without moving `.cm-content`
  // - that is exactly what Minimal does, and it is why neither the ResizeObserver nor the content-origin compare fired.
  // lineContent counts only under a theme that sizes its own lines, the one place the stylesheet reads it: elsewhere a
  // line's own padding change would re-commit for a variable nothing uses.
  const changed=column!==layout.column||columnBox!==layout.columnBox||(ownLines&&lineContent!==layout.lineContent)||sizerColumn!==layout.sizerColumn||columnInset!==layout.columnInset||ownLines!==layout.ownLines||left!==layout.left||right!==layout.right||(columnLocal===null?null:columnLocal-columnReserve)!==this.columnMarginLocal(layout);
  if(column>0&&changed){layout.column=column;layout.columnBox=columnBox;layout.lineContent=lineContent;layout.gutterX=gutterX;layout.sizerColumn=sizerColumn;layout.columnInset=columnInset;layout.ownLines=ownLines;layout.left=left;layout.right=right;layout.columnLocal=columnLocal;layout.columnReserve=columnReserve;}
  // A theme change is the one way `--file-line-width` moves at a constant pane
  // size, so the auto term's inputs are re-read in the same unowned layout.
  if(column>0)layout.columnAuto=columnAuto;
  this.applyViewportBox(this.pinchScaleNow);
  scroller.scrollLeft=savedLeft;scroller.scrollTop=savedTop;
  if(column>0&&changed)this.commitCameraScale(this.pinchScaleNow, undefined, undefined, true);
  return column>0;
 }

 /**
  * THE NATURAL COLUMN, MEASURED AT UNITY: the one measurement takeover, a pane
  * resize and a theme refresh all take, so the frozen column they compare is
  * always read in the same basis. Ownership comes off first - the class, and
  * with a `box` the host's box at that local size and its `zoom` back to the
  * value the host had before the overlay (the saved inline one, or none). The
  * zoom is the part the class cannot take off: on the transform host the shrink
  * lifted with the class, but on the zoom host it is an inline style, and a
  * column measured under it resolves the theme's auto margin in a mixed basis
  * (7.5 local px short at k .5, frozen, then a hop at the next pinch end).
  * Nothing is restored here: every caller ends in `applyViewportBox`, which
  * writes class, box and zoom back, and writes the layout fields BEFORE it so no
  * measured value is stored while the plugin's zoom is on the host.
  * `box` null is takeover: nothing of the overlay's is on the host yet and its
  * own box is left alone.
  * With the zoom off, the rect fallback divides by the external scale alone;
  * the transform fallback still carries its scale inline, as it always did.
  */
 /**
  * THE COLUMN, MEASURED, and three numbers no stylesheet decides.
  *
  * `columnBox` is the TEXT COLUMN's width, read off the LINE BOX - the element `contentOrigin` already picks for the
  * column's LEFT - rather than off `.cm-content`. That element is the column only under a theme that caps and centres
  * it, which is Obsidian's own; Minimal forces `.cm-content` and `.cm-sizer` to full width and gives the LINE the
  * readable width (theme.css:1852-1867), so `column` there is the whole pane and reads "this page cannot fit" at every
  * zoom. Measured: default 700 in a 1383 content box at inset 341.25; Minimal 648 in 1383 at 367.25; the setting off
  * 1383 in 1383. Same note, same pane.
  *
  * `gutterX` is the vertical scrollbar, in painted px. The pane is the scroller's BORDER box and the page is laid out
  * inside its CONTENT box, narrower by this. Fifteen px, and leaving it out put every centred rest half a gutter right
  * of where the engine's own centring puts the column - 7.75 px, at every zoom, on both themes.
  *
  * `sizerColumn` says whether the SIZER is the thing that carries the column's inset, which is the only case where
  * freezing the sizer's margin restates where the column already was. Measured unowned: Obsidian's own theme puts the
  * sizer at 341 with the column at 341.25 - the same place. Minimal puts it at 0, full width.
  */
 function measureNaturalColumn(this: InkOverlayPlugin, box:{width:number;height:number}|null):{column:number;columnBox:number;lineContent:number;gutterX:number;sizerColumn:boolean;columnInset:boolean;ownLines:boolean;left:string;right:string;columnLocal:number|null;columnReserve:number;columnAuto:{lineWidth:number;fixed:number;scrollbar:number}|null} {
  const layout=this.viewportLayout!,host=this.view.dom,scroller=this.view.scrollDOM;
  if(box) {
   host.classList.remove("handwriting-note-viewport");
   host.setCssStyles({width:`${box.width}px`,height:`${box.height}px`});
   const saved=layout.styles.get("zoom");
   if(saved?.value)host.style.setProperty("zoom",saved.value,saved.priority);else host.style.removeProperty("zoom");
  }
  const style=this.winRef.getComputedStyle(this.view.contentDOM);
  const sizer=this.panSizer();
  const column=this.view.contentDOM.offsetWidth;
  const natural=contentOrigin(this.view.contentDOM);
  const rectScale=!box||this.zoomFormAt(this.pinchScaleNow)?this.cssScale/this.pinchScaleNow:this.cssScale;
  const hostRect=host.getBoundingClientRect();
  // Takeover's read used to be `columnLocalAt`, which leaves the host's painted
  // origin for the gesture's later reads; kept, so a takeover inside a gesture
  // hands the same origin on. Resize and refresh never wrote it.
  if(!box&&this.previewHostOrigin){this.previewHostOrigin.left=hostRect.left;this.previewHostOrigin.top=hostRect.top;this.previewHostOrigin.valid=true;}
  // TAKEOVER READS THE RECT, as it always did. The margin walk sums the owned
  // tree's resolved margins, and before the first owned write the sizer's
  // theme `margin-left: auto` can read 0px while the sizer sits at its centred
  // offset: measured 0px against offsetLeft 341 at scroll 4000 on a 10838 px
  // extent, which froze the column at 0 and made the first refresh "change"
  // it to 341.25 - a re-commit and an 85 px hop at 25 percent.
  const columnLocal=(box?this.ownedColumnLayoutLeft(natural.line):null) ?? (natural.left===null?null:(natural.left-this.panX()-hostRect.left)/rectScale+scroller.scrollLeft);
  // No extra forced read: the scan above already laid all of this out.
  const lineBox=natural.line instanceof HTMLElement?natural.line.offsetWidth:0;
  // The line's CONTENT width, which is what a min-width holds on a content-box line: the box less its horizontal
  // padding and border (measured 8 px of padding on a 648 px line box). One style read, in this unowned layout only.
  const lineContent=(()=>{if(!(natural.line instanceof HTMLElement)||!(lineBox>0))return 0;const ls=this.winRef.getComputedStyle(natural.line);if(ls.boxSizing==="border-box")return lineBox;const edge=(Number.parseFloat(ls.paddingLeft)||0)+(Number.parseFloat(ls.paddingRight)||0)+(Number.parseFloat(ls.borderLeftWidth)||0)+(Number.parseFloat(ls.borderRightWidth)||0);return Math.max(0,lineBox-edge);})();
  const sr=scroller.getBoundingClientRect(),ss=this.winRef.getComputedStyle(scroller);
  const border=(Number.parseFloat(ss.borderLeftWidth)||0)+(Number.parseFloat(ss.borderRightWidth)||0);
  const gutterLocal=Math.max(0,scroller.offsetWidth-scroller.clientWidth-border);
  const gutterX=scroller.offsetWidth>0&&sr.width>0?gutterLocal*sr.width/scroller.offsetWidth:0;
  const sizerLeft=sizer?sizer.offsetLeft:null;
  // THE LEFT RESERVE IS PAINTED, NOT LAID OUT. Its `translate` on the sizer is in the rect read above, so
  // `columnLocal` is where the column is painted (the pinch anchor and the pan bounds want that), while
  // `offsetLeft` and every margin written from `columnLocal` do not carry it: those subtract `columnReserve`.
  const columnReserve=this.leftReserveHeld>0?this.leftReserveHeld:0;
  const sizerColumn=columnLocal!==null&&sizerLeft!==null&&Math.abs(sizerLeft-(columnLocal-columnReserve))<=PAN_FIT_SLACK_PX;
  // IS THERE A READABLE COLUMN HERE AT ALL: the page is NARROWER than the scroller's content box in its own natural
  // layout. This is not the old `|columnLocal - beside/2| <= 1` gate coming back - that one asked `.cm-content`, which is
  // why it read "no column" under a theme that centres its lines. This asks the measured column, and it is the half of
  // the question the fit cannot answer: with Readable line length OFF the page is 1383 local px at EVERY zoom, so below
  // 100% it fits the pane with room to spare and a fit-only test engages on it - measured, a 524.06 px preview pan at
  // 25% and the settle 345.75 px off the note's origin edge, on a setting that is meant to be untouched. Measured
  // natural widths: default 700 in 1383, Minimal 648 in 1383, setting off 1383 in 1383.
  const columnBoxLocal=lineBox>0?lineBox:column;
  const columnInset=columnBoxLocal>0&&scroller.clientWidth>0&&columnBoxLocal<=scroller.clientWidth-PAN_FIT_SLACK_PX;
  // DOES THE THEME CENTRE ITS OWN LINES: there is a readable column, it is inset, and the SIZER is not what puts it there
  // - the sizer sits at the scroller's left edge while the line does not. Minimal, measured unowned: sizer offsetLeft 0,
  // line inset 367.25, column 648 in 1383. Obsidian's own theme fails it (sizer 341 = the inset) and keeps the freeze;
  // Readable line length off fails it (no inset). Under it `applyViewportBox` does not freeze `.cm-content`'s width.
  const ownLines=columnInset&&sizerLeft!==null&&Math.abs(sizerLeft)<=PAN_FIT_SLACK_PX&&columnLocal!==null&&columnLocal>PAN_FIT_SLACK_PX;
  // THE GUTTER'S RESERVE, host-local, read where the column is: at the takeover and in each unowned layout, never per frame.
  // Minimal makes `.cm-gutters` `position: absolute !important`: out of the flow, so the content starts at the
  // gutter's own left and the theme keeps the text clear of the numbers only by the readable-line-length margin. Zoomed
  // in, that margin goes to 0 and every line slides under the numbers (Alan's device, d1-trace/orion-v3: 42.5 px clear at
  // 100%, meeting at k 1.158, 191.4 px covered at k 5.981). The reserve is how far the gutter reaches past the content's
  // left; the own-lines margin never goes below it (applyViewportBox, appliedColumnMargin). A gutter in the flow - CodeMirror's
  // sticky, Obsidian's default theme - ends where the content starts, and its reserve is 0.
  {const g=this.view.dom.querySelector?.<HTMLElement>(".cm-gutters"),gr=g?.getBoundingClientRect?.(),cr=this.view.contentDOM.getBoundingClientRect?.();const reach=gr&&cr&&gr.width>0&&rectScale>0?(gr.right-cr.left)/rectScale:0;this.columnGutterReserve=Number.isFinite(reach)&&reach>0?reach:0;}
  return {column,columnBox:columnBoxLocal,lineContent,gutterX:Number.isFinite(gutterX)?gutterX:0,sizerColumn,columnInset,ownLines,left:style.marginLeft,right:style.marginRight,columnLocal,columnReserve,columnAuto:this.measureColumnAuto(box?box.width:layout.width,ownLines?columnBoxLocal:null)};
 }

 /**
  * The inputs of Readable line length's auto-centring term, read in an
  * UNOWNED layout (takeover, a pane resize, a theme refresh), so that
  * `applyViewportBox` can write the term as a number on every frame with no
  * read of its own. The stylesheet used to compute it as
  * `(100% - var(--file-line-width)) / 2`; under the zoom host the engine
  * resolves that `100%` in a mixed basis (the scroller's width with its
  * scrollbar counted in screen px), so the term shrank with k and won the
  * clamp against the frozen column: a column 7.5 (1/k - 1) local px left of
  * where it was, and a hop of that size when a pinch settled.
  *
  * `hostWidth` is the host's local width in this layout. Read only through
  * `measureNaturalColumn`, so the plugin's zoom is never on the host here and
  * local px are the host's own. Returns:
  * - `lineWidth`: `--file-line-width` when it is plain px (the old rule's own
  *   term), else the sizer's computed `max-width` in px;
  * - `fixed`: what the host holds beside the scroller's content box that does
  *   NOT scale - everything outside the scroller, plus its border and padding;
  * - `scrollbar`: the scrollbar at the host's own size (`offsetWidth -
  *   clientWidth - borders`, an integer difference, exact for an integer
  *   scrollbar). Under css zoom it keeps this screen size, which is why
  *   `applyViewportBox` divides it by the zoom.
  * Null when the line width is not px: `applyViewportBox` then leaves the
  * property unset and the stylesheet's percentage fallback applies, as before.
  * NOT COVERED: a scrollbar that appears or disappears with k (a note short
  * enough to stop overflowing at some scale) keeps the value read here until
  * the next resize or theme refresh.
  */
 function measureColumnAuto(this: InkOverlayPlugin, hostWidth:number,ownLineBox:number|null=null):{lineWidth:number;fixed:number;scrollbar:number}|null {
  const host=this.view.dom,scroller=this.view.scrollDOM,sizer=this.panSizer();
  // A unit rig's stand-in DOM has no rects: no inputs, the stylesheet fallback.
  if(!sizer||!(hostWidth>0)||typeof host.getBoundingClientRect!=="function"||typeof scroller?.getBoundingClientRect!=="function")return null;
  const px=(value:string|undefined):number|null=>{const m=/^\s*(\d*\.?\d+)px\s*$/.exec(value??"");return m?Number(m[1]):null;};
  const sizerStyle=this.winRef.getComputedStyle(sizer);
  // A theme that centres its own lines sizes them itself (Minimal: 648 for a --file-line-width of 700), so the
  // auto term takes the measured line box there; with 700 it read 26 px short of the natural inset at 100%.
  const lineWidth=(ownLineBox!==null&&ownLineBox>0?ownLineBox:null)??px(sizerStyle.getPropertyValue?.("--file-line-width"))??px(sizerStyle.maxWidth);
  const hostRect=host.getBoundingClientRect().width;
  if(lineWidth===null||!(hostRect>0))return null;
  const s=this.winRef.getComputedStyle(scroller);
  const edge=(Number.parseFloat(s.borderLeftWidth)||0)+(Number.parseFloat(s.borderRightWidth)||0)+(Number.parseFloat(s.paddingLeft)||0)+(Number.parseFloat(s.paddingRight)||0);
  // Screen rects in one ratio: the scroller's border box in host-local px.
  const scrollerLocal=scroller.getBoundingClientRect().width*hostWidth/hostRect;
  const bar=Math.max(0,scroller.offsetWidth-scroller.clientWidth-(Number.parseFloat(s.borderLeftWidth)||0)-(Number.parseFloat(s.borderRightWidth)||0));
  return {lineWidth,fixed:Math.max(0,hostWidth-scrollerLocal)+edge,scrollbar:bar};
 }

 function setViewportScroll(this: InkOverlayPlugin, left:number,top:number):void {
  const scroller=this.view.scrollDOM;
  scroller.scrollLeft=left;scroller.scrollTop=top;
  const keptLeft=scroller.scrollLeft,keptTop=scroller.scrollTop;
  const part=(want:number,kept:number,max:number):number=>{
   const d=want-kept;
   return Math.abs(d)<1&&!(kept<=0&&want<0)&&!(kept>=max&&want>max)?d:0;
  };
  // `== null`, not `=== null`: a class field initialiser does not run for an object made with `Object.create`, which
  // is how the unit rigs build one.
  const x=this.hostTransformScale==null?0:part(left,keptLeft,scroller.scrollWidth-scroller.clientWidth);
  const y=this.hostTransformScale==null?0:part(top,keptTop,scroller.scrollHeight-scroller.clientHeight);
  this.setScrollResidual(x,y,keptLeft,keptTop);
  this.scrollExpansion?.rebase(keptLeft,keptTop);
 }

 /** Records the residual and rewrites the host's transform when it changed; a whole target writes no translate. */
 function setScrollResidual(this: InkOverlayPlugin, x:number,y:number,left:number,top:number):void {
  const r=this.scrollResidual,changed=(r?.x??0)!==x||(r?.y??0)!==y;
  this.scrollResidual={x,y,left,top};
  if(changed&&this.hostTransformScale!=null&&this.viewportLayout)this.view.dom.style.transform=this.hostTransform(this.hostTransformScale);
 }

 /** The transform form's host transform at factor k: the theme's own, then the scroll residual, then the scale. */
 function hostTransform(this: InkOverlayPlugin, k:number):string {
  const layout=this.viewportLayout!,base=layout.baseTransform!=="none"?layout.baseTransform+" ":"";
  const x=this.scrollResidual?.x??0,y=this.scrollResidual?.y??0;
  return `${base}${x!==0||y!==0?`translate(${-x*k}px, ${-y*k}px) `:""}scale(${k})`;
 }

 /**
  * THE SCROLLER'S BAR KEEPS ITS 100 PERCENT WIDTH at every note zoom (Alan, 2026-10-02: thick zoomed in). Obsidian's
  * styled bar (`body.styled-scrollbars ::-webkit-scrollbar`, every desktop platform but macOS) is sized in the
  * scroller's own px, so both host forms scaled it with the note: 21.5 CSS px at 1.79 and 6 at 0.5 for 12. The factor
  * returned here is written on the host with the `handwriting-scrollbar-unscaled` token, and the stylesheet sizes the
  * bar by it, so the bar is `scrollbar / k` local px under either form. Null at 100 percent (the theme's rules stand
  * untouched), on mobile, and where Obsidian draws native bars (macOS), which the rule does not reach. A class read,
  * no layout.
  */
 function scrollbarUnscaleAt(this: InkOverlayPlugin, k:number):number|null {
  if(Math.abs(k-1)<=SCALE_EPSILON||Platform.isMobile)return null;
  return this.view.dom.ownerDocument?.body?.classList.contains("styled-scrollbars")?1/k:null;
 }

 /** The scrollbar in host-local px at `k`, from its 100 percent width: kept at screen size under the zoom form and under the unscaled bar, scaled with the note otherwise. */
 function scrollbarLocalAt(this: InkOverlayPlugin, bar:number,k:number):number {
  return this.zoomFormAt(k)||this.scrollbarUnscaleAt(k)!==null?bar/k:bar;
 }

 /**
  * The five ink canvases' layer boxes, from the band box and scale already
  * cached on the overlay - the same `canvasLayerBox` the reallocation path
  * calls, with no read of its own, so it is safe on a frame that owns the
  * layout. Silent until the band box is known: before the first allocation
  * there is nothing to place.
  */
 function placeCanvasLayers(this: InkOverlayPlugin):void {
  if(!(this.cssWidth>0)||!(this.cssHeight>0))return;
  const raster=rasterScale(this.cssScale,this.pinchScaleNow,SCALE_EPSILON);
  const box=canvasLayerBox(this.cssWidth,this.cssHeight,raster,this.zoomFormAt(this.pinchScaleNow));
  for(const c of [this.committedCanvas,this.wetCanvas,this.highlightCanvas,this.highlightWetCanvas]) {
   c?.setCssStyles({width:`${box.width}px`,height:`${box.height}px`,transform:box.transform,transformOrigin:box.transform?"0 0":""});
  }
		this.tail?.placeInline(raster, this.zoomFormAt(this.pinchScaleNow));
		this.wet?.placeWetTile?.(raster, this.zoomFormAt(this.pinchScaleNow));
 }

 function applyViewportBox(this: InkOverlayPlugin, next:number,deferPaper=false):void {
  const layout=this.viewportLayout!,host=this.view.dom;
  // Only when missing: an add of a token already present still queues a class
  // mutation record, and the viewport style observer then ran its stamp on
  // every preview frame for a class that never changed.
  if(!host.classList.contains("handwriting-note-viewport"))host.classList.add("handwriting-note-viewport");
  if(!layout.parent.classList.contains("handwriting-note-viewport-pane"))layout.parent.classList.add("handwriting-note-viewport-pane");
  // The pane must never carry a scroll offset of its own: the stylesheet makes
  // it a clip rather than a scroll container, and this resets whatever an
  // engine without `overflow: clip` let through, so an already-shifted surface
  // heals the next time its box is applied. Cheap: two reads, writes only when
  // nonzero.
  const pane=layout.parent;
  if(pane.scrollLeft!==0||pane.scrollTop!==0){pane.scrollLeft=0;pane.scrollTop=0;}
  // THE COLUMN FREEZE, and where it does not apply. `.cm-content` is pinned at its 100% width (styles.css, the owned
  // host's content rule) so a re-centring margin cannot grow with 1/k under the counter-sized host. Under a theme that
  // centres its own LINES inside a full-width `.cm-content` that pin is exactly what stops the theme centring them:
  // measured under Minimal, the line stayed at its 100% inset and needed a 518 px rest at 25%. There the rule is scoped
  // off by a class and the theme centres the column at every zoom - no margin, no translate at rest. The anchor already
  // measures the column at both ends of a frame, so a column the theme moves stays under the fingers.
  if(host.classList.contains("handwriting-note-viewport-own-lines")!==layout.ownLines)host.classList.toggle("handwriting-note-viewport-own-lines",layout.ownLines);
  host.style.setProperty("--handwriting-note-column-width",`${layout.column}px`);
  // The line's content width at 100%, the floor the own-lines rule holds every line to (styles.css): a theme's
  // percentage max-width would otherwise stop the line growing with the zoom while its ink keeps scaling.
  host.style.setProperty("--handwriting-note-line-width",`${layout.lineContent}px`);
  host.style.setProperty("--handwriting-note-column-margin-left",layout.left);
  // THE COLUMN'S OWN host-local left, frozen at the scale the viewport was
  // taken over at. Written from `contentOriginLeft` minus the host rect - the
  // read syncCamera already does - so it records where the column ACTUALLY
  // was, whichever element the theme used to put it there. `layout.left`
  // above cannot serve: it reads contentDOM, which under Readable line length
  // carries no margin at all because the editor centres the sizer.
  // Left unset when the column could not be measured, so the stylesheet's
  // fallback keeps the declaration valid and the frame stays centred.
  // Stored RAW and clamped only here: a pane narrower than the line drives it
  // negative, and keeping that lets a later widening recover the exact value
  // instead of starting from a floor.
  // AT REST, A CENTRED COLUMN IS CENTRED BY THIS MARGIN, not by a pan standing on the sizer. A pan at rest costs on every
  // path that assumes none: measured, a scroll frame at 25 percent with Readable line length on ran 4.5 -> 5.9 ms against
  // 1.4.19 while the centring stood as pan. A LIVE FRAME KEEPS THE FROZEN MARGIN - the column is held under the fingers by
  // the pan there, and moving its margin per frame would reflow the sizer under them - so this is the resting frame's
  // own value, recorded in `columnRestMargin` for `columnRestPan` to read, and it is one property write in this batch.
  // THE PAINTED SCROLLBAR, MEASURED ON THE FRAME THAT ASKS. It cannot be predicted from the host-local
  // width: measured CONSTANT at 14.00..15.95 across k 0.100..1.500 in one rig and SCALING at
  // 11.25..44.98 across k 0.600..3.000 in another, with the local width flooring at 15 partway up the
  // second rig's own range. Both regimes are real and both were measured; the mechanism is not chased here.
  // ONE rect, and only on a settle - this function runs on EVERY PREVIEW FRAME (:5598), so an unguarded
  // read here would be a forced layout per frame on the hot path. The guard is production's own: the same
  // `pinchPreview` test the line below already uses to decide whether there is a rest to compute.
  if(!this.pinchPreview){
   const sc=this.view.scrollDOM,r=sc.getBoundingClientRect();
   const st=this.winRef.getComputedStyle(sc);
   const bx=(Number.parseFloat(st.borderLeftWidth)||0)+(Number.parseFloat(st.borderRightWidth)||0);
   const gl=Math.max(0,sc.offsetWidth-sc.clientWidth-bx);
   const gs=sc.offsetWidth>0&&r.width>0?gl*r.width/sc.offsetWidth:0;
   if(Number.isFinite(gs)&&gs>=0)layout.gutterScreen=gs;
  }
  this.columnRestMargin=this.pinchPreview||!layout.sizerColumn?null:this.columnRestCentred(next,layout.externalScale*next);
  // A theme that centres its own lines (ownLines) takes the same frozen inset as a sizer column; the stylesheet
  // applies it to the LINE there (styles.css, the own-lines rule) so the column stops re-centring in the widened host.
  if(layout.columnLocal!==null){
   const margin=`${Math.max(0,this.columnRestMargin??(layout.sizerColumn||layout.ownLines?this.columnMarginLocal(layout)!:0))}px`;
   // A changed margin moves the sizer, so the gutters' counter translate is re-read on the next pan write. Only a
   // change: this runs every preview frame, and the re-read costs a style and layout read.
   if(host.style.getPropertyValue("--handwriting-column-margin-left")!==margin)this.panGuttersMode=null;
   host.style.setProperty("--handwriting-column-margin-left",margin);
  }

  // THE AUTO TERM the frozen column is clamped against, as a number: the
  // scroller's content width at this scale minus the line width, halved.
  // Arithmetic only, from inputs read in an unowned layout (measureColumnAuto),
  // and written in this same batch before anything reads, so a preview frame
  // keeps its one flush. On the zoom host the host is layout.width/next local
  // px wide and the scrollbar keeps its screen size (scrollbar/next local); on
  // the transform host so does Obsidian's styled bar, unscaled below, and any
  // other bar is local like everything else (scrollbarLocalAt). At k = 1
  // both are the engine's own centring, so the freeze stays invisible at 100%.
  // The bar's width goes on the host in the same write as the centring that subtracts it, so the column and the
  // scroller's client box agree on every frame (scrollbarUnscaleAt).
  const unscale=this.scrollbarUnscaleAt(next);
  this.scrollbarUnscale=unscale;
  const unscaleValue=unscale===null?"":String(unscale);
  if(host.style.getPropertyValue("--handwriting-scrollbar-unscale")!==unscaleValue){if(unscale===null)host.style.removeProperty("--handwriting-scrollbar-unscale");else host.style.setProperty("--handwriting-scrollbar-unscale",unscaleValue);}
  if(host.classList.contains("handwriting-scrollbar-unscaled")!==(unscale!==null))host.classList.toggle("handwriting-scrollbar-unscaled",unscale!==null);
  const auto=layout.columnAuto;
  // Under a theme that centres its own lines the auto term never drops below the gutter's reserve: zoomed in, where the
  // line is wider than the column, the line starts where the numbers end instead of under them. At 100% the auto term
  // is the theme's own centring, wider than the reserve wherever the numbers were clear to begin with, so nothing moves.
  const autoLeft=!(layout.sizerColumn||layout.ownLines)?0
   :auto?Math.max(layout.ownLines?this.columnGutterReserve??0:0,(layout.width/next-auto.fixed-this.scrollbarLocalAt(auto.scrollbar,next)-auto.lineWidth)/2)
   :Math.max(0,this.columnMarginLocal(layout)??0);
  const autoValue=`${autoLeft}px`;
  if(host.style.getPropertyValue("--handwriting-column-auto-left")!==autoValue)host.style.setProperty("--handwriting-column-auto-left",autoValue);
  this.writeGutterTravel(next);
  host.style.setProperty("--handwriting-note-column-margin-right",layout.right);
  // THE SHRINK. `zoom` where the engine has it: it is a layout property with
  // no transform node, so the host's effect node never gets the render
  // surface that a scale transform over composited descendants earns - the
  // surface that is redrawn at LAYOUT resolution on every inked frame far
  // out. The counter-sized box is unchanged either way; only the mechanism
  // that shrinks it back moves. A theme's own transform is kept whole (the
  // shrink is no longer folded into it), and the origin only matters while
  // such a transform is there. Anything a previous path left in `transform`
  // is cleared in the same write: a scale under a zoom would shrink twice.
  // The clear runs BOTH ways - the fallback clears a zoom the same way - so
  // neither branch can inherit the other's shrink and land at k squared. The
  // host crosses between them at k = 1 (zoomFormAt), and the crossing frame
  // is written whole by one branch, never by both.
  // The PRODUCT, not `next`: the host's own factor is part of the scale the
  // camera measured, and a bare `next` would drop it. With no zoom of its own
  // the factor is 1 and the written string is what it always was.
  const base=layout.baseTransform!=="none"?layout.baseTransform:"";
  // `zoom: ""` above clears the property outright, which is right for a zoom
  // THIS path wrote and wrong for one the host brought with it INLINE: that
  // declaration is the host's own, and removing it is a shrink taken away from
  // an element the overlay never gave one to - visible even against a
  // competing stylesheet, because the inline one may be the `!important` that
  // wins. Replayed with its priority, exactly as the release replays it, and
  // only when there was one: a host with no inline zoom is left with the
  // property removed, which is what the clear already did.
  const fallback=():void=>{
   this.hostTransformScale=next;
   host.setCssStyles({width:`${layout.width/next}px`,height:`${layout.height/next}px`,zoom:"",transform:this.hostTransform(next),transformOrigin:"0 0"});
   const saved=layout.styles.get("zoom");
   if(saved?.value)host.style.setProperty("zoom",saved.value,saved.priority);
  };
  if(this.zoomFormAt(next)) {
   const want=layout.baseZoom*next;
   this.hostTransformScale=null;this.scrollResidual={x:0,y:0,left:0,top:0};
   host.setCssStyles({width:`${layout.width/next}px`,height:`${layout.height/next}px`,zoom:String(want),transform:base,transformOrigin:base?"0 0":""});
   // THE PRIORITY THE HOST'S OWN DECLARATION HAD. The bulk write above is a
   // camelCase assignment, which cannot carry `!important`: on a host whose
   // own `zoom` was inline AND important it replaces a declaration that was
   // winning the cascade with one that loses to any `!important` sheet rule,
   // so the host lands on the SHEET's factor instead of the product. At a
   // shrink the read-back below catches that; at unity there is no read-back -
   // `baseZoom * 1` asks for nothing, so nothing is certified - and the host
   // would sit demoted until some later frame. Re-writing the product with the
   // saved priority keeps the declaration where it was, and at unity makes the
   // write a restore of exactly what was there.
   // Only when there was an important one to inherit: with no priority to
   // carry, the bulk write above already produced the same declaration, and
   // the shipping host - which has no inline zoom at all - is written the same
   // single call it always was.
   const saved=layout.styles.get("zoom");
   if(saved?.priority)host.style.setProperty("zoom",String(want),saved.priority);
   // DID IT TAKE? A stylesheet `zoom: ... !important` out-specifies an inline
   // write, and the host would keep its full size behind a camera that
   // believes it shrank. One read per TAKEOVER, never per frame, and the
   // fallback form - which out-specifies nothing - is written in the same
   // call so no frame is painted at the wrong size.
   // ONLY a factor that asks the host to move can certify anything. At k = 1
   // the product IS the host's own factor, so the read agrees with the write
   // whether or not the write had any effect - a stylesheet `!important` at
   // that same factor passes it - and certifying there would spend the one
   // read on the one value that cannot fail, leaving the real shrink
   // unverified behind a counter-sized box. The first owned factor off unity
   // does the reading; after it there are no more reads, preview frames
   // included.
   if(layout.zoomVerified!==true&&Math.abs(next-1)>SCALE_EPSILON) {
    layout.zoomVerified=true;
    const got=Number.parseFloat(this.winRef.getComputedStyle(host).zoom);
    // RELATIVE, and wider than the engine's spelling. Chromium serialises the
    // computed zoom to six significant digits, at most 5e-6 of the value off:
    // the first factor of a pinch to 2.5 is sqrt(2.5) = 1.5811388, read back
    // as "1.58114", 1.2e-6 off. An absolute 1e-6 called that a write that did
    // not take and moved the note to the transform form for the life of the
    // overlay. A sheet that holds another factor is off by far more than 1e-5.
    if(Number.isFinite(got)&&Math.abs(got-want)>1e-5*Math.abs(want)){
     this.hostZoomSupport=false;fallback();
     // The five canvases were placed for the zoom form - the plain band box,
     // no transform - and the host has just moved to the other one, where the
     // layer that matters is the band times k stretched back. Left alone they
     // stay full-band compositor layers (five of 19900x22380 on Orion), which
     // is the cost `canvasLayerBox` exists to cap. Re-placed from the cached
     // box and scale: no DOM read, and nothing to do until one exists.
     this.placeCanvasLayers();
    }
   }
  }
  else fallback();
  // A CROSSING OF k = 1 moves the host to the other form, and the five canvases were placed for the one it left (the
  // layer box under a transform below 1, the grids' host flag). Re-placed from the cached box and scale, no DOM read,
  // as the read-back's own fallback does. The first write only records the form.
  const zoomNow=this.zoomFormAt(next);
  if(this.hostZoomWritten!==null&&this.hostZoomWritten!==undefined&&this.hostZoomWritten!==zoomNow)this.placeCanvasLayers();
  this.hostZoomWritten=zoomNow;
  // The pan is stored in PAINTED px and written in the children's own units, so
  // the scale it is divided by has just changed underneath it. Re-stamping here
  // costs two style writes and no read, and is what stops a frame being painted
  // with the previous scale's quotient. The host's own transform above is the
  // scale and, in the transform form, the scroll residual under a host px: the
  // pan is never written here, because this element contains the scroller and
  // moving it takes the hit surface off the pane.
  if(this.panX()!==0||this.panY()!==0)this.writeViewportPan(deferPaper);
  // With no pan, a preview frame still carries the snap's residual out of the paper.
  else if(this.pinchPreview&&(this.paperSnapResidual.x!==0||this.paperSnapResidual.y!==0)){if(deferPaper)this.previewPaperBoxDirty=true;else this.writePaperPan();}
 }

 /**
 * THE LINE NUMBERS TRAVEL WITH THE TEXT WHILE THE PLUGIN HOLDS THE NOTE, at 100% as zoomed. CodeMirror writes
 * `position: sticky` on its fixed gutters, inline, and Obsidian's default theme keeps it: pinned to the pane's left edge
 * when the page scrolls sideways. Zoomed, the preview's offset becomes scrollLeft at the lift and a sticky gutter snapped
 * to the pane's edge, covering scrollLeft x k of every line (162 px at 300% on the rig); a pinch that ends at 1.0, or a
 * drag at 100%, did the same at k 1 (k1). So the host carries handwriting-gutter-travel from mount to unmount, a note switch included, and
 * `:where(.handwriting-gutter-travel .cm-gutters)` makes the gutter `position: relative !important` - the same box in the
 * flow, scrolled with its lines. On the host, a gutter CodeMirror rebuilds inherits it with no write. Zero specificity:
 * a theme that positions the gutter itself (Minimal's `absolute !important`) still wins, and its gutter already scrolls
 * with the text. Class reads only, no layout read.
 */
 const GUTTER_TRAVEL_CLASS="handwriting-gutter-travel";
 function writeGutterTravel(this: InkOverlayPlugin, next:number, release=false):void {
  const host=this.view?.dom;
  if(!host?.classList)return;
  if(release){host.classList.remove(GUTTER_TRAVEL_CLASS);return;}
  if(!host.classList.contains(GUTTER_TRAVEL_CLASS))host.classList.add(GUTTER_TRAVEL_CLASS);
 }

export function installInkOverlayViewportBox(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		restoreViewportLayout,
		prepareViewportLayout,
		scheduleViewportStyleRefresh,
		refreshViewportColumn,
		measureNaturalColumn,
		measureColumnAuto,
		setViewportScroll,
		setScrollResidual,
		hostTransform,
		scrollbarUnscaleAt,
		scrollbarLocalAt,
		placeCanvasLayers,
		applyViewportBox,
		writeGutterTravel,
	});
}
