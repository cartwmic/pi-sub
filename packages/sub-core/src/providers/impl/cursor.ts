/**
 * Cursor usage provider
 *
 * Subscription percent comes from GET /api/usage-summary
 * (`individualUsage.plan.totalPercentUsed`). Spend dollars come from team
 * spend, on-demand usage, or GetAggregatedUsageEvents. The spend cap is a
 * usage-based/team limit from Cursor's dashboard APIs (hard-limit, team
 * override/monthly, on-demand limit) — never the included subscription pool
 * and never a compiled default.
 */

import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const USAGE_EVENTS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const PLAN_INFO_URL = "https://cursor.com/api/dashboard/get-plan-info";
const HARD_LIMIT_URL = "https://cursor.com/api/dashboard/get-hard-limit";
const TEAMS_URL = "https://cursor.com/api/dashboard/teams";
const TEAM_URL = "https://cursor.com/api/dashboard/team";
const TEAM_SPEND_URL = "https://cursor.com/api/dashboard/get-team-spend";

type PlanInfoResponse = {
	planInfo?: {
		billingCycleEnd?: string | number;
		billing_cycle_end?: string | number;
		includedAmountCents?: number | string;
		included_amount_cents?: number | string;
	};
	billingCycleEnd?: string | number;
};

type UsageSummaryResponse = {
	billingCycleStart?: string | number;
	billingCycleEnd?: string | number;
	individualUsage?: {
		plan?: {
			used?: number | string;
			limit?: number | string;
			remaining?: number | string;
			totalPercentUsed?: number | string;
			breakdown?: {
				included?: number | string;
				bonus?: number | string;
				total?: number | string;
			};
		};
		onDemand?: {
			enabled?: boolean;
			used?: number | string;
			limit?: number | string;
			remaining?: number | string;
		};
	};
};

type AggregatedUsageResponse = {
	totalCostCents?: number | string;
	total_cost_cents?: number | string;
};

type HardLimitResponse = {
	hardLimit?: number | string;
	hard_limit?: number | string;
	noUsageBasedAllowed?: boolean;
};

type TeamsResponse = {
	teams?: Array<{ id?: number | string }>;
};

type TeamResponse = {
	userId?: number | string;
	user_id?: number | string;
};

type TeamMemberSpend = {
	userId?: number | string;
	user_id?: number | string;
	spendCents?: number | string;
	spend_cents?: number | string;
	hardLimitOverrideDollars?: number | string;
	hard_limit_override_dollars?: number | string;
};

