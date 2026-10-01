import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { captureInlinePenTrace } from "../../src/inline/InlinePenRouter";
import { setPenInk } from "../../src/inline/PenInk";
import { setKeyboardFocus } from "../../src/inline/InlineFocus";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
installObsidianDom();
inlineInk.attachHost({readPageId:()=>"existing-page",claimId:async()=>({pageId:"existing-page"}),loadSidecar:async()=>null,scheduleSidecar:()=>{},scheduleSidecarNow:async()=>{},notify:()=>{}});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));};
let view:EditorView,path:string,button:HTMLButtonElement;
const focusLog:string[]=[];
const inputMode=()=>view.contentDOM.getAttribute("inputmode");
const snap=()=>({inputMode:inputMode(),top:view.scrollDOM.scrollTop,head:view.state.selection.main.head,focused:view.hasFocus,active:document.activeElement===button?"button":document.activeElement===view.contentDOM?"editor":document.activeElement?.tagName??"none",strokes:inlineInk.strokes(path).length,focusLog:[...focusLog]});
/**
 * A note whose caret sits at the top of a long document, scrolled well past it,
 * with a button outside the editor like the one a page-scroll plugin puts on
 * the page body.
 */
async function setup(){
	setDiagnosticsEnabled(true);
	path="pen-tap-focus.md";
	const host=document.body.appendChild(document.createElement("div"));host.className="markdown-source-view";host.style.cssText="width:640px;height:480px;overflow:hidden;position:relative";
	const doc=Array.from({length:300},(_,i)=>`${i} ${"some text ".repeat(12)}`).join("\n");
	view=new EditorView({parent:host,state:EditorState.create({doc,selection:{anchor:0},extensions:[editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{width:"640px",height:"480px"},".cm-scroller":{overflow:"auto"},".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
	button=document.body.appendChild(document.createElement("button"));
	button.textContent="down";button.style.cssText="position:absolute;left:660px;top:40px;width:30px;height:30px";
	button.onclick=()=>view.scrollDOM.scrollBy(0,view.scrollDOM.clientHeight-60);
	view.contentDOM.addEventListener("focus",()=>focusLog.push(`focus top=${view.scrollDOM.scrollTop} inputmode=${inputMode()}`));
	view.contentDOM.addEventListener("blur",()=>focusLog.push(`blur top=${view.scrollDOM.scrollTop}`));
	await settle();view.focus();await settle();
	if(!overlayForPath(path))throw Error("missing real overlay");
	view.scrollDOM.scrollTop=2400;await settle();
	setPenInk(true);focusLog.length=0;
	return snap();
}
/** The pen-off button's keyboard request, through the same helper the strip calls. */
async function askForKeyboard(){setKeyboardFocus(view,true);await settle();return snap();}
/** CodeMirror rewrites the content element's attributes when its attribute facet changes. */
async function syncAttributes(){view.dispatch({effects:StateEffect.appendConfig.of(EditorView.contentAttributes.of({"data-probe":"1"}))});await settle();return snap();}
(window as any).penTapFocus={setup,snap,settle,askForKeyboard,syncAttributes,capture:()=>captureInlinePenTrace({})};
