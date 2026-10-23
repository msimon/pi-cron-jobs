// Awake-time accounting for a running job.
//
// The Mac can go to sleep while a job runs (lid closed after a 09:15 run
// starts). A wall-clock timeout then fires the moment it wakes, killing a run
// that has had only a minute or two of CPU -- the ledger is full of
// `timeout` runs with `stdout=0B` whose 60s heartbeats are 15+ minutes apart.
//
// Timers do not fire while asleep, so a long gap between ticks of a short
// interval is time spent asleep. Subtract it, and the timeout applies to time
// the job could actually work.

export const TICK_MS = 5_000;
// A tick this late means the process was suspended, not just busy.
export const SLEEP_GAP_MS = 30_000;

export class AwakeClock {
	private last: number;
	private sleptMs = 0;
	private naps = 0;

	constructor(
		private readonly start: number,
		private readonly tickMs = TICK_MS,
		private readonly gapMs = SLEEP_GAP_MS,
	) {
		this.last = start;
	}

	// Call on every tick. Returns how long the machine slept since the previous
	// tick (0 if it did not).
	tick(now: number): number {
		const gap = now - this.last;
		this.last = now;
		if (gap <= this.gapMs) return 0;
		const nap = gap - this.tickMs;
		this.sleptMs += nap;
		this.naps++;
		return nap;
	}

	awakeMs(now: number): number {
		return now - this.start - this.sleptMs;
	}

	get slept(): number {
		return this.sleptMs;
	}

	get napCount(): number {
		return this.naps;
	}
}

export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