type TeamSpendResponse = {
	teamMemberSpend?: TeamMemberSpend[];
	team_member_spend?: TeamMemberSpend[];
	monthlyLimitDollars?: number | string;
	monthly_limit_dollars?: number | string;
	effectivePerUserLimitDollars?: number | string;
	effective_per_user_limit_dollars?: number | string;
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

function firstPositive(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

function centsToDollars(value: unknown): number | undefined {
	const cents = toFiniteNumber(value);
	if (cents === undefined) return undefined;
	return cents / 100;
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

function cycleStartMs(end: Date): number {
	const start = new Date(end.getTime());
	start.setUTCMonth(start.getUTCMonth() - 1);
	return start.getTime();
}

function dashboardHeaders(token: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Origin: "https://cursor.com",
		Referer: "https://cursor.com/dashboard",
	};
	const userId = userIdFromAccessToken(token);
	if (userId) {
		headers.Cookie = `WorkosCursorSessionToken=${userId}::${token}`;
	}
	return headers;
}

async function requestJson(
	deps: Dependencies,
	url: string,
	headers: Record<string, string>,
	options?: { method?: string; body?: unknown },
): Promise<{ ok: true; data: unknown } | { ok: false; status?: number }> {
	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	const method = options?.method ?? (options?.body === undefined ? "GET" : "POST");
	try {
		const res = await deps.fetch(url, {
			method,
			headers,
			body: options?.body === undefined ? undefined : JSON.stringify(options.body),
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

async function fetchUsageSummary(
	deps: Dependencies,
	token: string,
): Promise<{
	usedPercent?: number;
	billingCycleStart?: Date;
	billingCycleEnd?: Date;
	onDemandEnabled?: boolean;
	onDemandUsedDollars?: number;
	onDemandLimitDollars?: number;
} | undefined> {
	const result = await requestJson(deps, USAGE_SUMMARY_URL, dashboardHeaders(token), { method: "GET" });
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return undefined;
	}

	const data = result.data as UsageSummaryResponse;
	const plan = data.individualUsage?.plan;
	const onDemand = data.individualUsage?.onDemand;
	return {
		usedPercent: toFiniteNumber(plan?.totalPercentUsed),
		billingCycleStart: parseTimestamp(data.billingCycleStart),
		billingCycleEnd: parseTimestamp(data.billingCycleEnd),
		onDemandEnabled: onDemand?.enabled === true,
		onDemandUsedDollars: centsToDollars(onDemand?.used),
		onDemandLimitDollars: firstPositive(centsToDollars(onDemand?.limit)),
	};
}

async function fetchPlanInfo(
	deps: Dependencies,
	token: string,
): Promise<{ billingCycleEnd?: Date; includedDollars?: number }> {
	const result = await requestJson(deps, PLAN_INFO_URL, dashboardHeaders(token), { method: "POST", body: {} });
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return {};
	}

	const data = result.data as PlanInfoResponse;
	const rawEnd = data.planInfo?.billingCycleEnd ?? data.planInfo?.billing_cycle_end ?? data.billingCycleEnd;
	const includedCents = data.planInfo?.includedAmountCents ?? data.planInfo?.included_amount_cents;
	return {
		billingCycleEnd: parseTimestamp(rawEnd),
		includedDollars: centsToDollars(includedCents),
	};
}

async function fetchHardLimit(
	deps: Dependencies,
	token: string,
	teamId?: number,
): Promise<number | undefined> {
	const body = teamId === undefined ? {} : { teamId };
	const result = await requestJson(deps, HARD_LIMIT_URL, dashboardHeaders(token), { method: "POST", body });
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return undefined;
	}
	const data = result.data as HardLimitResponse;
	return firstPositive(toFiniteNumber(data.hardLimit), toFiniteNumber(data.hard_limit));
}

async function fetchTeamId(deps: Dependencies, token: string): Promise<number | undefined> {
	const result = await requestJson(deps, TEAMS_URL, dashboardHeaders(token), { method: "POST", body: {} });
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return undefined;
	}
	const teams = (result.data as TeamsResponse).teams;
	if (!Array.isArray(teams)) return undefined;
	for (const team of teams) {
		const id = toFiniteNumber(team?.id);
		if (id !== undefined) return id;
	}
	return undefined;
}

async function fetchTeamUserId(
	deps: Dependencies,
	token: string,
	teamId: number,
): Promise<number | undefined> {
	const result = await requestJson(deps, TEAM_URL, dashboardHeaders(token), {
		method: "POST",
		body: { teamId },
	});
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return undefined;
	}
	const data = result.data as TeamResponse;
	return toFiniteNumber(data.userId) ?? toFiniteNumber(data.user_id);
}

async function fetchTeamSpend(
	deps: Dependencies,
	token: string,
	teamId: number,
	userId?: number,
): Promise<{ usedDollars?: number; overrideDollars?: number; monthlyDollars?: number }> {
	const result = await requestJson(deps, TEAM_SPEND_URL, dashboardHeaders(token), {
		method: "POST",
		body: { teamId },
	});
	if (!result.ok || !result.data || typeof result.data !== "object") {
		return {};
	}

	const data = result.data as TeamSpendResponse;
	const members = data.teamMemberSpend ?? data.team_member_spend ?? [];
	const member = userId === undefined
		? undefined
		: members.find((entry) => (toFiniteNumber(entry.userId) ?? toFiniteNumber(entry.user_id)) === userId);

	return {
		usedDollars: centsToDollars(member?.spendCents ?? member?.spend_cents),
		overrideDollars: firstPositive(
			toFiniteNumber(member?.hardLimitOverrideDollars),
			toFiniteNumber(member?.hard_limit_override_dollars),
		),
		monthlyDollars: firstPositive(
			toFiniteNumber(data.effectivePerUserLimitDollars),
			toFiniteNumber(data.effective_per_user_limit_dollars),
			toFiniteNumber(data.monthlyLimitDollars),
			toFiniteNumber(data.monthly_limit_dollars),
		),
	};
}

async function fetchAggregatedUsage(
	deps: Dependencies,
	token: string,
	cycleEnd?: Date,
	cycleStart?: Date,
): Promise<{ ok: true; totalCostCents: number } | { ok: false; status?: number }> {
	const body: Record<string, number> = {};
	if (cycleEnd) {
		body.startDate = cycleStart?.getTime() ?? cycleStartMs(cycleEnd);
		body.endDate = cycleEnd.getTime();
	}

	const result = await requestJson(
		deps,
		USAGE_EVENTS_URL,
		{
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
		},
		{ method: "POST", body },
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

		const [summary, plan, personalHardLimit, teamId] = await Promise.all([
			fetchUsageSummary(deps, token),
			fetchPlanInfo(deps, token),
			fetchHardLimit(deps, token),
			fetchTeamId(deps, token),
		]);

		let teamHardLimit: number | undefined;
		let teamSpend: { usedDollars?: number; overrideDollars?: number; monthlyDollars?: number } = {};
		if (teamId !== undefined) {
			const teamUserId = await fetchTeamUserId(deps, token, teamId);
			const [hardLimit, spend] = await Promise.all([
				fetchHardLimit(deps, token, teamId),
				fetchTeamSpend(deps, token, teamId, teamUserId),
			]);
			teamHardLimit = hardLimit;
			teamSpend = spend;
		}

		const billingCycleEnd = summary?.billingCycleEnd ?? plan.billingCycleEnd;
		const billingCycleStart = summary?.billingCycleStart;
		const usage = await fetchAggregatedUsage(deps, token, billingCycleEnd, billingCycleStart);

		const onDemandEnabled = summary?.onDemandEnabled === true;
		const usedAmount =
			teamSpend.usedDollars !== undefined && Number.isFinite(teamSpend.usedDollars)
				? teamSpend.usedDollars
				: onDemandEnabled && summary?.onDemandUsedDollars !== undefined
					? summary.onDemandUsedDollars
					: usage.ok
						? usage.totalCostCents / 100
						: undefined;

		// Included/bonus pool dollars are subscription usage, not a spend cap.
		const capAmount = firstPositive(
			teamSpend.overrideDollars,
			teamHardLimit,
			teamSpend.monthlyDollars,
			personalHardLimit,
			onDemandEnabled ? summary?.onDemandLimitDollars : undefined,
		);

		const usedPercent = summary?.usedPercent !== undefined
			? summary.usedPercent
			: usedAmount !== undefined && capAmount !== undefined
				? (usedAmount / capAmount) * 100
				: 0;

		if (!summary && !usage.ok && usedAmount === undefined) {
			return usage.status ? this.emptySnapshot(httpError(usage.status)) : this.emptySnapshot(fetchFailed());
		}

		const resetAt = billingCycleEnd;
		const window: RateWindow = {
			label: "",
			usedPercent,
			usedAmount,
			capAmount,
			resetDescription: resetAt ? formatReset(resetAt) : undefined,
			resetAt: resetAt?.toISOString(),
		};

		return this.snapshot({ windows: [window] });
	}
}
