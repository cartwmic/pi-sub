/**
 * Cursor usage provider
 */

import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

const USAGE_EVENTS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const PLAN_INFO_URL = "https://cursor.com/api/dashboard/get-plan-info";

type PlanInfoResponse = {
	planInfo?: {
		billingCycleEnd?: string | number;
		billing_cycle_end?: string | number;
	};
	billingCycleEnd?: string | number;
};

type AggregatedUsageResponse = {
	totalCostCents?: number | string;
	total_cost_cents?: number | string;
};

function loadCursorAccess(deps: Dependencies): string | undefined {
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			const access = data.cursor?.access;
			if (typeof access === "string" && access.trim()) {
				return access.trim();
			}
		}
	} catch {
		// Ignore parse errors
	}

	return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length < 2 || !parts[1]) return undefined;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const pad = "=".repeat((4 - (padded.length % 4)) % 4);
		const json = Buffer.from(padded + pad, "base64").toString("utf8");
		const payload = JSON.parse(json) as unknown;
		if (payload && typeof payload === "object") {
			return payload as Record<string, unknown>;
		}
	} catch {
		// Ignore malformed tokens
	}
	return undefined;
}

function userIdFromAccessToken(token: string): string | undefined {
	const sub = decodeJwtPayload(token)?.sub;
	return typeof sub === "string" && sub.trim() ? sub.trim() : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseTimestamp(value: unknown): Date | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value < 1e12 ? value * 1000 : value;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	if (typeof value === "string" && value.trim()) {
		if (/^\d+$/.test(value.trim())) {
			return parseTimestamp(Number(value.trim()));
		}
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	return undefined;
}

function formatDollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function cycleStartMs(end: Date): number {
	const start = new Date(end.getTime());
	start.setUTCMonth(start.getUTCMonth() - 1);
	return start.getTime();
}

async function postJson(
	deps: Dependencies,
	url: string,
	headers: Record<string, string>,
	body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; status?: number }> {
	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		const res = await deps.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clear();
		if (!res.ok) {
			return { ok: false, status: res.status };
		}
		return { ok: true, data: await res.json() };
	} catch {
		clear();
		return { ok: false };
	}
}

async function fetchPlanInfo(
	deps: Dependencies,
	token: string,
): Promise<{ billingCycleEnd?: Date }> {
	const userId = userIdFromAccessToken(token);
	if (!userId) return {};

	const result = await postJson(
		deps,
		PLAN_INFO_URL,
		{
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Origin: "https://cursor.com",
			Referer: "https://cursor.com/dashboard",
			Cookie: `WorkosCursorSessionToken=${userId}::${token}`,
		},
		{},
	);
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return {};
	}

	const data = result.data as PlanInfoResponse;
	const rawEnd = data.planInfo?.billingCycleEnd ?? data.planInfo?.billing_cycle_end ?? data.billingCycleEnd;
	return { billingCycleEnd: parseTimestamp(rawEnd) };
}

async function fetchAggregatedUsage(
	deps: Dependencies,
	token: string,
	cycleEnd?: Date,
): Promise<{ ok: true; totalCostCents: number } | { ok: false; status?: number }> {
	const body: Record<string, number> = {};
	if (cycleEnd) {
		body.startDate = cycleStartMs(cycleEnd);
		body.endDate = cycleEnd.getTime();
	}

	const result = await postJson(
		deps,
		USAGE_EVENTS_URL,
		{
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
		},
		body,
	);
	if (!result.ok) {
		return { ok: false, status: result.status };
	}
	if (!result.data || typeof result.data !== "object") {
		return { ok: false };
	}

	const data = result.data as AggregatedUsageResponse;
	const totalCostCents = toFiniteNumber(data.totalCostCents) ?? toFiniteNumber(data.total_cost_cents) ?? 0;
	return { ok: true, totalCostCents };
}

export class CursorProvider extends BaseProvider {
	readonly name = "cursor" as const;
	readonly displayName = "Cursor Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadCursorAccess(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const token = loadCursorAccess(deps);
		if (!token) {
			return this.emptySnapshot(noCredentials());
		}

		const plan = await fetchPlanInfo(deps, token);
		const usage = await fetchAggregatedUsage(deps, token, plan.billingCycleEnd);
		if (!usage.ok) {
			return usage.status ? this.emptySnapshot(httpError(usage.status)) : this.emptySnapshot(fetchFailed());
		}

		const usedDollars = usage.totalCostCents / 100;
		const resetAt = plan.billingCycleEnd;

		const window: RateWindow = {
			label: formatDollars(usedDollars),
			usedPercent: 0,
			usedAmount: usedDollars,
			resetDescription: resetAt ? formatReset(resetAt) : undefined,
			resetAt: resetAt?.toISOString(),
		};

		return this.snapshot({ windows: [window] });
	}
}
