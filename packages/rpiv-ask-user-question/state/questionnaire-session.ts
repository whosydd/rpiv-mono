import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Editor, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, formatKeySpecForDisplay } from "../config.js";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { COLLAPSED_HINT_TEMPLATE, HINT_PART_CANCEL, KEY_PLACEHOLDER } from "../view/dialog-builder.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire, type QuestionnaireBuilt } from "./build-questionnaire.js";
import { t } from "./i18n-bridge.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";

export interface QuestionnaireSessionConfig {
	tui: TUI;
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	keybindings: QuestionnaireRuntime["keybindings"];
	/** Opens Pi's configured external editor. Resolve `undefined` on a reported launch failure. */
	editInput: (value: string) => Promise<string | undefined>;
	/** Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
	collapseKey: string;
	/**
	 * True iff `execute()` registered the raw `ctx.ui.onTerminalInput` listener. Gates the
	 * `set_overlay_hidden` effect: hiding is only reversible through that raw listener,
	 * because pi-tui delivers no input to a hidden overlay. A host without it keeps the
	 * one-line collapsed row visible and focused, where the component's key router
	 * expands it.
	 */
	canReopenWhileHidden: boolean;
}

/**
 * Structural mirror of pi-tui's `TuiMouseEvent` (pi-tui ≥ 1.0). Declared locally instead
 * of imported so the package keeps compiling against the repo's pinned pre-mouse
 * pi-tui devDependency: older hosts never call `handleMouse`, newer ones call it with a
 * superset of these fields.
 */
export interface QuestionnaireMouseEvent {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
	x: number;
	y: number;
	/** Consecutive click count when `type` is `click`. */
	clickCount?: number;
	/** Shift modifier; hosts that report it let the user bypass the click handler for text selection. */
	shift?: boolean;
}

/** Subset of pi-tui's `TuiMouseEventResult` that the session uses. */
export interface QuestionnaireMouseResult {
	handled?: boolean;
	focus?: boolean;
	render?: boolean;
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	/** Optional normalized mouse handler; hosts without mouse support never call it. */
	handleMouse?(event: QuestionnaireMouseEvent): QuestionnaireMouseResult | undefined;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

/**
 * Slim runtime: owns the canonical state cell, the headless editor cells, the
 * notes-draft mirror, and the effect runner. State
 * transitions go through the pure `reduce` reducer; UI fan-out goes through
 * the `QuestionnairePropsAdapter` produced by `buildQuestionnaire`.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Editor;
	private readonly inlineInput: Editor;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly keybindings: QuestionnaireRuntime["keybindings"];
	private readonly editInput: QuestionnaireSessionConfig["editInput"];
	private readonly collapseKey: string;
	private readonly canReopenWhileHidden: boolean;
	private inputEditorOpen = false;
	/** See {@link handleMouse}: last click routed to the dialog, used to pair a double-click. */
	private lastDialogClick: { x: number; y: number; count: number; expanded: boolean } | undefined;

