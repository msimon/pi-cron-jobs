// Network preflight.
//
// launchd fires missed jobs the moment the Mac wakes, usually a few seconds
// before Wi-Fi has reassociated. pi then dies on its first request
// (ENOTFOUND / "Connection error."). Wait a little for the network, and if it
// never shows up, record the run as skipped instead of failed.

import net from "node:net";

export interface NetState {
	online: boolean;
	detail: string;
}

export interface WaitOptions {
	host?: string;
	port?: number;
	maxWaitMs?: number;
	intervalMs?: number;
	probe?: (host: string, port: number) => Promise<string | null>;
}

// Host to reach. PI_CRON_JOBS_NET_HOST=off disables the check.
export function defaultHost(): string {
	return process.env.PI_CRON_JOBS_NET_HOST ?? "api.anthropic.com";
}

// One TCP connect (which includes DNS). Resolves null on success, or the error.
export function probeOnce(host: string, port: number, timeoutMs = 5000): Promise<string | null> {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		const done = (err: string | null) => {
			sock.removeAllListeners();
			sock.destroy();
			resolve(err);
		};
		sock.setTimeout(timeoutMs, () => done(`timed out after ${timeoutMs}ms`));
		sock.once("connect", () => done(null));
		sock.once("error", (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
	});
}

export async function waitForNetwork(opts: WaitOptions = {}): Promise<NetState> {
	const host = opts.host ?? defaultHost();
	if (host === "off") return { online: true, detail: "network check disabled" };
	const port = opts.port ?? 443;
	const maxWaitMs = opts.maxWaitMs ?? 90_000;
	const intervalMs = opts.intervalMs ?? 5_000;
	const probe = opts.probe ?? probeOnce;

	const start = Date.now();
	let attempts = 0;
	let lastErr = "";
	for (;;) {
		attempts++;
		const err = await probe(host, port);
		const waited = Math.round((Date.now() - start) / 1000);
		if (err === null) {
			return {
				online: true,
				detail: attempts === 1 ? `${host} reachable` : `${host} reachable after ${waited}s`,
			};
		}
		lastErr = err;
		if (Date.now() - start + intervalMs > maxWaitMs) {
			return {
				online: false,
				detail: `${host}:${port} unreachable for ${waited}s (${attempts} attempts, last: ${lastErr})`,
			};
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
