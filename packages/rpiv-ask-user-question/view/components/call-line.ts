import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionnaireMouseEvent, QuestionnaireMouseResult } from "../../state/questionnaire-session.js";

/**
 * This tool renders its own call/result framing (`renderShell: "self"`), which is what
 * makes the whole tool block clickable: the default shell wraps the call row in a `Box`
 * whose one-column gutters and one-row pads reject mouse events, so only the glyphs
 * themselves would expand the dialog. Re-declaring the frame here reproduces the default
 * look (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`, one column of horizontal
 * padding, blank pad rows) while letting the call block own every pixel it paints.
 */

/** Mirror of Pi's collapsed tool-call header cut-off (`formatToolCallWithArgs`). */
const COLLAPSED_ARGS_CHARS = 100;
/** Pi's default tool Box padding. */
const PADDING_X = 1;
/** Pi's result fallback preview cap. */
const RESULT_PREVIEW_LINES = 10;

/** Pi's `replaceTabs`: a literal tab becomes three spaces so columns stay aligned. */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * `expanded` mirrors the host's tool-row expansion state; the collapsed form is the
 * resting state while the questionnaire is open.
 */
export function formatCallLine(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

type Background = (text: string) => string;

/** Same background selection Pi's default shell applies to the whole tool box. */
function toolRowBackground(theme: Theme, isPartial: boolean, isError: boolean): Background {
	if (isPartial) return (text) => theme.bg("toolPendingBg", text);
	return isError ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
}

/** Pad to the full row width before painting the background, matching `Box.applyBg`. */
function padLine(bg: Background, line: string, width: number): string {
	const pad = width - visibleWidth(line);
	return bg(pad > 0 ? line + " ".repeat(pad) : line);
}

/** One column of gutter on each side, like the default tool box. */
function frameLines(bg: Background, content: string[], width: number): string[] {
	const leftPad = " ".repeat(PADDING_X);
	return content.map((line) => padLine(bg, leftPad + line, width));
}

/**
 * Transcript-side expand affordance for the questionnaire. While the dialog is
 * collapsed (hidden), a left click anywhere on the tool's call block expands it; in
 * every other state the click falls through to Pi's own mouse region, which toggles the
 * tool-result expansion — so the block keeps its default behaviour once the
 * questionnaire is answered.
 *
 * The press is consumed (only when a click will actually expand) so Pi's press-gesture
 * path owns the gesture and synthesizes `click` on a release at the same cell;
 * terminals that report all mouse motion would otherwise turn the intervening move
 * events into a drag and cancel the click. A `Shift` press passes through so text stays
 * selectable.
 */
export class QuestionnaireCallLine implements Component {
	private readonly text: Text;
	private readonly bg: Background;
	private readonly padBottom: boolean;
	private readonly canExpand: () => boolean;
	private readonly expand: () => void;

	constructor(config: {
		title: string;
		args: unknown;
		theme: Theme;
		expanded: boolean;
		/** Pi's partial flag: true while the questionnaire is still awaiting an answer. */
		isPartial: boolean;
		isError: boolean;
		/** True only while the collapsed dialog wants the next click to expand it. */
		canExpand: () => boolean;
		expand: () => void;
	}) {
		this.text = new Text(formatCallLine(config.title, config.args, config.theme, config.expanded), 0, 0);
		this.bg = toolRowBackground(config.theme, config.isPartial, config.isError);
		// While pending, the call block carries the box's bottom padding; once a result
		// exists, the result block supplies it, matching the default shell's single pad.
		this.padBottom = config.isPartial;
		this.canExpand = config.canExpand;
		this.expand = config.expand;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - PADDING_X * 2);
		const content = frameLines(this.bg, this.text.render(contentWidth), width);
		const blank = padLine(this.bg, "", width);
		return this.padBottom ? [blank, ...content, blank] : [blank, ...content];
	}

	invalidate(): void {}

	handleMouse(event: QuestionnaireMouseEvent): QuestionnaireMouseResult | undefined {
		if (event.button !== "left" || event.shift === true) return undefined;
		if (!this.canExpand()) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		this.expand();
		return { handled: true, render: true };
	}
}

/**
 * Result block for the self-rendered tool shell (see {@link QuestionnaireCallLine}):
 * mirrors Pi's result fallback styling inside the same background frame. It deliberately
 * does not handle mouse events, so Pi's mouse region keeps toggling result expansion.
 */
export class QuestionnaireResultBlock implements Component {
	private readonly lines: string[];
	private readonly bg: Background;

	constructor(config: {
		text: string;
		theme: Theme;
		expanded: boolean;
		isPartial: boolean;
		isError: boolean;
	}) {
		const all = config.text.length > 0 ? config.text.split("\n") : [];
		const display = config.expanded ? all : all.slice(0, RESULT_PREVIEW_LINES);
		const remaining = all.length - display.length;
		this.lines = display.map((line) => config.theme.fg("toolOutput", line));
		if (remaining > 0) {
			this.lines.push(config.theme.fg("muted", `... (${remaining} more lines)`));
		}
		this.bg = toolRowBackground(config.theme, config.isPartial, config.isError);
	}

	render(width: number): string[] {
		return [...frameLines(this.bg, this.lines, width), padLine(this.bg, "", width)];
	}

	invalidate(): void {}
}
