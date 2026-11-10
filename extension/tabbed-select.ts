// A select list with filter tabs, for /jobs. ←/→ (or Tab / Shift+Tab) switch
// tabs, ↑/↓ move, Enter picks, Esc closes. Rendered through ctx.ui.custom, so it
// only works in the interactive TUI; callers fall back to ctx.ui.select elsewhere.

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface TabRow<T> {
	label: string;
	value: T;
}

export interface Tab<T> {
	title: string;
	count: number; // shown next to the title (jobs, not rows)
	rows: TabRow<T>[];
}

const MAX_VISIBLE = 15;

export function canUseTabs(ctx: any): boolean {
	return ctx?.mode === "tui" && typeof ctx?.ui?.custom === "function";
}

export function tabbedSelect<T>(
	ctx: any,
	title: string,
	tabs: Tab<T>[],
	initialTab = 0,
): Promise<T | undefined> {
	return ctx.ui.custom(
		(tui: any, theme: any, keybindings: any, done: (result: T | undefined) => void) => {
			let tab = Math.min(Math.max(0, initialTab), tabs.length - 1);
			let selected = 0;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const invalidate = () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			};
			const rows = () => tabs[tab]?.rows ?? [];
			const switchTab = (delta: number) => {
				tab = (tab + delta + tabs.length) % tabs.length;
				selected = 0;
			};

			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					const lines: string[] = [];
					lines.push(theme.fg("accent", theme.bold(title)));
					lines.push(
						tabs
							.map((t, i) => {
								const text = ` ${t.title} (${t.count}) `;
								return i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("muted", text);
							})
							.join(" "),
					);
					lines.push("");

					const list = rows();
					if (!list.length) {
						lines.push(theme.fg("dim", "  No jobs in this tab."));
					} else {
						const start = Math.max(
							0,
							Math.min(selected - Math.floor(MAX_VISIBLE / 2), list.length - MAX_VISIBLE),
						);
						const end = Math.min(list.length, start + MAX_VISIBLE);
						for (let i = start; i < end; i++) {
							const row = list[i]!;
							lines.push(
								i === selected
									? `${theme.fg("accent", "> ")}${theme.fg("accent", row.label)}`
									: `  ${theme.fg("text", row.label)}`,
							);
						}
						if (list.length > MAX_VISIBLE) lines.push(theme.fg("dim", `  (${selected + 1}/${list.length})`));
					}

					lines.push("");
					lines.push(theme.fg("dim", "←/→ switch tab · ↑/↓ move · enter open · esc close"));
					cachedWidth = width;
					cachedLines = lines.map((line) => truncateToWidth(line, width));
					return cachedLines;
				},
				handleInput(data: string): void {
					const list = rows();
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						const row = list[selected];
						if (row) done(row.value);
						return;
					}
					if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) switchTab(1);
					else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) switchTab(-1);
					else if (keybindings.matches(data, "tui.select.up") && list.length)
						selected = (selected - 1 + list.length) % list.length;
					else if (keybindings.matches(data, "tui.select.down") && list.length)
						selected = (selected + 1) % list.length;
					else if (keybindings.matches(data, "tui.select.pageUp")) selected = Math.max(0, selected - MAX_VISIBLE);
					else if (keybindings.matches(data, "tui.select.pageDown"))
						selected = Math.min(Math.max(0, list.length - 1), selected + MAX_VISIBLE);
					else return;
					invalidate();
					tui.requestRender();
				},
				invalidate,
			};
		},
		{ blocked: { kind: "question", message: title } },
	);
}
