import test from "node:test";
import assert from "node:assert/strict";
import { mergeUsageEntries, pickUsageSnapshot } from "../src/usage/entries.js";
import type { UsageSnapshot } from "../src/types.js";

function claude(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		provider: "anthropic",
		displayName: "Anthropic (Claude)",
		windows: [
			{ label: "5h", usedPercent: 10, resetDescription: "4h" },
			{ label: "Week", usedPercent: 20, resetDescription: "6d" },
		],
		lastSuccessAt: 1_000,
		...overrides,
	};
}

function cursor(): UsageSnapshot {
	return {
		provider: "cursor",
		displayName: "Cursor Plan",
		windows: [{ label: "", usedPercent: 34 }],
		lastSuccessAt: 1_000,
	};
}

test("merge keeps last-good when a provider is omitted from the incoming payload", () => {
	const previous = { anthropic: claude(), cursor: cursor() };
	const next = mergeUsageEntries(previous, [
		{ provider: "cursor", usage: cursor() },
	]);
	assert.equal(next.anthropic, previous.anthropic);
	assert.ok(next.cursor);
});

test("merge keeps last-good on transient error without windows", () => {
	const previous = { anthropic: claude() };
	const failed: UsageSnapshot = {
		provider: "anthropic",
		displayName: "Anthropic (Claude)",
		windows: [],
		error: { code: "FETCH_FAILED", message: "Fetch failed" },
	};
	const next = mergeUsageEntries(previous, [{ provider: "anthropic", usage: failed }]);
	assert.equal(next.anthropic, previous.anthropic);
	assert.equal(next.anthropic?.windows.length, 2);
});

test("merge replaces last-good when credentials are gone", () => {
	const previous = { anthropic: claude() };
	const missing: UsageSnapshot = {
		provider: "anthropic",
		displayName: "Anthropic (Claude)",
		windows: [],
		error: { code: "NO_CREDENTIALS", message: "No credentials found" },
	};
	const next = mergeUsageEntries(previous, [{ provider: "anthropic", usage: missing }]);
	assert.equal(next.anthropic?.error?.code, "NO_CREDENTIALS");
});

test("merge keeps previous when incoming entries are undefined", () => {
	const previous = { anthropic: claude() };
	assert.equal(mergeUsageEntries(previous, undefined), previous);
});

test("pickUsageSnapshot prefers incoming windows even if a fetch error is attached", () => {
	const previous = claude();
	const incoming = claude({
		windows: [{ label: "5h", usedPercent: 12, resetDescription: "3h" }],
		error: { code: "HTTP_ERROR", message: "HTTP 401", httpStatus: 401 },
		lastSuccessAt: 2_000,
	});
	const picked = pickUsageSnapshot(previous, incoming);
	assert.equal(picked.windows[0]?.usedPercent, 12);
	assert.equal(picked.error?.httpStatus, 401);
});
