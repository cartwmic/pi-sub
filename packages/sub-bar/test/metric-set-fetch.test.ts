import test from "node:test";
import assert from "node:assert/strict";
import { metricSetEntriesRequest, metricSetNeedsRefresh } from "../src/usage/metric-set-fetch.js";
import type { UsageSnapshot } from "../src/types.js";

test("nonempty metricSet requests a forced entries fetch with a long timeout", () => {
	assert.deepEqual(metricSetEntriesRequest(1), { timeoutMs: 45_000, force: true });
	assert.deepEqual(metricSetEntriesRequest(3), { timeoutMs: 45_000, force: true });
});

test("empty metricSet does not request a forced entries fetch", () => {
	assert.equal(metricSetEntriesRequest(0), null);
	assert.equal(metricSetEntriesRequest(-1), null);
});

const metricSet = [
	{ provider: "anthropic" as const },
	{ provider: "cursor" as const },
];

const claude: UsageSnapshot = {
	provider: "anthropic",
	displayName: "Claude",
	windows: [{ label: "5h", usedPercent: 10 }],
	lastSuccessAt: 1_000,
};

test("metricSetNeedsRefresh is true when a listed provider is missing", () => {
	assert.equal(metricSetNeedsRefresh(metricSet, { anthropic: claude }, 1_500, 60_000), true);
});

test("metricSetNeedsRefresh is true when last-good data is older than the TTL", () => {
	assert.equal(
		metricSetNeedsRefresh(
			[{ provider: "anthropic" }],
			{ anthropic: claude },
			1_000 + 60_000,
			60_000,
		),
		true,
	);
});

test("metricSetNeedsRefresh is false when last-good data is still fresh", () => {
	assert.equal(
		metricSetNeedsRefresh(
			[{ provider: "anthropic" }],
			{ anthropic: claude },
			1_000 + 10_000,
			60_000,
		),
		false,
	);
});

test("metricSetNeedsRefresh does not retry expected missing credentials", () => {
	const missing: UsageSnapshot = {
		...claude,
		error: { code: "NO_CREDENTIALS", message: "No credentials found" },
	};
	assert.equal(
		metricSetNeedsRefresh([{ provider: "anthropic" }], { anthropic: missing }, 99_000, 60_000),
		false,
	);
});
