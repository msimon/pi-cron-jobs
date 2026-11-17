// Read-only live view of a run in flight, for /jobs. Polls the run's
// conversation file (pi appends one entry per finished message) and shows the
// prompt, the assistant's text, tool calls and the head of each tool result.
// Before the conversation file exists it shows the tail of the run log. When
// the run ends, the header switches to its final status from the ledger.
// ↑/↓ and PgUp/PgDn scroll (and stop following), End follows again, Esc closes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as store from "../src/core/store";
import type { Execution, RunningExecution } from "../src/core/types";

const POLL_MS = 1000;
const RESULT_LINES = 4; // head of each tool result
const THINKING_LINES = 2;
const PROMPT_LINES = 8;
const LOG_TAIL = 200;

export function fmtElapsed(startedAt: string, now = Date.now()): string {
	const secs = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${secs % 60}s`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

type Style = "text" | "dim" | "muted" | "accent" | "error" | "success";
type Block = { style: Style; text: string };

function headLines(text: string, max: number): string {
	const lines = text.replace(/\s+$/, "").split("\n");
	if (lines.length <= max) return lines.join("\n");
	return `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

function toolSummary(args: any): string {
	if (!args || typeof args !== "object") return "";
	const main = args.command ?? args.path ?? args.url ?? args.pattern ?? args.query ?? args.code;
	if (typeof main === "string") return main.replace(/\s+/g, " ");
	if (Array.isArray(args.args)) return args.args.join(" ");
	return JSON.stringify(args);
}

// One conversation file → display blocks. Pure, so it is testable.
export function sessionBlocks(jsonl: string): Block[] {
	const blocks: Block[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a half-written last line
		}
		if (entry?.type !== "message") continue;
		const msg = entry.message ?? {};
		if (msg.role === "user") {
			blocks.push({ style: "accent", text: `▸ ${headLines(textOf(msg.content), PROMPT_LINES)}` });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c?.type === "text" && c.text?.trim()) blocks.push({ style: "text", text: c.text.trim() });
				else if (c?.type === "thinking" && c.thinking?.trim())
					blocks.push({ style: "dim", text: headLines(c.thinking.trim(), THINKING_LINES) });
				else if (c?.type === "toolCall")
					blocks.push({ style: "muted", text: `→ ${c.name}: ${toolSummary(c.arguments).slice(0, 300)}` });
			}
			if (msg.stopReason === "error" && msg.errorMessage)
				blocks.push({ style: "error", text: `✗ ${msg.errorMessage}` });
		} else if (msg.role === "toolResult") {
			const out = headLines(textOf(msg.content), RESULT_LINES);
			if (out) blocks.push({ style: msg.isError ? "error" : "dim", text: out.replace(/^/gm, "  ") });
		}
	}
	return blocks;
}

function logBlocks(logPath: string): Block[] {
	if (!existsSync(logPath)) return [{ style: "dim", text: "Starting… (no conversation or log yet)" }];
	const lines = readFileSync(logPath, "utf8").replace(/\s+$/, "").split("\n").slice(-LOG_TAIL);
	return [
		{ style: "dim", text: "No conversation yet — run log so far:" },
		{ style: "muted", text: lines.join("\n") },
	];
}

export interface WatchOptions {
	jobName: string;
	run: RunningExecution;
	sessionFile: () => string | null;
}

