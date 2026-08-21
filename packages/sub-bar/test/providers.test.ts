import test from "node:test";
import assert from "node:assert/strict";
import { getUsageExtras } from "../src/providers/extras.js";
import { shouldShowWindow } from "../src/providers/windows.js";
import { getDefaultSettings } from "../src/settings-types.js";
import type { UsageSnapshot } from "../src/types.js";

function buildCopilotUsage(): UsageSnapshot {
	return {
		provider: "copilot",
		displayName: "GitHub Copilot",
		windows: [],
		requestsRemaining: 100,
		requestsEntitlement: 200,
	};
}

test("copilot extras include multiplier and requests left", () => {
	const settings = getDefaultSettings();
	settings.providers.copilot.showMultiplier = true;
	settings.providers.copilot.showRequestsLeft = true;

	const extras = getUsageExtras(buildCopilotUsage(), settings, "GPT-4o");
	assert.equal(extras.length, 1);
	assert.ok(extras[0].label.includes("Model multiplier: 0x"));
	assert.ok(extras[0].label.includes("req. left"));
});

test("copilot extras respect toggle settings", () => {
	const settings = getDefaultSettings();
	settings.providers.copilot.showMultiplier = false;

	const extras = getUsageExtras(buildCopilotUsage(), settings, "GPT-4o");
	assert.equal(extras.length, 0);

	settings.providers.copilot.showMultiplier = true;
	settings.providers.copilot.showRequestsLeft = false;

	const withMultiplierOnly = getUsageExtras(buildCopilotUsage(), settings, "GPT-4o");
	assert.equal(withMultiplierOnly.length, 1);
	assert.ok(withMultiplierOnly[0].label.includes("Model multiplier: 0x"));
	assert.ok(!withMultiplierOnly[0].label.includes("req. left"));
});

test("cursor bar defaults are UI-only with no cap field", () => {
	const settings = getDefaultSettings();
	const cursor = settings.providers.cursor;
	assert.equal(cursor.showStatus, true);
	assert.equal(cursor.windows.showCycle, true);
	assert.deepEqual(Object.keys(cursor).sort(), ["showStatus", "windows"]);
	assert.deepEqual(Object.keys(cursor.windows), ["showCycle"]);
});

test("cursor cycle window visibility follows the single window flag", () => {
	const settings = getDefaultSettings();
	const usage: UsageSnapshot = {
		provider: "cursor",
		displayName: "Cursor Plan",
		windows: [{ label: "$12.34", usedPercent: 0, usedAmount: 12.34 }],
	};

	assert.equal(shouldShowWindow(usage, usage.windows[0], settings), true);
	settings.providers.cursor.windows.showCycle = false;
	assert.equal(shouldShowWindow(usage, usage.windows[0], settings), false);
});
