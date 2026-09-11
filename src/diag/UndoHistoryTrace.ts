import { timerHost, animationHost } from "../util/RuntimeScheduler";
import { diagnosticsEnabled, diagnosticsEpoch } from "./DiagSwitch";

export type UndoGesture = "undo" | "redo";
export type UndoPhase = "pre" | "keydown" | "transaction" | "post";
export type UndoTraceStatus = "not-recorded" | "armed-no-key" | "captured" | "discarded";
export type UndoEndReason =
	| "quiet"
	| "hard-deadline"
	| "recording-stopped"
	| "identity-change"
	| "cleared"
	| "gesture-limit"
	| "disposed";

export interface UndoSelectionState {
	from: number;
	to: number;
	anchor: number;
	head: number;
	empty: boolean;
}

export interface UndoScrollState {
	x: number;
	y: number;
	phase: "before" | "after";
	axes: string;
}

export interface UndoKeyState {
	key: "z" | "y";
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
	defaultPrevented: boolean;
	target: "editor" | "toolbar" | "other";
}

export interface UndoTransactionState {
	sequence: number;
	count: number;
	userEvent: UndoGesture | "other";
	docChanged: boolean;
	inkEffectCount: number;
	foreignEffectCount: number;
}

export interface UndoGuardState {
	decision: "allow" | "skip" | "restore";
	stage: "observed" | "request";
	reason:
		| "stale-view"
		| "multiple-transactions"
		| "no-transaction"
		| "document-change"
		| "non-history-transaction"
		| "no-effects"
		| "foreign-effects"
		| "effect-only-history"
		| "none";
}

export interface UndoHistoryRecord {
	seq: number;
	t: number;
	phase: UndoPhase;
	windowToken: string;
	instanceToken: string;
	kind?: UndoGesture;
	key?: UndoKeyState;
	selection?: UndoSelectionState;
	scroll?: UndoScrollState;
	transaction?: UndoTransactionState;
	guard?: UndoGuardState;
}

export interface UndoHistoryCapture {
	v: 1;
	status: UndoTraceStatus;
	epoch: number;
	gestures: number;
	records: UndoHistoryRecord[];
	endReason?: UndoEndReason;
	truncated: boolean;
	droppedRecords: number;
}

interface ActiveTrace {
    timers: ReturnType<typeof timerHost>;
	epoch: number;
	identity: object;
	windowToken: string;
	startedAt: number;
	deadline: number;
	gestures: number;
	seq: number;
	records: UndoHistoryRecord[];
	status: UndoTraceStatus;
	endReason?: UndoEndReason;
	truncated: boolean;
	droppedRecords: number;
	quietTimer: ReturnType<typeof setTimeout> | null;
	deadlineTimer: ReturnType<typeof setTimeout> | null;
}

let active: ActiveTrace | null = null;
let last: UndoHistoryCapture = blankCapture();
let instanceSeq = 0;
let windowSeq = 0;
let blockedIdentityEpoch: number | null = null;
const viewIdentities = new WeakMap<object, object>();
const identityWindows = new WeakMap<object, Window>();
const deferredFrames = new Map<() => void, number>();