	/**
	 * Overlay handle captured by `ctx.ui.custom`'s `onHandle` callback. Lets the session
	 * call `setHidden(true/false)` so pi-tui's overlay stack reflects the collapsed state
	 * and overlay-aware consumers (e.g. `pi-station`) can resume normal behaviour.
	 */
	private overlayHandle: OverlayHandle | undefined;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.keybindings = config.keybindings;
		this.editInput = config.editInput;
		this.collapseKey = config.collapseKey;
		this.canReopenWhileHidden = config.canReopenWhileHidden;

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
			collapseKey: this.collapseKey,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		this.component = this.assembleComponent(built, config.theme);
		this.viewAdapter.apply(this.state);
	}

	private assembleComponent(built: QuestionnaireBuilt, theme: Theme): QuestionnaireSessionComponent {
		const collapsedRender = this.buildCollapsedRender(theme);
		return {
			render: (width) => (this.state.collapsed ? collapsedRender(width) : built.render(width)),
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
			handleMouse: (event) => this.handleMouse(event),
		};
	}

	/**
	 * Pointer toggle for the dialog: a single left click expands, a double-click
	 * collapses. The asymmetry is deliberate. Expanding stays single-click because on
	 * hosts that cannot hide the overlay the visible one-line row is the only pointer
	 * path back; collapsing needs the second click because no in-app signal distinguishes
	 * a deliberate click from the click a multiplexer forwards into the pane while it
	 * grants that pane focus (Herdr pushes both the pane mouse event and `PaneFocus` for
	 * the same press). With single-click collapse, simply switching to the pane dismissed
	 * the questionnaire; a double-click makes that accidental gesture a no-op.
	 *
	 * The press is consumed so the renderer's press-gesture path owns the gesture and
	 * synthesizes `click` on a release at the same cell: terminals that report all mouse
	 * motion (pi-tui's default `?1003h` mode, e.g. Herdr) emit move events between press
	 * and release, and the renderer's text-selection fallback turns every one of them
	 * into a drag — which cancels the synthesized click. Taking the press costs
	 * drag-to-select inside the dialog, so a Shift press passes straight through to the
	 * renderer's selection path. Collapsing hides the overlay, so no focus flag is needed
	 * on the result; expanding is driven from the transcript call row
	 * (`view/components/call-line.ts`) or the raw collapse-key listener.
	 */
	private handleMouse(event: QuestionnaireMouseEvent): QuestionnaireMouseResult | undefined {
		if (event.button !== "left" || event.shift === true) return undefined;
		if (this.inputEditorOpen) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		const clickCount = event.clickCount ?? 1;
		// The renderer groups same-cell clicks within its double-click window into a run;
		// mirror just enough of that to recognize the click paired with an expand below.
		const partner =
			this.lastDialogClick !== undefined &&
			this.lastDialogClick.x === event.x &&
			this.lastDialogClick.y === event.y &&
			this.lastDialogClick.count + 1 === clickCount;
		if (this.state.collapsed) {
			// Only the first click of a run expands the visible one-line row; its partner is
			// swallowed so the double-click cannot re-collapse what it just reopened.
			const expands = clickCount === 1;
			this.lastDialogClick = { x: event.x, y: event.y, count: clickCount, expanded: expands };
			if (!expands) return { handled: true, render: false };
			this.toggleCollapsedExternal();
			return { handled: true, render: true };
		}
		const previousExpanded = this.lastDialogClick?.expanded === true;
		this.lastDialogClick = { x: event.x, y: event.y, count: clickCount, expanded: false };
		if (clickCount < 2 || (partner && previousExpanded)) return { handled: true, render: false };
		this.toggleCollapsedExternal();
		return { handled: true, render: true };
	}

	/**
	 * Collapsed render for hosts that cannot hide the overlay (no raw terminal input to
	 * reopen it): a single dim row at the bottom, kept visible and focused. pi-tui sizes
	 * the overlay to `min(lines.length, maxHeight)`, so returning one line shrinks the
	 * bottom-anchored overlay to one row and the transcript behind it becomes readable
	 * (#47). On hosts that can hide it, collapse emits `set_overlay_hidden` and the
	 * transcript's `ask_user_question` call row becomes the expand affordance instead.
	 * `t` stays inside the closure (live locale updates); the key display is static per
	 * session.
	 *
	 * With collapseKey "off" the router and raw listener never toggle `collapsed`,
	 * but `toggleCollapsedExternal()` is a public ungated entry — fall back to the
	 * cancel-only line rather than rendering a literal "Off to expand".
	 */
	private buildCollapsedRender(theme: Theme): (width: number) => string[] {
		const collapseKeyDisplay = formatKeySpecForDisplay(this.collapseKey);
		const collapsedHintLine = (): string =>
			this.collapseKey === COLLAPSE_KEY_OFF
				? t("hint.cancel", HINT_PART_CANCEL)
				: t("hint.expand_line", COLLAPSED_HINT_TEMPLATE).replace(KEY_PLACEHOLDER, collapseKeyDisplay);
		return (_width: number): string[] => [theme.fg("dim", ` ${collapsedHintLine()} `)];
	}

	dispatch(data: string): void {
		if (this.inputEditorOpen) return;
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		// Drafts restore through Editor.setText, which clears the backing paste map —
		// read expanded so stored drafts never orphan a paste marker.
		const draft = this.notesInput.getExpandedText?.() ?? this.notesInput.getText();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setText(effect.value);
				return;
			case "clear_input_buffer":
				this.inlineInput.setText("");
				return;
			case "open_input_editor":
				this.openInputEditorAsync(effect.value);
				return;
			case "set_notes_value":
				this.notesInput.setText(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "set_overlay_hidden":
				// No-op until `setOverlayHandle` has been called (the handle arrives via
				// `ctx.ui.custom`'s `onHandle` right after the overlay is shown), and suppressed
				// entirely when no raw terminal listener exists — hiding would then be
				// irreversible (pi-tui routes no input to a hidden overlay), so the visible
				// one-line collapsed row serves as the fallback rendering instead.
				if (!this.canReopenWhileHidden) return;
				this.overlayHandle?.setHidden(effect.hidden);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/** Opens Pi's configured external editor; on success commits the replacement buffer, on reported failure retains the draft. */
	private openInputEditorAsync(value: string): void {
		if (this.inputEditorOpen) return;
		this.inputEditorOpen = true;
		void this.editInput(value).then(
			(edited) => {
				this.inputEditorOpen = false;
				if (edited !== undefined) this.commit({ kind: "input_replace", value: edited });
			},
			() => {
				// The host callback reports launch errors; retain the draft and restore input handling.
				this.inputEditorOpen = false;
			},
		);
	}

	/**
	 * Per-keystroke `ignore` fast path: delegates text editing to Pi's headless
	 * multiline `Editor`, including paste, undo, cursor movement, and configured
	 * `tui.input.newLine` handling. `viewAdapter.apply` then projects its public
	 * text/cursor state without a reducer round-trip.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		const cursor = this.inlineInput.getCursor();
		const lastLine = this.inlineInput.getLines().length - 1;
		return {
			keybindings: this.keybindings,
			inputBuffer: this.inlineInput.getExpandedText?.() ?? this.inlineInput.getText(),
			canMoveInputUp: cursor.line > 0,
			canMoveInputDown: cursor.line < lastLine,
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
			collapseKey: this.collapseKey,
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}

	/**
	 * Setter for the overlay handle, called by `ctx.ui.custom`'s `onHandle` callback once
	 * the TUI has created the overlay. Until this is called, `set_overlay_focus` effects
	 * are no-ops — the session still tracks `state.collapsed` for the view layer.
	 */
	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	/** True while the dialog is collapsed to its one-line hint row. */
	isCollapsed(): boolean {
		return this.state.collapsed;
	}

	/**
	 * Public toggle used by the raw terminal input listener registered in `execute()`.
	 * pi-tui routes no input to a hidden overlay's `component.handleInput`, so the raw
	 * listener (which fires for terminal data regardless of overlay visibility) reaches
	 * the session through this method instead. Routed through `commit` so the transition
	 * stays in the reducer and the overlay hide/show happens via the
	 * `set_overlay_hidden` effect like every other side effect.
	 */
	toggleCollapsedExternal(): void {
		if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
	}

	/**
	 * Public expand used by the transcript `ask_user_question` call row
	 * (`view/components/call-line.ts`). No-op while the dialog is already expanded (or
	 * while the external editor owns the terminal), so clicking the row never collapses
	 * the dialog it is meant to bring back.
	 */
	expandExternal(): void {
		if (!this.state.collapsed) return;
		if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
	}
}
