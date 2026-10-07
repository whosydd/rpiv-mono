import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { type QuestionnaireMouseEvent, QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	params?: QuestionParams;
	itemsByTab?: WrappingSelectItem[][];
	editInput?: (value: string) => Promise<string | undefined>;
	keybindings?: typeof keybindings;
	canReopenWhileHidden?: boolean;
	collapseKey?: string;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings: options.keybindings ?? keybindings,
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: options.collapseKey ?? "off",
		canReopenWhileHidden: options.canReopenWhileHidden ?? false,
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("keeps input exclusive while the external editor is open", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);

		session.dispatch(UP);
		session.dispatch("late input");
		resolveEditor("edited");
		await Promise.resolve();
		await Promise.resolve();
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
			cancelled: false,
		});
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("commits the typed draft with a remapped tui.input.submit key (#156)", () => {
		// Slack-style config: enter is folded into tui.input.newLine (colliding with
		// the default tui.select.confirm), submit lives on its own key. The submit
		// key must confirm the custom answer instead of falling through to the
		// editor, whose own submit handling would wipe the draft.
		const CTRL_ENTER = "<CTRL_ENTER>";
		const remapped: typeof keybindings = {
			matches(data: string, name: string): boolean {
				if (name === "tui.input.submit") return data === CTRL_ENTER;
				if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
				return keybindings.matches(data, name);
			},
		};
		const { session, done } = makeSession({ keybindings: remapped });
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(CTRL_ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("a raw Enter byte the router does not match cannot wipe the draft via the editor's own submit (#156)", () => {
		// The session fake matches only the <ENTER> sentinel, so a raw "\r" reaches
		// the headless Editor, whose GLOBAL keybindings still bind tui.input.submit
		// to enter. Without disableSubmit, Editor.submitValue() would reset the
		// buffer and silently destroy the draft.
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("precious draft");
		session.dispatch("\r");
		expect(session.component.render(120).join("\n")).toContain("precious draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — collapsed row with collapseKey 'off'", () => {
	it("renders the cancel-only line, never a literal 'Off to expand' (#176)", () => {
		// The router and raw listener never collapse when off, but
		// toggleCollapsedExternal() is a public ungated entry — the collapsed row
		// must not advertise a disabled shortcut if a caller forces it.
		const { session } = makeSession();
		session.toggleCollapsedExternal();
		const collapsed = session.component.render(120);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("Esc to cancel");
		expect(collapsed[0]).not.toContain("to expand");
		expect(collapsed[0]).not.toContain("Off");
	});
});

function makeMouseEvent(over: Partial<QuestionnaireMouseEvent> = {}): QuestionnaireMouseEvent {
	return { type: "click", button: "left", x: 10, y: 2, ...over };
}

describe("QuestionnaireSession — mouse collapse toggle", () => {
	it("takes the left press so the renderer owns the gesture and synthesizes the click", () => {
		const { session } = makeSession();
		// Same-cell motion between press and release kills the renderer's selection-path
		// click synthesis; the press-gesture path tolerates it, so the press must be handled.
		expect(session.component.handleMouse?.(makeMouseEvent({ type: "press" }))).toEqual({
			handled: true,
			render: false,
		});
		expect(session.isCollapsed()).toBe(false);
	});

	it("leaves a lone click inert — the click a multiplexer forwards while granting pane focus must not dismiss the dialog", () => {
		const { session } = makeSession();
		expect(session.component.handleMouse?.(makeMouseEvent())).toEqual({ handled: true, render: false });
		expect(session.isCollapsed()).toBe(false);
		expect(session.component.render(120).length).toBeGreaterThan(1);
	});

	it("collapses on a double-click of the visible dialog", () => {
		const { session } = makeSession();
		expect(session.component.handleMouse?.(makeMouseEvent({ clickCount: 2 }))).toEqual({
			handled: true,
			render: true,
		});
		expect(session.isCollapsed()).toBe(true);
		expect(session.component.render(120)).toHaveLength(1);
	});

	it("expands the visible one-line row on a single click and swallows the double-click partner", () => {
		const { session } = makeSession();
		session.toggleCollapsedExternal();
		expect(session.isCollapsed()).toBe(true);

		expect(session.component.handleMouse?.(makeMouseEvent())).toEqual({ handled: true, render: true });
		expect(session.isCollapsed()).toBe(false);
		expect(session.component.render(120).length).toBeGreaterThan(1);

		// The second click of the pair lands after the expand; it must not collapse the
		// row it just reopened.
		expect(session.component.handleMouse?.(makeMouseEvent({ clickCount: 2 }))).toEqual({
			handled: true,
			render: false,
		});
		expect(session.isCollapsed()).toBe(false);
	});

	it("collapses on a double-click even when collapseKey is 'off' — the pointer affordance is independent of the keyboard shortcut", () => {
		const { session } = makeSession();
		session.component.handleMouse?.(makeMouseEvent({ clickCount: 2 }));
		expect(session.isCollapsed()).toBe(true);
	});

	it("leaves Shift gestures to the renderer so text inside the dialog stays selectable", () => {
		const { session } = makeSession();
		expect(session.component.handleMouse?.(makeMouseEvent({ shift: true }))).toBeUndefined();
		expect(session.component.handleMouse?.(makeMouseEvent({ type: "press", shift: true }))).toBeUndefined();
		expect(session.isCollapsed()).toBe(false);
	});

	it.each([
		["right click", makeMouseEvent({ button: "right" })],
		["right press", makeMouseEvent({ type: "press", button: "right" })],
		["release", makeMouseEvent({ type: "release" })],
		["wheel", makeMouseEvent({ type: "wheel" })],
		["drag", makeMouseEvent({ type: "drag" })],
	])("ignores %s", (_label, event) => {
		const { session } = makeSession();
		expect(session.component.handleMouse?.(event)).toBeUndefined();
		expect(session.isCollapsed()).toBe(false);
	});
});

describe("QuestionnaireSession — collapse hides the overlay via the handle", () => {
	function makeRecordingHandle() {
		let hidden = false;
		const calls = { focus: 0, unfocus: 0, setHidden: [] as boolean[] };
		return {
			handle: {
				hide: () => {},
				setHidden: (h: boolean) => {
					hidden = h;
					calls.setHidden.push(h);
				},
				isHidden: () => hidden,
				focus: () => {
					calls.focus += 1;
				},
				unfocus: () => {
					calls.unfocus += 1;
				},
				isFocused: () => !hidden,
			},
			calls,
		};
	}

	it("hides on collapse and shows again on expand when the raw listener can reopen it", () => {
		const { session } = makeSession({ canReopenWhileHidden: true });
		const { handle, calls } = makeRecordingHandle();
		session.setOverlayHandle(handle as never);

		session.toggleCollapsedExternal();
		expect(calls.setHidden).toEqual([true]);
		expect(handle.isHidden()).toBe(true);

		session.toggleCollapsedExternal();
		expect(calls.setHidden).toEqual([true, false]);
		expect(handle.isHidden()).toBe(false);
	});

	it("never hides when no raw listener exists — the visible one-line row stays the only path back", () => {
		const { session } = makeSession({ canReopenWhileHidden: false });
		const { handle, calls } = makeRecordingHandle();
		session.setOverlayHandle(handle as never);

		session.toggleCollapsedExternal();
		expect(session.isCollapsed()).toBe(true);
		expect(calls.setHidden).toEqual([]);
		expect(handle.isHidden()).toBe(false);
	});
});

describe("QuestionnaireSession — expandExternal", () => {
	it("expands a collapsed dialog (the transcript call row click path)", () => {
		const { session } = makeSession();
		session.toggleCollapsedExternal();
		expect(session.isCollapsed()).toBe(true);

		session.expandExternal();
		expect(session.isCollapsed()).toBe(false);
	});

	it("is a no-op while the dialog is already expanded, so a click on the call row cannot collapse it", () => {
		const { session } = makeSession();
		session.expandExternal();
		expect(session.isCollapsed()).toBe(false);
	});
});