function now(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function blankCapture(): UndoHistoryCapture {
	return { v: 1, status: "not-recorded", epoch: 0, gestures: 0, records: [], truncated: false, droppedRecords: 0 };
}

function token(prefix: string, n: number): string {
	return `${prefix}${n}`;
}

function clearTimers(trace: ActiveTrace, clearDeadline = true): void {
	if (trace.quietTimer !== null) trace.timers.clearTimeout(trace.quietTimer);
	if (clearDeadline && trace.deadlineTimer !== null) trace.timers.clearTimeout(trace.deadlineTimer);
	trace.quietTimer = null;
	if (clearDeadline) trace.deadlineTimer = null;
}

function cancelDeferredFrames(): void {
	for (const cancel of deferredFrames.keys()) cancel();
	deferredFrames.clear();
}

function scheduleQuiet(trace: ActiveTrace): void {
	if (trace.quietTimer !== null) trace.timers.clearTimeout(trace.quietTimer);
	const { epoch, identity, windowToken } = trace;
	trace.quietTimer = trace.timers.setTimeout(() => {
		if (active !== trace || trace.epoch !== epoch || trace.identity !== identity || trace.windowToken !== windowToken) return;
		finish("quiet");
	}, 250);
}

function snapshot(trace: ActiveTrace | null): UndoHistoryCapture {
	if (!trace) return { ...last, records: last.records.map((record) => ({ ...record })) };
	return {
		v: 1,
		status: trace.status,
		epoch: trace.epoch,
		gestures: trace.gestures,
		records: trace.records.map((record) => ({ ...record })),
		...(trace.endReason ? { endReason: trace.endReason } : {}),
		truncated: trace.truncated,
		droppedRecords: trace.droppedRecords,
	};
}

function finish(reason: UndoEndReason): void {
	if (!active) return;
	if (reason !== "quiet") cancelDeferredFrames();
	clearTimers(active, reason !== "quiet");
	active.endReason = reason;
	if (active.status !== "discarded")
		active.status = active.records.length > 0 ? "captured" : "armed-no-key";
	last = snapshot(active);
}

function sameIdentity(trace: ActiveTrace, identity: object): boolean {
	return trace.identity === identity && trace.epoch === diagnosticsEpoch();
}

function append(input: Omit<UndoHistoryRecord, "seq" | "t" | "windowToken" | "instanceToken">): void {
	if (!active) return;
	if (active.records.length >= 32) {
		active.truncated = true;
		active.droppedRecords = Math.min(32, active.droppedRecords + 1);
		return;
	}
	active.records.push({
		...input,
		seq: ++active.seq,
		t: Math.max(0, Math.round(now() - active.startedAt)),
		windowToken: active.windowToken,
		instanceToken: token("i", getInstanceToken(active.identity)),
	});
	last = snapshot(active);
}

const instanceTokens = new WeakMap<object, number>();
function getInstanceToken(identity: object): number {
	let value = instanceTokens.get(identity);
	if (value === undefined) {
		value = ++instanceSeq;
		instanceTokens.set(identity, value);
	}
	return value;
}

export function isUndoRedoKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat">): UndoGesture | null {
	if (event.repeat || event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
	const key = event.key.toLowerCase();
	if (key === "z") return event.shiftKey ? "redo" : "undo";
	if (key === "y" && !event.shiftKey) return "redo";
	return null;
}

export function beginUndoWindow(
	identity: object,
	input: {
		kind: UndoGesture;
		key: UndoKeyState;
		selection: UndoSelectionState;
		scroll: UndoScrollState;
	}
): void {
	if (!diagnosticsEnabled()) return;
	const epoch = diagnosticsEpoch();
	if (active && !sameIdentity(active, identity)) {
		active.status = "discarded";
		finish("identity-change");
		active = null;
		blockedIdentityEpoch = epoch;
		return;
	}
	const time = now();
	if (blockedIdentityEpoch === epoch) return;
	if (active?.endReason && active.endReason !== "quiet") return;
	if (active?.endReason === "quiet") {
		active.endReason = undefined;
		active.status = "armed-no-key";
		active.windowToken = token("w", ++windowSeq);
	}
	if (!active) {
		active = {
			timers: timerHost(identityWindows.get(identity)),
			epoch,
			identity,
			windowToken: token("w", ++windowSeq),
			startedAt: time,
			deadline: time + 2000,
			gestures: 0,
			seq: 0,
			records: [],
			status: "armed-no-key",
			truncated: false,
			droppedRecords: 0,
			quietTimer: null,
			deadlineTimer: null,
		};
		const trace = active;
		const { epoch: timerEpoch, identity: timerIdentity } = trace;
		active.deadlineTimer = trace.timers.setTimeout(() => {
			if (active !== trace || trace.epoch !== timerEpoch || trace.identity !== timerIdentity) return;
			finish("hard-deadline");
		}, 2000);
	}
	if (time >= active.deadline) {
		finish("hard-deadline");
		return;
	}
	if (active.gestures >= 2) {
		active.truncated = true;
		active.droppedRecords = Math.min(32, active.droppedRecords + 1);
		finish("gesture-limit");
		return;
	}
	active.gestures++;
	active.status = "captured";
	append({ phase: "pre", kind: input.kind, key: input.key, selection: input.selection, scroll: input.scroll });
	scheduleQuiet(active);
}

export function recordUndoObservation(
	identity: object,
	input: Omit<UndoHistoryRecord, "seq" | "t" | "windowToken" | "instanceToken">,
	expectedEpoch = diagnosticsEpoch()
): void {
	if (!diagnosticsEnabled() || expectedEpoch !== diagnosticsEpoch() || !active || !!active.endReason || !sameIdentity(active, identity)) return;
	if (now() >= active.deadline) {
		finish("hard-deadline");
		return;
	}
	append(input);
	scheduleQuiet(active);
}

export function endUndoWindow(reason: UndoEndReason): void {
	finish(reason);
}

export function discardUndoTrace(identity: object): void {
	if (!active || active.identity !== identity) return;
	if (active.endReason === "recording-stopped") return;
	active.status = "discarded";
	finish("identity-change");
}

export function resetUndoTrace(): void {
	if (active) clearTimers(active);
	cancelDeferredFrames();
	active = null;
	blockedIdentityEpoch = null;
	last = { ...blankCapture(), status: "armed-no-key", epoch: diagnosticsEpoch() };
}

export function clearUndoTrace(): void {
	if (active) clearTimers(active);
	cancelDeferredFrames();
	active = null;
	blockedIdentityEpoch = null;
	last = { ...blankCapture(), endReason: "cleared" };
}

export function captureUndoTrace(): UndoHistoryCapture {
	return snapshot(active);
}

export function syncUndoTraceForDiagnostics(): void {
	if (diagnosticsEnabled()) resetUndoTrace();
	else endUndoWindow("recording-stopped");
}

export function registerUndoTraceView(view: object, identity: object): object {
	const existing = viewIdentities.get(view);
	if (existing) return existing;
	viewIdentities.set(view, identity);
    const owner = (view as { ownerDocument?: Document }).ownerDocument?.defaultView;
    if (owner) identityWindows.set(identity, owner);
	return identity;
}

export function unregisterUndoTraceView(view: object): void {
	const identity = viewIdentities.get(view);
	if (identity) identityWindows.delete(identity);
	viewIdentities.delete(view);
}

export function undoTraceIdentityForView(view: object): object {
	return viewIdentities.get(view) ?? view;
}

export function queueUndoPostObservation(
	identity: object,
	epoch: number,
	read: () => Omit<UndoHistoryRecord, "seq" | "t" | "windowToken" | "instanceToken">
): void {
	if (!diagnosticsEnabled() || epoch !== diagnosticsEpoch() || !active || !!active.endReason || !sameIdentity(active, identity)) return;
	const windowToken = active.windowToken;
	const scheduler = animationHost(identityWindows.get(identity));
    const cancel = () => scheduler.cancelAnimationFrame(frame);
    const frame = scheduler.requestAnimationFrame(() => {
		deferredFrames.delete(cancel);
		if (!diagnosticsEnabled() || epoch !== diagnosticsEpoch() || !active || !!active.endReason || active.windowToken !== windowToken || !sameIdentity(active, identity)) return;
		if (now() >= active.deadline) {
			finish("hard-deadline");
			return;
		}
		recordUndoObservation(identity, read(), epoch);
	});
	deferredFrames.set(cancel, frame);
}
