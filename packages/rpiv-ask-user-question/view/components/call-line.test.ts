import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireMouseEvent } from "../../state/questionnaire-session.js";
import { formatCallLine, QuestionnaireCallLine, QuestionnaireResultBlock } from "./call-line.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	bg: (_c: string, s: string) => s,
} as never;

function makeEvent(over: Partial<QuestionnaireMouseEvent> = {}): QuestionnaireMouseEvent {
	return { type: "click", button: "left", x: 0, y: 0, ...over };
}

describe("formatCallLine", () => {
	it("mirrors Pi's collapsed tool header: bold title plus key=value pairs on one line", () => {
		expect(formatCallLine("ask_user_question", { questions: [] }, identityTheme, false)).toBe(
			"ask_user_question questions=[]",
		);
	});

	it("cuts the collapsed pair preview at 100 characters with an ellipsis", () => {
		const args = { questions: [{ question: "x".repeat(500) }] };
		const line = formatCallLine("ask_user_question", args, identityTheme, false);
		const preview = line.slice("ask_user_question ".length);
		expect(preview).toHaveLength(100);
		expect(preview.endsWith("...")).toBe(true);
	});

	it("turns tabs into three spaces in expanded string values like Pi's replaceTabs", () => {
		const line = formatCallLine("t", { a: "x\ty" }, identityTheme, true).split("\n");
		expect(line[1]).toBe("  a: x   y");
	});

	it("renders expanded args as indented key: value lines", () => {
		const rendered = formatCallLine("ask_user_question", { questions: [{ a: 1 }] }, identityTheme, true);
		const line = rendered.split("\n");
		expect(line[0]).toBe("ask_user_question");
		expect(line[1]).toBe("  questions: [");
		expect(rendered).toContain('"a": 1');
	});

	it("renders the bare title when args are absent", () => {
		expect(formatCallLine("ask_user_question", null, identityTheme, false)).toBe("ask_user_question");
	});
});

describe("QuestionnaireCallLine", () => {
	function makeComponent(over: { canExpand?: boolean; isPartial?: boolean } = {}) {
		const expand = vi.fn();
		const component = new QuestionnaireCallLine({
			title: "ask_user_question",
			args: { questions: [] },
			theme: identityTheme,
			expanded: false,
			isPartial: over.isPartial ?? true,
			isError: false,
			canExpand: () => over.canExpand ?? true,
			expand,
		});
		return { component, expand };
	}

	it("renders the default-shell frame while pending: a pad row, the gutter line, a pad row", () => {
		const { component } = makeComponent();
		const lines = component.render(80);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("ask_user_question questions=[]");
		// Full-width, background-painted rows make every cell of the block clickable.
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
	});

	it("drops the bottom pad once a result exists — the result block carries it", () => {
		const { component } = makeComponent({ isPartial: false });
		const lines = component.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(" ".repeat(80));
	});

	it("takes the press and expands on the click while the dialog is collapsed", () => {
		const { component, expand } = makeComponent();
		expect(component.handleMouse(makeEvent({ type: "press" }))).toEqual({ handled: true, render: false });
		expect(expand).not.toHaveBeenCalled();
		expect(component.handleMouse(makeEvent())).toEqual({ handled: true, render: true });
		expect(expand).toHaveBeenCalledTimes(1);
	});

	it("declines every event while the dialog is not collapsed, so Pi's result-expansion click still works", () => {
		const { component, expand } = makeComponent({ canExpand: false });
		expect(component.handleMouse(makeEvent({ type: "press" }))).toBeUndefined();
		expect(component.handleMouse(makeEvent())).toBeUndefined();
		expect(expand).not.toHaveBeenCalled();
	});

	it("leaves Shift presses and non-left buttons to the renderer", () => {
		const { component, expand } = makeComponent();
		expect(component.handleMouse(makeEvent({ shift: true }))).toBeUndefined();
		expect(component.handleMouse(makeEvent({ button: "right" }))).toBeUndefined();
		expect(expand).not.toHaveBeenCalled();
	});
});

describe("QuestionnaireResultBlock", () => {
	it("renders the result text inside the frame with a trailing pad row", () => {
		const block = new QuestionnaireResultBlock({
			text: "User answered: A",
			theme: identityTheme,
			expanded: false,
			isPartial: false,
			isError: false,
		});
		const lines = block.render(30);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("User answered: A");
		expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
	});

	it("caps a long result at ten lines unless expanded", () => {
		const text = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
		const collapsed = new QuestionnaireResultBlock({
			text,
			theme: identityTheme,
			expanded: false,
			isPartial: false,
			isError: false,
		});
		expect(collapsed.render(40)).toHaveLength(12);
		const expanded = new QuestionnaireResultBlock({
			text,
			theme: identityTheme,
			expanded: true,
			isPartial: false,
			isError: false,
		});
		expect(expanded.render(40)).toHaveLength(15);
	});
});
