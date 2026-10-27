/**
 * The note surface's viewport and zoom API: the form the host is in, the note viewport state, the canvas mode, the zoom
 * commands, Fit and the one camera commit. They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads.
 */
import { EditorView } from "@codemirror/view";
import { EditorSelection, StateEffect } from "@codemirror/state";
import { Notice } from "obsidian";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { anchoredScroll, clampToReachable, fitInkBounds, type InkFitBounds, MAX_PINCH_SCALE, MAX_VIEWPORT_LAYOUT } from "./PinchScale";
import { canvasForNote } from "./CanvasNoteOverride";
import { validCameraScale, zoomScalesClientRects } from "./ZoomScale";
import { surfaceExtents, surfaceOriginInScroller } from "./SurfaceExtent";
import { scrollProbeExtent } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { settleAnchorLines } from "./InkOverlayPinch";

/** What the settle has already moved the scroll by for the line under the fingers, per hold, in unscaled px. The settle's
 * ease reads it: that move is the correction, not a jump the ease owes back (InkOverlayPanSettle, anchorPanTo). */
export const settleLineApplied=new WeakMap<object,number>();
import { inlineInk, SCALE_EPSILON, scrollExpansionEnabled, viewportScrollLifetime, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		hostZoomSupported(): boolean;
		zoomFormAt(k:number): boolean;
		noteScrollbarUnscaled(): boolean;
		capturePaperOrigin(originTopInScroller:number, originLeftInScroller:number): void;
		ownsNoteViewport(): boolean;
		noteViewportOwnLines(): boolean;
		getNoteViewportState(): {zoom:number;busy:boolean;fitAvailable:boolean};
		applyCanvasMode(): void;
		endZoomGestureInFlight(): void;
		retryCanvasOffReset(): boolean;
		canvasModeOn(): boolean;
		zoomNoteBy(factor:number): boolean;
		resetNoteZoom(): boolean;
		zoomAroundCenter(next:number): boolean;
		fitHandwriting(): "fit"|"empty"|"busy"|"unrepresentable";
		commitCameraScale(next:number, scroll?:{left:number;top:number}, settleHold?:object|null, preserveScrollDemand?: boolean, bypassFloor?: boolean, restore?: boolean): boolean;
		payCommitRepaint(): void;
	}
}

 /**
  * Does this engine have standard CSS `zoom`? Chromium 128+ and WebKit 17.4+
  * do; older mobile WebKit does not, and there the host keeps the scale
  * transform it has always had, byte for byte.
  *
  * Asked ONCE and cached: `applyViewportBox` runs per pinch-preview frame,
  * and a feature query per frame is a parse per frame. The answer cannot
  * change for the life of a window.
  */
 function hostZoomSupported(this: InkOverlayPlugin):boolean {
  // `typeof`, not `=== null`: a class field initialiser does not run for an
  // object made with `Object.create`, which is how the unit rigs build one.
  if(typeof this.hostZoomSupport!=="boolean") {
   const css=(this.winRef as unknown as {CSS?:{supports?:(property:string,value:string)=>boolean}}).CSS;
   const supported=css?.supports?.("zoom","0.5")===true;
   // An engine whose rects ignore CSS zoom takes the transform path. No answer
   // keeps the feature query's for this overlay; the window is not marked, so
   // the next overlay asks again.
   const scaled=supported?zoomScalesClientRects(this.winRef):null;
   this.hostZoomSupport=scaled===null?supported:scaled;
  }
  return this.hostZoomSupport;
 }

 /**
  * THE FORM THE HOST IS IN at the camera's own factor `k`, one rule on every platform. Above 1 the transform form:
  * the zoom form lays the text out again at the zoomed font size with whole-px glyph metrics, and the glyphs move
  * against the ink, which scales exactly (0.54 CSS px at 1.79 on a 1.8257 display; the transform form keeps both
  * within 0.05 note px). At or below 1 the zoom form, where the engine has it. Before this the form above 1 hung on
  * the read-back's spelling of the gesture's first factor: random per gesture on Blink, desktop and mobile alike.
  * Every reader that asks which form is on the host asks here, at the same k the box write used.
  */
 function zoomFormAt(this: InkOverlayPlugin, k:number):boolean {
  return this.hostZoomSupported()&&!(k>1+SCALE_EPSILON);
 }

 /** Whether the host carries `handwriting-scrollbar-unscaled`, asked by the `editorAttributes` facet for the reason `noteViewportOwnLines` gives. */
 function noteScrollbarUnscaled(this: InkOverlayPlugin):boolean {return this.viewportLayout!==null&&this.scrollbarUnscale!==null;}

 /**
  * The note origin the paper's phase is planned from, in the gradient's own
  * layout px, from the origin updateExtent has just computed. Re-plans only when
  * it really moved. The origin does not move in layout px while the note zooms
  * or scrolls, but it is read through rects, whose positions the engine stores
  * to 1/64 screen px: at 10 percent that is a sixth of a layout px, and a
  * compare on the raw number re-planned the phase on zoom commits and scrolled
  * frames where nothing moved. A move under 1/32 screen px is not one.
  */
 function capturePaperOrigin(this: InkOverlayPlugin, originTopInScroller:number,originLeftInScroller:number):void {
  // Never on a preview frame: the paper follows a preview through its pan, rewrap and column shifts, which this
  // re-measure would otherwise count a second time.
  if(this.pinchPreview)return;
  // surfaceOriginInScroller measures from the scroller's border box; the
  // gradient's positioning area starts at its padding box, clientTop lower and clientLeft to the right.
  // Read in the layout updateExtent has just flushed, before any write.
  const top=originTopInScroller-this.view.scrollDOM.clientTop;
  const left=originLeftInScroller-this.view.scrollDOM.clientLeft;
  const scale=Number.isFinite(this.cssScale)&&this.cssScale>0?this.cssScale:1;
  // A move under 1/32 screen px is not one: rect positions are stored to 1/64 screen px.
  const moved=(now:number,previous:number|null)=>Number.isFinite(now)&&(previous===null||Math.abs(now-previous)>=1/32/scale);
  const topMoved=moved(top,this.paperOriginLayout),leftMoved=moved(left,this.paperOriginLeft);
  if(topMoved)this.paperOriginLayout=top;
  if(leftMoved)this.paperOriginLeft=left;
  if(topMoved||leftMoved)this.updatePaperSpacing();
  // The phases now carry the origin a title rewrap or a column re-centring moved, so the paper's own shifts are spent,
  // in the same block as the re-plan.
  if(this.paperRewrapY!==0||this.paperColumnDrift!==0){this.paperRewrapY=0;this.paperColumnDrift=0;this.writePaperPan();}
 }

 // CodeMirror owns the root class attribute and rewrites it on focus changes.
 // Its facet must agree with our synchronous camera writes, including while a
 // stroke owns the frame. Reading the DOM class here would retain its loss.
 function ownsNoteViewport(this: InkOverlayPlugin):boolean {return this.viewportLayout!==null;}
 /**
  * DOES THE OWNED HOST CARRY THE OWN-LINES TOKEN, asked by the same `editorAttributes` facet that asserts
  * `handwriting-note-viewport`. It has to be asked there and not only written in `applyViewportBox`, because
  * CodeMirror REWRITES the host's whole `class` attribute from that facet on every `updateAttrs`: a token the overlay
  * only adds imperatively survives exactly until the next view update. Measured on the zoom button at 50 percent under
  * Minimal: `applyViewportBox` ran once, added the token (traced), and CodeMirror's next `updateAttrs` set
  * `class="cm-editor ... handwriting-note-viewport"` over it - the freeze came back on and the column stayed 345.5 px
  * off its centred rest. A pinch hid it, because its preview re-runs the box write every frame and the last one lands
  * after the update. The imperative write below stays: it makes the token right WITHIN the frame that computes it,
  * before any update, and this keeps it right across every update after.
  */
 function noteViewportOwnLines(this: InkOverlayPlugin):boolean {return this.viewportLayout?.ownLines===true;}

 function getNoteViewportState(this: InkOverlayPlugin):{zoom:number;busy:boolean;fitAvailable:boolean} {
  const path=this.filePath();
  // No note zoom of any kind with the canvas off: the bar, its buttons, Fit and the zoom
  // commands all read `busy` and stand down together.
  const busy=!this.container || !path || !inlineInk.isLoaded(path) || inlineInk.deleteAllReadiness(path).kind==="unsettled" || this.frame.locked || this.builder!==null || this.mode!=="ink" || !this.canvasMode;
  return {zoom:this.pinchScaleNow,busy,fitAvailable:!busy&&this.scaleGeometryValid!==false};
 }

 /**
  * RE-READ THIS NOTE'S CANVAS ANSWER AND APPLY IT. Called by the global setter for every
  * mounted note, by the frontmatter override when this note's choice moves, and by the host after a
  * toggle. Off: the wheel zoom run ends, momentum follows the mode, and a zoomed note lands at 100
  * percent about the pane centre through the ordinary commit (no saved zoom exists to keep: a note's
  * scale lives only while it is mounted, so canvas on again simply starts from 100 percent).
  */
 function applyCanvasMode(this: InkOverlayPlugin):void {
  const path=this.filePath();
  const on=canvasForNote(path,scrollExpansionEnabled);
  const was=this.canvasMode;
  // A zoom gesture in flight ends while the canvas is still on: once it is off, pinch() drops every phase, the end
  // included, and a preview left up then stays up with the note reading busy. The ctrl+wheel run ends on its own
  // anchor; a two-finger pinch, or a lift's give still easing back, ends here where it stands. The global setter
  // ends every wheel run before it calls this; the per-note path (a frontmatter change) did not.
  if(!on) this.endZoomGestureInFlight();
  this.canvasMode=on;
  this.router?.setCanvasMomentumDisabled(on);
  this.canvasOffResetPending=false;
  if(!on){
   // The room the canvas granted sideways is no longer asked for: owe the shrink for THIS note, the way
   // the global setter owes it for every note.
   if(was&&path) surfaceExtents.oweShrinkX(path);
   // The one reset can be refused (a hidden tab has no box, a stroke owns the frame). Keep it pending and
   // retry at pen-up and when the geometry comes back, so the note never stays zoomed with every zoom
   // control dead.
   if(this.pinchScaleNow!==1) this.canvasOffResetPending=true;
   this.retryCanvasOffReset();
  }
  if(was!==on) this.scheduleRepaint("canvas-mode");
 }
 /** End a wheel run, a two-finger pinch or an easing give where it stands; see applyCanvasMode. */
 function endZoomGestureInFlight(this: InkOverlayPlugin):void {
  // Read through `?.` and `??`: a unit rig built with Object.create never runs the initialisers.
  if(this.wheelZoomRun?.isLive){this.endWheelZoomRun();return;}
  if((this.pinchRefScale??null)===null&&!this.pinchGive) return;
  const anchor=this.pinchAnchor,constraint=anchor?.constraint;
  const at={x:constraint?.clientX??anchor?.targetX??anchor?.focalX??Number.NaN,y:constraint?.clientY??anchor?.targetY??anchor?.focalY??Number.NaN};
  this.pinch("end",1,at);
 }
 /** True when the pending reset committed now. */
 function retryCanvasOffReset(this: InkOverlayPlugin):boolean {
  if(!this.canvasOffResetPending) return false;
  if(this.canvasMode||this.pinchScaleNow===1){this.canvasOffResetPending=false;return false;}
  if(!this.container||this.frame.locked||this.builder!==null) return false;
  if(!this.zoomAroundCenter(1)) return false;
  this.canvasOffResetPending=false;
  return true;
 }
 /** Read-only, for the zoom bar and the tests. */
 function canvasModeOn(this: InkOverlayPlugin):boolean { return this.canvasMode; }
 function zoomNoteBy(this: InkOverlayPlugin, factor:number):boolean {
  if(this.getNoteViewportState().busy||!Number.isFinite(factor)||factor<=0) return false;
  // Below the floor the lower bound is the current scale: minus is a no-op
  // there, never a jump in to the floor.
  const next=Math.max(Math.min(this.zoomFloor,this.pinchScaleNow),Math.min(MAX_PINCH_SCALE,this.pinchScaleNow*factor));
  return next===this.pinchScaleNow || this.zoomAroundCenter(next);
 }
 function resetNoteZoom(this: InkOverlayPlugin):boolean {
  // With the canvas off every zoom control is busy, but a note still left zoomed must be resettable.
  if(!this.canvasMode&&this.pinchScaleNow!==1&&!this.frame.locked&&this.builder===null) return this.zoomAroundCenter(1);
  return !this.getNoteViewportState().busy && this.zoomAroundCenter(1);
 }
 function zoomAroundCenter(this: InkOverlayPlugin, next:number):boolean {
  const scroller=this.view.scrollDOM,rect=scroller.getBoundingClientRect();
  const external=this.cssScale/this.pinchScaleNow;
  // The left target is handed over UNCLAMPED: the column-margin debt this commit books is paid against the true anchor,
  // and only then clamped to the range. Clamping first dropped the part below 0 and paid the whole debt on top of it.
  const left=scroller.scrollLeft+(rect.width/2)*(1/this.cssScale-1/(next*external));
  return this.commitCameraScale(next,{left:Number.isFinite(left)?left:0,top:anchoredScroll(scroller.scrollTop,rect.height/2,this.cssScale,next*external)});
 }

 function fitHandwriting(this: InkOverlayPlugin):"fit"|"empty"|"busy"|"unrepresentable" {
  if(this.getNoteViewportState().busy) return "busy";
  const refuse=()=>{new Notice("Handwriting: this ink cannot fit in the current view.");return "unrepresentable" as const;};
  const path=this.filePath()!;
  const scroller=this.view.scrollDOM,rect=scroller.getBoundingClientRect();
  const external=this.viewportLayout?.externalScale??this.cssScale/this.pinchScaleNow;
  const screenWidth=this.viewportLayout?this.viewportLayout.width*external:rect.width;
  const screenHeight=this.viewportLayout?this.viewportLayout.height*external:rect.height;
  // The surface grows right and bottom only, so ink above or left of the origin
  // cannot be scrolled to. Frame the reachable part instead of refusing the whole
  // note: one stroke above the first line used to disable Fit forever.
  //
  // Clip EACH stroke before the union, not the finished union. A stroke that is
  // wholly unreachable must contribute nothing at all; clamping afterwards lets
  // its other dimension still drag the union outward, so Fit zooms away to
  // accommodate ink it can never display.
  const origin=surfaceOriginInScroller({contentLeftVisual:this.columnLeft(),documentTopVisual:this.documentTopUnpanned(),scrollRectLeft:rect.left,scrollRectTop:rect.top,scrollLeft:scroller.scrollLeft,scrollTop:scroller.scrollTop,scale:this.cssScale});
  const f=Number.isFinite(this.fontZoom)&&this.fontZoom>0?this.fontZoom:1;
  const reach={originLeftNote:-origin.left/f,originTopNote:-origin.top/f};
  let bounds:InkFitBounds|null=null,sawStroke=false;
  for(const stroke of this.noteStrokes(path)) {
   // Loaded and freshly built bboxes already include width*2 allowance.
   const b=stroke.bbox;
   if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<0||b.height<0) return refuse();
   sawStroke=true;
   const clipped=clampToReachable({x:b.x,y:b.y,width:b.width,height:b.height},reach);
   if(!clipped) continue;
   const right=clipped.x+clipped.width,bottom=clipped.y+clipped.height;
   if(!bounds) bounds={x:clipped.x,y:clipped.y,width:clipped.width,height:clipped.height};
   else {const endX=Math.max(bounds.x+bounds.width,right),endY=Math.max(bounds.y+bounds.height,bottom);bounds.x=Math.min(bounds.x,clipped.x);bounds.y=Math.min(bounds.y,clipped.y);bounds.width=endX-bounds.x;bounds.height=endY-bounds.y;}
  }
  // Strokes exist but not one of them is reachable: the only remaining refusal.
  // No strokes at all stays "empty", which resets to 100% rather than refusing.
  if(sawStroke&&!bounds) return refuse();
  const plan=fitInkBounds({bounds,viewportWidthScreen:screenWidth,viewportHeightScreen:screenHeight,externalScale:external,fontZoom:this.fontZoom,marginScreen:24});
  if(plan.kind==="unrepresentable") return refuse();
  if(!bounds) return this.commitCameraScale(1,{left:0,top:0})?"empty":refuse();
  const scale=external*plan.zoom;
  // `f`, not raw fontZoom: the same guarded value the reachable region above
  // was built from, so a stroke placed with it lands exactly where the
  // reachability test thought it was. (Today the two never actually differ -
  // fitInkBounds already refused above whenever fontZoom fails the same
  // finite/>0 test that makes f fall back - but that agreement is worth
  // keeping explicit rather than relying on a guard two calls away.)
  const left=Math.max(0,origin.left+(bounds.x+bounds.width/2)*f-screenWidth/scale/2);
  const top=Math.max(0,origin.top+(bounds.y+bounds.height/2)*f-screenHeight/scale/2);
  // Fit alone passes bypassFloor: it may commit below the manual floor.
  return this.commitCameraScale(plan.zoom,{left,top},undefined,false,true)?"fit":refuse();
 }

 /**
  * One validated transaction owns layout, transform, native range and scroll. `restore` is a remembered camera put back
  * as it was saved (restoreNoteCamera alone passes it): its scroll is absolute, taken with the column already at its
  * margin for that zoom, so no margin debt is booked or paid.
  */
 function commitCameraScale(this: InkOverlayPlugin, next:number,scroll?:{left:number;top:number},settleHold?:object|null,preserveScrollDemand=false,bypassFloor=false,restore=false):boolean {
  this.commitDepth=(this.commitDepth||0)+1;
  try {
	this.restorePinchLayers();
  // A SAME-SCALE RE-COMMIT CARRIES A PENDING SETTLE. A refresh after a theme or
  // column change, or a resize, re-commits in place with no settle of its own
  // and no scroll target; retiring the pinch's pending hold there cancelled a
  // settle nothing had superseded. The hold is carried to this commit and
  // re-anchored under the refreshed geometry. A new scale or an explicit scroll
  // target is new navigation and still retires it.
  const pendingHold=this.panAnchorHold;
  // NOT inside another commit: a commit nested in a commit's own synchronous
  // work (its resize, extent, band) or in its settle measure's write would be a
  // second consumer of the same hold before it converged, which failed the
  // settle. It retires, named. This call's own entry is depth 1.
  // NOR inside CodeMirror's own update: the carried settle dispatches its scroll
  // request, and a dispatch during the update throws, which makes CodeMirror
  // deactivate this plugin (a font reflow's resize, with the pane not yet
  // delivered, reaches here from updateInner).
  const nested=this.commitDepth>1;
  const carry=!nested&&!this.inUpdate&&settleHold===undefined&&scroll===undefined&&!!pendingHold&&pendingHold.outcome==="pending"&&next===this.pinchScaleNow;
  if(carry)settleHold=pendingHold;
  else if(this.panAnchorHold!==settleHold)this.retirePanSettle(nested?"nested":this.inUpdate?"inside CodeMirror's update":settleHold===undefined?"a commit at a new scale or scroll":"another settle");
  // A commit that ends a live preview (a zoom button, Fit) takes its paper down; the settle's own commit leaves that to the settle.
  if(!this.previewPaperSettling)this.endPreviewPaper("commit");
  this.pinchPreview=false;
  this.releaseMeasures();
  // Below the floor only a scale at or above the reference commits: the
  // gesture's start while a pinch settles (its previews already wrote
  // pinchScaleNow), else the current scale, so a re-commit in place passes.
  if(this.frame.locked||this.scaleGeometryValid===false||(!bypassFloor&&next<this.zoomFloor&&!(next>=(this.pinchRefScale??this.pinchScaleNow)))||next>MAX_PINCH_SCALE||!validCameraScale(next,this.view.dom.clientWidth,this.view.dom.clientHeight))return false;
  const previous=this.pinchScaleNow,effective=this.cssScale/previous*next;
  if(!validCameraScale(effective)||!this.prepareViewportLayout())return false;
  const layout=this.viewportLayout!;
  const width=layout.width/next,height=layout.height/next;
  const target=scroll?{left:scroll.left,top:scroll.top}:{left:this.view.scrollDOM.scrollLeft,top:this.view.scrollDOM.scrollTop};
  // A target below 0 on x is an anchor the range cannot hold; what is below 0 is kept for the margin debt, below.
  const underflowLeft=Math.min(0,target.left);target.left=Math.max(0,target.left);
  // An explicit navigation that is NOT a pinch settle - Fit, the zoom buttons,
  // reset - computes its own absolute scroll and expects the note square on its
  // origin. Leaving a previous gesture's residual pan in place would displace
  // every one of those targets by it.
  if(scroll&&!this.panAnchorHold&&(this.panX()!==0||this.panY()!==0))this.clearViewportPan();
  if(![width,height,target.left,target.top].every(n=>Number.isFinite(n)&&n>=0&&n<=MAX_VIEWPORT_LAYOUT)||width===0||height===0)return false;
  if(next!==previous)this.router?.cameraTransformChanged();
  const generation=++this.viewportGeneration,path=this.filePath();
  this.reloadCameraSettlement=generation;
  const settled=()=>{if(this.reloadCameraSettlement===generation)this.reloadCameraSettlement=null;};
  // The carried hold belongs to this commit now; the commit that issued it sees
  // the newer generation on the hold and stands down without cancelling it.
  if(carry&&pendingHold&&this.panAnchorHold===pendingHold)pendingHold.generation=generation;
  const hold=this.panAnchorHold, container=this.container;
  const owns=()=>generation===this.viewportGeneration&&path===this.filePath()&&container===this.container&&!!container&&!this.retiring&&!this.frame.locked&&(!hold||this.ownsPanSettle(hold));
  const matchesScroll=()=>!hold||(this.view.scrollDOM.scrollLeft===hold.left&&this.view.scrollDOM.scrollTop===hold.top);
  const finish=()=>{settled();if(hold&&hold.generation===generation){if(hold.outcome==="pending")hold.outcome="cancelled";if(this.panAnchorHold===hold)this.retirePanSettle("its settle measure lost ownership or the scroll moved");}};
  // The first commit on a fresh editor has no resting margin to measure the debt from: the baseline is the margin the
  // page is showing now, at the scale it is leaving.
  // What the page is showing is read off the painted column, before this commit writes anything; the law at the scale
  // being left stands in where nothing can be read.
  const shownMargin=layout.columnLocal!==null&&!this.pinchPreview?this.paintedColumnMargin():null;
  if(this.restingColumnMargin===null&&layout.columnLocal!==null&&!this.pinchPreview)this.restingColumnMargin=shownMargin??this.appliedColumnMargin(previous);
  this.pinchScaleNow=next;this.cssScale=effective;this.scale=effective*this.fontZoom;
  // At the new zoom the pitch plans the same; the thickness can change and the phase moves onto the new device px grid.
  this.updatePaperSpacing();
  this.refreshPenCursor();
  this.applyViewportBox(next);
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,preserveScrollDemand);
  // The extent pass below releases the band's margin on this commit, not only when a grant shrank.
  this.bandMarginReleasePending=true;
  // THE BAND IS RE-PINNED TO THE SETTLED VIEWPORT FIRST. Its margin is headroom for a fling, sized for the viewport it
  // was pinned in; a zoom-out pins it for the counter-sized one and a settle back at 100 percent used to leave that
  // margin holding scrollable range nothing had granted - measured on a blank note, 100 -> 25 -> 100: rangeX 175 and the
  // view parked at scrollLeft 160 with Readable line length on, 175/175 with it off, against 0/0 on a note that never
  // moved, with the extent's own grant 0 throughout. Re-pinned here, before the extent, the scroll target and the fit
  // test, the settle lands where a fresh note sits.
  this.handleResize();if(this.syncBand()!=="none")this.handleResize();this.updateExtent(true,hold?.expansion??undefined);
  // THE REST THE EXTENT JUST INVALIDATED. `handleResize` above writes the centring margin from the granted extent as
  // it stood; `updateExtent` then grants more room, so that margin is already stale by the end of this same commit and
  // the NEXT commit of any kind withdraws it. Measured: the page moves 536.70 px on a bare commit at the same scale
  // with no gesture behind it at all, which is why it snaps "no matter what" rather than only at a lift.
  //
  // Recomputed here against the grant this commit just made, BEFORE the frame is presented, so no stale margin is ever
  // carried out of a commit and there is usually nothing left to pay. What the page was actually showing - the last
  // commit's final margin - is what the debt below is measured against.
  this.restColumnAgainstCurrentGrant(next,effective,shownMargin,!restore);
  // THE PAGE BOX INSIDE THE PANE, folded into this commit's own scroll target once the box and the extent are
  // written, because it is read off both. Written back onto `target` deliberately: this commit has four scroll
  // writes (here, the settle measure's re-anchor, and the two convergence retries) and they all write the same
  // target, so a correction applied to one alone would be handed straight back by the next.
  target.left=this.ownLinesPageBoxScrollLeft(next,effective,target.left);
  // A restore's scroll already holds the margin it was saved at: the debt a gesture owes is not owed here.
  if(!restore)target.left=Math.max(0,this.columnMarginDebtScrollLeft(effective,target.left+underflowLeft));
  // A FITTING COLUMN SETTLES ON ITS REST, AND THE REST IS NOT A SCROLL - the same law the pinch settle
  // already takes one screen up, on the same predicate and with no new term. Where `columnRestPan` is
  // non-null the column has an inset to rest in and the page fits the pane, and the margin this commit
  // just wrote IS that rest; a scroll standing from before the commit then displaces the page by its
  // whole width. Measured on Fit with ink wider than the page, Readable line length on, at k 0.2192:
  // the margin was the rest to the last digit (41.07033029241483) while scrollLeft stood at 301.03, and
  // the column landed at 243.00 against a pane edge of 300 - 57 px of it off the screen, with the ink's
  // left edge off with it. Zeroing the scroll puts it at 309.00, which is where centring wants it.
  // NOT carried as pan: a fitting page left panned by a stale scroll is the standing-pan class that was
  // already closed elsewhere, and the rest belongs in the margin, which now holds it.
  // The fit predicate itself, now that there is no centred rest to stand in for it.
  if (this.columnFitsPane(next, effective)) target.left = 0;
  // ONE SYNC, AFTER THE PAN WRITE. reanchorPan decides the settle's ease and starts it; the sync below then re-pins
  // the band to the committed scroll and widens it by the ease on the side the ease uncovers (syncBand), one bake.
  this.setViewportScroll(target.left,target.top);if(diagnosticsEnabled())scrollProbeExtent(`settle scroll target ${target.left.toFixed(2)},${target.top.toFixed(2)} actual ${this.view.scrollDOM.scrollLeft.toFixed(2)},${this.view.scrollDOM.scrollTop.toFixed(2)}`);this.reanchorPan();if(hold&&diagnosticsEnabled())this.traceSettlePaper("measure commit");
  // The target scroll can leave the old raster band, especially on zoom-out.
  // Finish its coverage before the router can map and lock the next pen down.
  if(this.syncBand()!=="none")this.handleResize();
  // The one whole repaint this commit's reallocations left owed (handleResize), after the last of them.
  this.payCommitRepaint();
  const settledLeft=this.view.scrollDOM.scrollLeft,settledTop=this.view.scrollDOM.scrollTop;
  if(hold && this.firstSettleConsumer()) {
   // Use a real currently visible document position. Issue separately from
   // edits: CM clips an incoming effect against the existing document.
   const range=this.ownScrollRange(EditorSelection.cursor(this.view.viewport.from),hold);
   if(!range){finish();return false;}
   const request=EditorView.scrollIntoView(range,{x:"nearest",y:"nearest"});
   hold.request=request;
   const lifetime=viewportScrollLifetime(this.view);
   lifetime.pending=hold;
   // Append the cancellation extension only when this editor lacks it: every
   // zoom lift came through here and appended it again, and each append
   // re-resolves the editor's whole configuration.
   const effects=lifetime.installed(this.view.state)?[request]:[request,StateEffect.appendConfig.of(lifetime.extension)];
   hold.issuance=effects;
   const geometry=()=>[this.panX(),this.panY(),this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,this.view.scrollDOM.scrollWidth,this.view.scrollDOM.scrollHeight,this.view.contentHeight,this.view.viewport.from,this.view.viewport.to];
   const measure={key:this,read:()=>owns()&&matchesScroll()?geometry():null,write:(before:number[]|null)=>{
    if(!before||!owns()||!matchesScroll()){finish();return;}
    // The hold's own consumer re-anchoring: a commit its resize triggers is nested
    // too. Load-bearing: this write runs inside CodeMirror's measure (its update
    // phase), where a carried commit's dispatch would throw; do not remove.
    this.commitDepth=(this.commitDepth||0)+1;
    try{this.handleResize();this.updateExtent(true,hold?.expansion??undefined);
    // THE LINE UNDER THE FINGERS, READ AGAIN AFTER THE REBUILD. CodeMirror rebuilt its height map at the new scale in its own
    // measure, before this write, and the blocks it has not drawn took a one-line estimate: the lines above the fingers
    // changed height and the target, computed from the takeover geometry, puts the line elsewhere. Measured on the round-trip
    // cell: the last line moved 926.44 px at a 600 percent lift. One height-map read per attempt of this hold (at most four
    // per lift, no layout): the scroll a correction writes brings other blocks into CodeMirror's drawn range, whose measure
    // changes the heights again, so each attempt takes what the line has moved since the takeover less what is already
    // applied. The scroll moves by it and the pan's anchor with it, so the pan holds the same line. A line CodeMirror has not
    // drawn keeps the target as it stands.
    // ONLY A COMMIT THAT CHANGED THE SCALE. CodeMirror rebuilds its height map only on a scale change, so a drag or a same-scale
    // commit owes no correction; reading one there takes the gap between the painted scale and CodeMirror's own scaleY belief
    // for a move (measured at zoom 0.1: 0.184 px on a plain drag, which left a pan residual that changed the next lift).
    const fingerLine=hold.toScale!==hold.fromScale?settleAnchorLines.get(hold):undefined;
    // THE RESIDUE BAND. The painted top is divided by the painted scale and the block's by CodeMirror's scaleY; the two scales differ
    // by rounding after a rebuild, and by up to 0.005 when the commit stayed under CodeMirror's refresh threshold and nothing was
    // rebuilt. A move no larger than the line's top times that gap (plus 1/16 px) is that gap, not the line moving: it is left
    // alone. The painted top read at the takeover also rounds to the device pixel: half a device pixel at that paint scale is
    // added. A larger move is applied whole. Both scales of the gap are read here, at the write.
    if(fingerLine){{const scaleY=this.view.scaleY||1,moved=this.view.lineBlockAt(fingerLine.pos).top/scaleY-fingerLine.top-(settleLineApplied.get(hold)??0);
    const pixel=fingerLine.dpr>0&&fingerLine.paintScale>0?.5/(fingerLine.dpr*fingerLine.paintScale):0,band=(Number.isFinite(this.cssScale)&&this.cssScale>0?Math.abs(fingerLine.top)*Math.abs(scaleY/this.cssScale-1):0)+pixel+1/16;
    if(Number.isFinite(moved)&&Math.abs(moved)>band){target.top=Math.max(0,Math.min(MAX_VIEWPORT_LAYOUT,target.top+moved));if(hold.contentTopLocal!==null)hold.contentTopLocal-=moved;settleLineApplied.set(hold,(settleLineApplied.get(hold)??0)+moved);}}}
    this.setViewportScroll(target.left,target.top);if(diagnosticsEnabled())scrollProbeExtent(`settle scroll target ${target.left.toFixed(2)},${target.top.toFixed(2)} actual ${this.view.scrollDOM.scrollLeft.toFixed(2)},${this.view.scrollDOM.scrollTop.toFixed(2)}`);this.reanchorPan();if(diagnosticsEnabled())this.traceSettlePaper(`measure attempt ${hold.attempts+1}`);
    // Paid in the finally: a throw after handleResize would otherwise leave the owed flag set and the layer blank.
    if(this.syncBand()!=="none")this.handleResize();}finally{this.commitDepth--;this.payCommitRepaint();}
    // Partial: whatever the steps above damaged, and the repaint plan's own camera test, decide the work. A whole-world ask here
    // repainted every stroke a third time with the camera unchanged.
    this.scheduleRepaint("partial");
    const after=geometry();
    hold.ready=after.every((value,index)=>value===before[index]);
    // Pending measurements keep CM's explicit target ahead of auto-anchoring
    // until a full readback needs no further geometry correction.
    if(!hold.ready) {
     // Bound failure by attempted corrections, never declare convergence
     // merely because time or frames passed. Leave the canceled receipt
     // recognizable so draining it cannot perform default scrolling.
     if(++hold.attempts>=4){hold.outcome="failed";console.warn("Pinch geometry did not converge");finish();}
     else this.view.requestMeasure(measure);
    } else {
     // Load-bearing: nothing else calls finish() on this path. Without this,
     // the reload gate this commit opened above never closes after a
     // converged pinch settle.
     settled();
    }
   }};
   this.view.requestMeasure(measure);
   this.view.dispatch({effects,filter:false});
  } else if(hold) {
   finish();
  } else {
  this.view.requestMeasure({key:this,read:()=>{
   const valid=owns()&&matchesScroll()&&(!!hold||(this.view.scrollDOM.scrollLeft===settledLeft&&this.view.scrollDOM.scrollTop===settledTop));

   return valid;
  },write:valid=>{
   if(!valid||!owns()||!matchesScroll()){finish();return;}
   this.handleResize();this.updateExtent(true);this.setViewportScroll(target.left,target.top);this.reanchorPan();
   if(this.syncBand()!=="none")this.handleResize();
   this.payCommitRepaint();
   this.scheduleRepaint("partial");
   const complete=()=>{
    if(!owns()){finish();return;}
    this.setViewportScroll(target.left,target.top);this.reanchorPan();
    this.updateExtent(true);this.reanchorPan();
    if(this.syncBand()!=="none")this.handleResize();
    this.payCommitRepaint();
    this.scheduleRepaint("partial");
    finish();
   };
   // Generic camera navigation keeps its existing guarded follow-up.
   // Pinch settlement completes through the owned consumer above.
   queueMicrotask(()=>{
    if(!owns()||!matchesScroll()){finish();return;}
    complete();
   });
  }});
  }
  this.mobileTools?.refresh();
  this.noteZoomControls?.refresh();
  return true;
  } finally {
   this.commitDepth--;
   // A commit that returned after a reallocation, before its own payment, still pays: the layers must not be left blank.
   if(this.commitDepth===0)this.payCommitRepaint();
  }
 }

 /**
  * Pay the whole repaint a camera commit's reallocations left owed, once, in the caller's task: what handleResize itself did before
  * the commit took it over (a synchronous repaint, or the queued frame's while a stroke is being built or another tool is active).
  */
 function payCommitRepaint(this: InkOverlayPlugin):void {
  if(!this.commitRepaintOwed)return;
  this.commitRepaintOwed=false;
  if(this.builder===null&&this.mode==="ink")this.repaint();
  else this.scheduleRepaint("resize");
 }

export function installZoomApi(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		hostZoomSupported,
		zoomFormAt,
		noteScrollbarUnscaled,
		capturePaperOrigin,
		ownsNoteViewport,
		noteViewportOwnLines,
		getNoteViewportState,
		applyCanvasMode,
		endZoomGestureInFlight,
		retryCanvasOffReset,
		canvasModeOn,
		zoomNoteBy,
		resetNoteZoom,
		zoomAroundCenter,
		fitHandwriting,
		commitCameraScale,
		payCommitRepaint,
	});
}
