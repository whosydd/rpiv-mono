import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { AskUserQuestionConfig } from "./config.js";
import type { QuestionnaireMouseEvent } from "./state/questionnaire-session.js";

/**
 * Integration tests for the raw `ctx.ui.onTerminalInput` collapse listener.
 * The factory tests drive the component `handleInput` path (the fallback when
 * no raw listener is available); these drive the listener path that pi-tui
 * needs while the overlay is hidden, using the real QuestionnaireSession via
 * the `ctx.ui.custom` factory and a fake OverlayHandle.
 */

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

const CTRL_RBRACKET = "\x1d"; // GS byte — what legacy terminals send for Ctrl+]
const KITTY_CTRL_RBRACKET_PRESS = "\x1b[93;5u";
const KITTY_CTRL_RBRACKET_REPEAT = "\x1b[93;5:2u";
const KITTY_CTRL_RBRACKET_RELEASE = "\x1b[93;5:3u";
const ALT_O = "\x1bo"; // ESC-prefixed 'o' — legacy encoding for Alt+O

const params = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [{ label: "Alpha" }, { label: "Beta" }],
		},
	],
};

interface FakeHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
	isFocused(): boolean;
}

interface RecordingHandle extends FakeHandle {
	/** Call counters so tests can assert the hide/show hand-off without pi-tui's real state. */
	calls: { focus: number; unfocus: number };
}

function makeHandle(over: { isFocused?: () => boolean } = {}): RecordingHandle {
	let hidden = false;
	const calls: RecordingHandle["calls"] = { focus: 0, unfocus: 0 };
	return {
		hide: () => {},
		focus: () => {
			calls.focus += 1;
		},
		unfocus: () => {
			calls.unfocus += 1;
		},
		setHidden: (h: boolean) => {
			hidden = h;
		},
		isHidden: () => hidden,
		// Mirrors pi-tui: a visible questionnaire overlay normally owns focus; a hidden
		// one never does. Overridable for the other-overlay-on-top case.
		isFocused: over.isFocused ?? (() => !hidden),
		calls,
	};
}

type RawListener = (data: string) => { consume?: boolean } | undefined;
type SessionComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: QuestionnaireMouseEvent): unknown;
};

function register() {
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

/**
 * Fake `ctx.ui` that mimics interactive-mode wiring: `onTerminalInput` captures
 * the raw listener, `custom` runs the real factory then hands out the overlay
 * handle via `onHandle`, and `script` drives the interaction before resolving.
 */
function driveWithListener(handle: FakeHandle, script: (done: (v: unknown) => void) => void) {
	const notify = vi.fn();
	const removeListener = vi.fn();
	const listenerRef: { current: RawListener | undefined } = { current: undefined };
	const componentRef: { current: SessionComponent | undefined } = { current: undefined };
	const onTerminalInput = vi.fn((h: RawListener) => {
		listenerRef.current = h;
		return removeListener;
	});
	const custom = vi.fn(
		(
			factory: (
				tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
				theme: typeof identityTheme,
				kb: undefined,
				done: (v: unknown) => void,
			) => unknown,
			options?: { onHandle?: (handle: FakeHandle) => void },
		) => {
			return new Promise((resolve) => {
				componentRef.current = factory(
					{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
					identityTheme,
					undefined,
					resolve,
				) as SessionComponent;
				options?.onHandle?.(handle);
				script(resolve);
			});
		},
	);
	const ctx = { hasUI: true, ui: { custom, onTerminalInput, notify } } as never;
	return { ctx, notify, onTerminalInput, removeListener, listenerRef, componentRef };
}

const home = process.env.HOME ?? "";
const configDir = join(home, ".config", "rpiv-ask-user-question");
const configPath = join(configDir, "config.json");

function writeCollapseKeyConfig(collapseKey: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ collapseKey } satisfies AskUserQuestionConfig));
}

afterEach(() => {
	if (existsSync(configPath)) rmSync(configPath);
});

