// Translate a 5-field POSIX cron expression into launchd StartCalendarInterval
// dicts. launchd has no ranges/lists/steps inside one dict — each dict is a
// concrete time — so we expand to the cartesian product of the restricted
// fields (wildcard fields are simply omitted = "every").

// launchd keys, in cron field order: minute hour day-of-month month day-of-week
const FIELDS: Array<{ key: string; min: number; max: number }> = [
	{ key: "Minute", min: 0, max: 59 },
	{ key: "Hour", min: 0, max: 23 },
	{ key: "Day", min: 1, max: 31 }, // day of month
	{ key: "Month", min: 1, max: 12 },
	{ key: "Weekday", min: 0, max: 7 }, // 0 and 7 = Sunday
];

const MAX_INTERVALS = 500; // guard against explosive expressions

export type CalendarInterval = Record<string, number>;

export interface CronExpansion {
	intervals: CalendarInterval[];
	// cron uses OR when BOTH day-of-month and day-of-week are restricted;
	// launchd uses AND. We flag it so the caller can warn.
	domDowConflict: boolean;
}

// Parse one field into a sorted unique list of numbers, or null for "*".
function parseField(field: string, min: number, max: number): number[] | null {
	if (field === "*") return null;
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const stepMatch = part.match(/^(.+)\/(\d+)$/);
		const step = stepMatch ? Number(stepMatch[2]) : 1;
		const base = stepMatch ? stepMatch[1]! : part;

		let lo: number;
		let hi: number;
		if (base === "*") {
			lo = min;
			hi = max;
		} else if (base.includes("-")) {
			const [a, b] = base.split("-");
			lo = Number(a);
			hi = Number(b);
		} else {
			lo = Number(base);
			hi = Number(base);
		}
		if (!Number.isInteger(lo) || !Number.isInteger(hi) || step < 1)
			throw new Error(`invalid cron field: "${field}"`);
		if (lo < min || hi > max || lo > hi)
			throw new Error(`cron field "${field}" out of range [${min}-${max}]`);
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return [...out].sort((a, b) => a - b);
}

export function expandCron(expr: string): CronExpansion {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5)
		throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);

	const parsed = parts.map((p, i) => parseField(p, FIELDS[i]!.min, FIELDS[i]!.max));
	const domRestricted = parsed[2] !== null;
	const dowRestricted = parsed[4] !== null;

	// estimate product size of restricted fields
	let product = 1;
	for (const vals of parsed) if (vals) product *= vals.length;
	if (product > MAX_INTERVALS)
		throw new Error(
			`cron "${expr}" expands to ${product} launchd entries (> ${MAX_INTERVALS}); use a simpler schedule`,
		);

	// cartesian product over restricted fields; wildcard fields omitted
	let intervals: CalendarInterval[] = [{}];
	for (let i = 0; i < FIELDS.length; i++) {
		const vals = parsed[i];
		if (!vals) continue;
		const key = FIELDS[i]!.key;
		const next: CalendarInterval[] = [];
		for (const base of intervals) {
			for (const v of vals) {
				next.push({ ...base, [key]: v === 7 && key === "Weekday" ? 0 : v });
			}
		}
		intervals = next;
	}

	return { intervals, domDowConflict: domRestricted && dowRestricted };
}

// One-shot: a specific local datetime → a single launchd dict (Month/Day/Hour/
// Minute). launchd will otherwise repeat yearly, so once-jobs self-remove after
// firing (handled by the runner cleanup).
export function onceInterval(at: string): CalendarInterval {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) throw new Error(`invalid --at timestamp: "${at}"`);
	return {
		Month: d.getMonth() + 1,
		Day: d.getDate(),
		Hour: d.getHours(),
		Minute: d.getMinutes(),
	};
}
