import test from "node:test";
import assert from "node:assert/strict";
import { runCaught } from "../src/run-caught.js";

test("runCaught swallows an async rejection instead of leaving it unhandled", async () => {
	const logged: unknown[][] = [];
	const original = console.error;
	const unhandled: unknown[] = [];
	const onUnhandled = (err: unknown) => {
		unhandled.push(err);
	};
	process.on("unhandledRejection", onUnhandled);
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
	try {
		runCaught("[pi-sub-bar] test", Promise.reject(new Error("boom")));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled.length, 0);
		assert.equal(logged.length, 1);
		assert.equal(logged[0]?.[0], "[pi-sub-bar] test");
		assert.equal((logged[0]?.[1] as Error).message, "boom");
	} finally {
		console.error = original;
		process.off("unhandledRejection", onUnhandled);
	}
});