describe("ask_user_question — raw terminal collapse listener", () => {
	it("hides via OverlayHandle.setHidden and unhides on the second press", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, removeListener, listenerRef } = driveWithListener(handle, (done) => {
			// First press: hide the overlay so chat scrolling and editor focus resume.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			// Second press: show it again with answers intact.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			// Third round-trip re-hides.
			expect(listenerRef.current?.(CTRL_RBRACKET)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		// execute's finally must tear the raw listener down once the tool resolves.
		expect(removeListener).toHaveBeenCalledTimes(1);
	});

	it("toggles once for Kitty keyboard press, repeat, and release events", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			// Repeat and release still belong to the collapse binding, so consume them
			// without toggling or leaking them into the newly focused chat editor.
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_REPEAT)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_RELEASE)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);

			expect(listenerRef.current?.(KITTY_CTRL_RBRACKET_PRESS)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("ignores non-matching keys", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, notify, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.("x")).toBeUndefined();
			expect(listenerRef.current?.(ALT_O)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(notify).not.toHaveBeenCalled();
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("leaves the key to another focused overlay (visible but unfocused questionnaire)", async () => {
		const tool = register();
		// e.g. `/btw` opened on top: the questionnaire is visible underneath but
		// not focused — the listener must not toggle it from under the top overlay.
		const handle = makeHandle({ isFocused: () => false });
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("host with an overlay handle but no raw input keeps the overlay visible on collapse (fallback row, no trap)", async () => {
		// A host that delivers onHandle but not onTerminalInput has exactly one input
		// path: the component's handleInput — which pi-tui does not deliver to a hidden
		// overlay. If collapsing hid the overlay here, nothing could ever reopen it, so
		// the session must suppress setHidden and rely on the one-line collapsed row.
		const tool = register();
		const handle = makeHandle();
		const componentRef: { current: SessionComponent | undefined } = { current: undefined };
		const custom = vi.fn(
			(
				factory: (
					tui: { requestRender: () => void; terminal: { columns: number; rows: number } },
					theme: typeof identityTheme,
					kb: undefined,
					done: (v: unknown) => void,
				) => unknown,
				options?: { onHandle?: (handle: FakeHandle) => void },
			) => {
				return new Promise((resolve) => {
					componentRef.current = factory(
						{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } },
						identityTheme,
						undefined,
						resolve,
					) as SessionComponent;
					options?.onHandle?.(handle);
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(handle.isHidden()).toBe(false);
					const collapsed = componentRef.current.render(120);
					expect(collapsed).toHaveLength(1);
					expect(collapsed[0]).toContain("Ctrl+] to expand");
					// The visible row still routes input, so the same key expands it again.
					componentRef.current.handleInput(CTRL_RBRACKET);
					expect(componentRef.current.render(120).length).toBeGreaterThan(1);
					resolve({ answers: [], cancelled: true });
				});
			},
		);
		const ctx = { hasUI: true, ui: { custom } } as never;
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("honours a configured collapseKey (alt+o toggles, ctrl+] does not)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, listenerRef } = driveWithListener(handle, (done) => {
			expect(listenerRef.current?.(CTRL_RBRACKET)).toBeUndefined();
			expect(handle.isHidden()).toBe(false);
			expect(listenerRef.current?.(ALT_O)).toEqual({ consume: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("footer hint and collapsed row name the configured collapseKey (#176)", async () => {
		writeCollapseKeyConfig("alt+o");
		const tool = register();
		const handle = makeHandle();
		const { ctx, componentRef } = driveWithListener(handle, (done) => {
			const expanded = componentRef.current!.render(120).join("\n");
			expect(expanded).toContain("Alt+O or double-click to collapse");
			expect(expanded).not.toContain("Ctrl+]");
			// Collapse via the component input path — the one-line footer must name
			// the same key the router actually honours.
			componentRef.current!.handleInput(ALT_O);
			const collapsed = componentRef.current!.render(120);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toContain("Alt+O to expand");
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("collapses on a double-click on the dialog, consuming the press so motion cannot cancel it", async () => {
		const tool = register();
		const handle = makeHandle();
		const press: QuestionnaireMouseEvent = { type: "press", button: "left", x: 10, y: 2 };
		const firstClick: QuestionnaireMouseEvent = { type: "click", button: "left", x: 10, y: 2, clickCount: 1 };
		const secondClick: QuestionnaireMouseEvent = { ...firstClick, clickCount: 2 };
		const { ctx, componentRef } = driveWithListener(handle, (done) => {
			expect(componentRef.current!.handleMouse?.(press)).toEqual({
				handled: true,
				render: false,
			});
			// The lone click Herdr forwards while focusing the pane must stay inert.
			expect(componentRef.current!.handleMouse?.(firstClick)).toEqual({ handled: true, render: false });
			expect(handle.isHidden()).toBe(false);
			expect(componentRef.current!.handleMouse?.(secondClick)).toEqual({ handled: true, render: true });
			expect(handle.isHidden()).toBe(true);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("exposes a clickable call row that expands the collapsed dialog", async () => {
		const tool = register();
		const handle = makeHandle();
		const { ctx, componentRef } = driveWithListener(handle, (done) => {
			componentRef.current!.handleInput(CTRL_RBRACKET);
			expect(handle.isHidden()).toBe(true);
			// Pi renders the tool call row through `renderCall` and wraps it in a mouse
			// region; the click lands on that component, not on the hidden overlay.
			const callRow = tool.renderCall?.(
				{ questions: [] } as never,
				identityTheme as never,
				{
					toolCallId: "tc",
					expanded: false,
					isPartial: true,
					isError: false,
				} as never,
			) as { handleMouse?: (event: QuestionnaireMouseEvent) => unknown } | undefined;
			expect(callRow).toBeDefined();
			expect(callRow!.handleMouse?.({ ...({} as QuestionnaireMouseEvent), type: "press", button: "left" })).toEqual({
				handled: true,
				render: false,
			});
			expect(
				callRow!.handleMouse?.({ ...({} as QuestionnaireMouseEvent), type: "click", button: "left" }),
			).toBeDefined();
			expect(handle.isHidden()).toBe(false);
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
	});

	it("does not register a listener when collapseKey is 'off'", async () => {
		writeCollapseKeyConfig("off");
		const tool = register();
		const handle = makeHandle();
		const { ctx, onTerminalInput, componentRef } = driveWithListener(handle, (done) => {
			// The footer must not advertise a collapse shortcut that cannot fire (#176).
			const rendered = componentRef.current!.render(120).join("\n");
			expect(rendered).not.toContain("to collapse");
			expect(rendered).toContain("Esc to cancel");
			done({ answers: [], cancelled: true });
		});
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx);
		expect(onTerminalInput).not.toHaveBeenCalled();
	});
});
