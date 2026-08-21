import test from "node:test";
import assert from "node:assert/strict";
import { metricSetEntriesRequest } from "../src/usage/metric-set-fetch.js";

test("nonempty metricSet requests a forced entries fetch with a long timeout", () => {
	assert.deepEqual(metricSetEntriesRequest(1), { timeoutMs: 45_000, force: true });
	assert.deepEqual(metricSetEntriesRequest(3), { timeoutMs: 45_000, force: true });
});

test("empty metricSet does not request a forced entries fetch", () => {
	assert.equal(metricSetEntriesRequest(0), null);
	assert.equal(metricSetEntriesRequest(-1), null);
});