export function watchExecution(ctx: any, opts: WatchOptions): Promise<void> {
	const { run } = opts;
	return ctx.ui.custom(
		(tui: any, theme: any, keybindings: any, done: (r: undefined) => void) => {
			let blocks: Block[] = [];
			let sourceKey = ""; // path + size + mtime of what blocks were built from
			let final: Execution | undefined;
			let top = 0;
			let follow = true;
			let cachedWidth: number | undefined;
			let cachedBody: string[] | undefined;

			const refresh = () => {
				const file = opts.sessionFile();
				const src = file ?? run.logPath;
				let key = src;
				try {
					const st = statSync(src);
					key = `${src}:${st.size}:${st.mtimeMs}`;
				} catch {
					// not there yet
				}
				if (key !== sourceKey) {
					sourceKey = key;
					try {
						blocks = file ? sessionBlocks(readFileSync(file, "utf8")) : logBlocks(run.logPath);
					} catch {
						// mid-write; next tick
					}
					cachedBody = undefined;
				}
				if (!final && !store.runningExecutions().some((r) => r.executionId === run.executionId)) {
					final = store.readExecutions().find((e) => e.executionId === run.executionId);
				}
			};

			refresh();
			const timer = setInterval(() => {
				try {
					refresh();
					tui.requestRender();
				} catch {
					// keep the view open; the next tick tries again
				}
			}, POLL_MS);
			timer.unref?.();
			const close = () => {
				clearInterval(timer);
				done(undefined);
			};

			const bodyHeight = () => Math.max(5, Math.floor((tui.terminal?.rows ?? 30) * 0.85) - 5);

			const body = (width: number): string[] => {
				if (cachedBody && cachedWidth === width) return cachedBody;
				const out: string[] = [];
				for (const b of blocks) {
					for (const line of wrapTextWithAnsi(b.text, Math.max(10, width - 2)))
						out.push(` ${theme.fg(b.style, line)}`);
					out.push("");
				}
				if (!blocks.length) out.push(theme.fg("dim", " Waiting for the first message…"));
				cachedWidth = width;
				cachedBody = out;
				return out;
			};

			const status = (): string => {
				if (final) {
					const reason = final.reason ? ` — ${final.reason}` : "";
					const color = final.status === "success" ? "success" : final.status === "skipped" ? "warning" : "error";
					return theme.fg(color, `finished: ${final.status}${reason}`);
				}
				const gone = !store.runningExecutions().some((r) => r.executionId === run.executionId);
				return gone
					? theme.fg("warning", "ended (no result recorded)")
					: theme.fg("accent", `▶ running ${fmtElapsed(run.startedAt)}`);
			};

			return {
				render(width: number): string[] {
					const lines = body(width);
					const h = bodyHeight();
					const maxTop = Math.max(0, lines.length - h);
					top = follow ? maxTop : Math.min(top, maxTop);
					const view = lines.slice(top, top + h);
					while (view.length < h) view.push("");
					const pos = lines.length > h ? ` · ${top + 1}-${Math.min(lines.length, top + h)}/${lines.length}` : "";
					return [
						`${theme.fg("accent", theme.bold(`Watching ${opts.jobName}`))} · ${status()}`,
						theme.fg("dim", "─".repeat(Math.max(1, width))),
						...view,
						theme.fg("dim", "─".repeat(Math.max(1, width))),
						theme.fg(
							"dim",
							`↑/↓ scroll · pgup/pgdn · end follow${follow ? " (on)" : ""} · esc close · read-only${pos}`,
						),
					].map((l) => truncateToWidth(l, width));
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.cancel") || data === "q") return close();
					const h = bodyHeight();
					if (keybindings.matches(data, "tui.select.up")) {
						follow = false;
						top = Math.max(0, top - 1);
					} else if (keybindings.matches(data, "tui.select.down")) {
						top += 1; // render clamps
					} else if (keybindings.matches(data, "tui.select.pageUp")) {
						follow = false;
						top = Math.max(0, top - h);
					} else if (keybindings.matches(data, "tui.select.pageDown")) {
						top += h;
					} else if (matchesKey(data, Key.end)) {
						follow = true;
					} else if (matchesKey(data, Key.home)) {
						follow = false;
						top = 0;
					} else return;
					tui.requestRender();
				},
				invalidate() {
					cachedWidth = undefined;
					cachedBody = undefined;
				},
				dispose() {
					clearInterval(timer);
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
	);
}
