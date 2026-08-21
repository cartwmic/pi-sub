import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/impl/anthropic.js";
import { CopilotProvider } from "../src/providers/impl/copilot.js";
import { GeminiProvider } from "../src/providers/impl/gemini.js";
import { AntigravityProvider } from "../src/providers/impl/antigravity.js";
import { CodexProvider } from "../src/providers/impl/codex.js";
import { KiroProvider } from "../src/providers/impl/kiro.js";
import { ZaiProvider } from "../src/providers/impl/zai.js";
import { CursorProvider } from "../src/providers/impl/cursor.js";
import { createDeps, createJsonResponse, getAuthPath } from "./helpers.js";
import type { UsageSnapshot } from "../src/types.js";

function withAuth(files: Map<string, string>, payload: Record<string, unknown>, home: string): void {
	files.set(getAuthPath(home), JSON.stringify(payload));
}

function assertWindow(usage: UsageSnapshot, label: string): void {
	const found = usage.windows.find((window) => window.label === label);
	assert.ok(found, `Expected window ${label}`);
}

test("anthropic reads token from ANTHROPIC_OAUTH_TOKEN env var", async () => {
	const provider = new AnthropicProvider();
	let authorization: string | undefined;

	const { deps } = createDeps({
		env: { ANTHROPIC_OAUTH_TOKEN: "env-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({});
		},
		execFileSync: () => "",
	});

	await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer env-token");
});

test("anthropic env token overrides auth.json", async () => {
	const provider = new AnthropicProvider();
	let authorization: string | undefined;

	const { deps, files } = createDeps({
		env: { ANTHROPIC_OAUTH_TOKEN: "env-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({});
		},
		execFileSync: () => "",
	});
	withAuth(files, { anthropic: { access: "file-token" } }, deps.homedir());

	await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer env-token");
});

test("anthropic parses windows and extra usage", async () => {
	const provider = new AnthropicProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			five_hour: { utilization: 99, resets_at: new Date(Date.now() + 3600_000).toISOString() },
			seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400_000).toISOString() },
			extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, utilization: 40 },
		}),
		execFileSync: () => "",
	});
	withAuth(files, { anthropic: { access: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "5h");
	assertWindow(usage, "Week");
	const extra = usage.windows.find((window) => window.label.startsWith("Extra"));
	assert.ok(extra?.label.includes("Extra [active]"));
	assert.equal(usage.extraUsageEnabled, true);
});

test("copilot reads token from GITHUB_TOKEN env var", async () => {
	const provider = new CopilotProvider();
	let authorization: string | undefined;

	const { deps } = createDeps({
		env: { GITHUB_TOKEN: "gh-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({});
		},
	});

	await provider.fetchUsage(deps);
	assert.equal(authorization, "token gh-token");
});

test("gemini reads token from GOOGLE_GEMINI_CLI_OAUTH_TOKEN env var", async () => {
	const provider = new GeminiProvider();
	let authorization: string | undefined;

	const { deps } = createDeps({
		env: { GOOGLE_GEMINI_CLI_OAUTH_TOKEN: "g-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({ buckets: [] });
		},
	});

	await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer g-token");
});

test("antigravity reads token from GOOGLE_ANTIGRAVITY_OAUTH_TOKEN env var", async () => {
	const provider = new AntigravityProvider();
	let authorization: string | undefined;

	const { deps } = createDeps({
		env: { GOOGLE_ANTIGRAVITY_OAUTH_TOKEN: "ag-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({ models: {} });
		},
	});

	await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer ag-token");
});

test("codex reads token from OPENAI_CODEX_OAUTH_TOKEN env var", async () => {
	const provider = new CodexProvider();
	let authorization: string | undefined;
	let accountIdHeader: string | undefined;

	const { deps } = createDeps({
		env: { OPENAI_CODEX_OAUTH_TOKEN: "c-token", OPENAI_CODEX_ACCOUNT_ID: "acct_123" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			accountIdHeader = (init as any)?.headers?.["ChatGPT-Account-Id"];
			return createJsonResponse({
				rate_limit: {
					primary_window: { reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 10800, used_percent: 12 },
					secondary_window: { reset_at: Math.floor(Date.now() / 1000) + 86400, limit_window_seconds: 86400, used_percent: 34 },
				},
			});
		},
	});

	const usage = await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer c-token");
	assert.equal(accountIdHeader, "acct_123");
	assertWindow(usage, "3h");
	assertWindow(usage, "Day");
});

test("zai reads token from ZAI_API_KEY env var", async () => {
	const provider = new ZaiProvider();
	let authorization: string | undefined;

	const { deps } = createDeps({
		env: { ZAI_API_KEY: "z-token" },
		fetch: async (_url, init) => {
			authorization = (init as any)?.headers?.Authorization;
			return createJsonResponse({ success: true, code: 200, data: { limits: [] } });
		},
	});

	await provider.fetchUsage(deps);
	assert.equal(authorization, "Bearer z-token");
});

test("copilot handles missing quota snapshots", async () => {
	const provider = new CopilotProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({}),
	});
	withAuth(files, { "github-copilot": { refresh: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows.length, 0);
});

test("copilot parses quotas and requests", async () => {
	const provider = new CopilotProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			quota_reset_date_utc: "2026-01-01T00:00:00Z",
			quota_snapshots: {
				premium_interactions: {
					percent_remaining: 70,
					remaining: 10,
					entitlement: 50,
				},
			},
		}),
	});
	withAuth(files, { "github-copilot": { refresh: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "Month");
	assert.equal(usage.windows[0]?.usedPercent, 30);
	assert.equal(usage.requestsRemaining, 10);
	assert.equal(usage.requestsEntitlement, 50);
});

test("copilot reports http errors", async () => {
	const provider = new CopilotProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({}, { ok: false, status: 500 }),
	});
	withAuth(files, { "github-copilot": { refresh: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error?.code, "HTTP_ERROR");
});

test("gemini handles empty buckets", async () => {
	const provider = new GeminiProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({ buckets: [] }),
	});
	withAuth(files, { "google-gemini-cli": { access: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows.length, 0);
});

test("gemini aggregates pro and flash quotas", async () => {
	const provider = new GeminiProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			buckets: [
				{ modelId: "Gemini Pro", remainingFraction: 0.2 },
				{ modelId: "Gemini Flash", remainingFraction: 0.6 },
			],
		}),
	});
	withAuth(files, { "google-gemini-cli": { access: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "Pro");
	assertWindow(usage, "Flash");
});

test("antigravity falls back to unknown model labels", async () => {
	const provider = new AntigravityProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			models: {
				"1": { displayName: "Unknown A", quotaInfo: { remainingFraction: 0.8 } },
				"2": { displayName: "Unknown B", quotaInfo: { remainingFraction: 0.7 } },
			},
		}),
	});
	withAuth(files, { "google-antigravity": { access: "token" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.ok(usage.windows.some((window) => window.label === "Unknown A"));
	assert.ok(usage.windows.some((window) => window.label === "Unknown B"));
});

test("codex formats primary and secondary windows", async () => {
	const provider = new CodexProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			rate_limit: {
				primary_window: {
					reset_at: Math.floor(Date.now() / 1000) + 3600,
					limit_window_seconds: 18000,
					used_percent: 12,
				},
				secondary_window: {
					reset_at: Math.floor(Date.now() / 1000) + 86400,
					limit_window_seconds: 86400,
					used_percent: 30,
				},
			},
		}),
	});
	withAuth(files, { "openai-codex": { access: "token", accountId: "acct" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "5h");
	assertWindow(usage, "Day");
});

test("codex includes additional rate limits for model-specific usage", async () => {
	const provider = new CodexProvider();
	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({
			rate_limit: {
				primary_window: {
					reset_at: Math.floor(Date.now() / 1000) + 3600,
					limit_window_seconds: 3600,
					used_percent: 12,
				},
			},
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3-Codex-Spark",
					rate_limit: {
						primary_window: {
							reset_at: Math.floor(Date.now() / 1000) + 1800,
							limit_window_seconds: 18000,
							used_percent: 1,
						},
						secondary_window: {
							reset_at: Math.floor(Date.now() / 1000) + 1800 + 604_800,
							limit_window_seconds: 604_800,
							used_percent: 2,
						},
					},
				},
			],
		}),
	});
	withAuth(files, { "openai-codex": { access: "token", accountId: "acct" } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "1h");
	assertWindow(usage, "GPT-5.3-Codex-Spark 5h");
	assertWindow(usage, "GPT-5.3-Codex-Spark Week");
});

test("kiro parses percentage and reset date", async () => {
	const provider = new KiroProvider();
	const output = "██████ 12%\nresets on 01/01";
	const { deps } = createDeps({
		execFileSync: (file: string, args: string[]) => {
			if (file === "which" && args[0] === "kiro-cli") return "/usr/local/bin/kiro-cli";
			if (file === "/usr/local/bin/kiro-cli" && args[0] === "whoami") return "user";
			if (file === "/usr/local/bin/kiro-cli" && args[0] === "chat") return output;
			throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
		},
	});

	const usage = await provider.fetchUsage(deps);
	assertWindow(usage, "Credits");
	assert.equal(usage.windows[0]?.usedPercent, 12);
	assert.ok(usage.windows[0]?.resetAt);
});

test("kiro parses credits when percent is missing", async () => {
	const provider = new KiroProvider();
	const output = "(1.5 of 10 covered in plan) resets on 12/31";
	const { deps } = createDeps({
		execFileSync: (file: string, args: string[]) => {
			if (file === "which" && args[0] === "kiro-cli") return "/usr/local/bin/kiro-cli";
			if (file === "/usr/local/bin/kiro-cli" && args[0] === "whoami") return "user";
			if (file === "/usr/local/bin/kiro-cli" && args[0] === "chat") return output;
			throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
		},
	});

	const usage = await provider.fetchUsage(deps);
	assert.equal(Math.round(usage.windows[0]?.usedPercent ?? 0), 15);
});

test("zai reports api errors and parses limits", async () => {
	const provider = new ZaiProvider();
	const home = "/home/test";
	const authPath = getAuthPath(home);

	const { deps, files } = createDeps({
		fetch: async () => createJsonResponse({ success: false, code: 500, msg: "Bad" }),
		homedir: home,
	});
	files.set(authPath, JSON.stringify({ "z-ai": { access: "token" } }));
	const errorUsage = await provider.fetchUsage(deps);
	assert.equal(errorUsage.error?.code, "API_ERROR");

	const { deps: okDeps, files: okFiles } = createDeps({
		fetch: async () => createJsonResponse({
			success: true,
			code: 200,
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime: "2026-01-01T00:00:00Z" },
					{ type: "TIME_LIMIT", percentage: 34, nextResetTime: "2026-02-01T00:00:00Z" },
				],
			},
		}),
		homedir: home,
	});
	okFiles.set(authPath, JSON.stringify({ "zai": { access: "token" } }));

	const usage = await provider.fetchUsage(okDeps);
	assertWindow(usage, "Tokens");
	assertWindow(usage, "Monthly");
});

function cursorAccessToken(sub = "user-1"): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
	return `${header}.${payload}.sig`;
}

test("cursor has credentials only from nonempty auth.json cursor.access", () => {
	const provider = new CursorProvider();
	const { deps, files } = createDeps();
	assert.equal(provider.hasCredentials(deps), false);

	withAuth(files, { cursor: { access: "   " } }, deps.homedir());
	assert.equal(provider.hasCredentials(deps), false);

	withAuth(files, { anthropic: { access: "other" } }, deps.homedir());
	assert.equal(provider.hasCredentials(deps), false);

	withAuth(files, { cursor: { access: "cursor-token" } }, deps.homedir());
	assert.equal(provider.hasCredentials(deps), true);
});

test("cursor fetchUsage reports no credentials without auth.json cursor.access", async () => {
	const provider = new CursorProvider();
	const { deps } = createDeps();
	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error?.code, "NO_CREDENTIALS");
	assert.equal(usage.windows.length, 0);
});

test("cursor fetch maps usage-summary percent and spend without treating the included pool as a cap", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const cycleEnd = new Date("2026-09-15T00:00:00.000Z");
	const cycleStart = new Date("2026-08-15T00:00:00.000Z");
	const calls: { url: string; init: RequestInit }[] = [];

	const { deps, files } = createDeps({
		fetch: async (url, init) => {
			calls.push({ url: String(url), init: init as RequestInit });
			const href = String(url);
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					billingCycleStart: cycleStart.toISOString(),
					billingCycleEnd: cycleEnd.toISOString(),
					individualUsage: {
						plan: {
							totalPercentUsed: 66.42,
							used: 7000,
							limit: 7000,
							breakdown: { included: 7000, bonus: 53448, total: 60448 },
						},
						onDemand: { enabled: false, used: 0, limit: null, remaining: null },
					},
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({
					planInfo: {
						billingCycleEnd: cycleEnd.toISOString(),
						includedAmountCents: 7000,
					},
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse({ noUsageBasedAllowed: true });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 1234 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows.length, 1);
	assert.equal(usage.windows[0]?.usedAmount, 12.34);
	assert.equal(usage.windows[0]?.usedPercent, 66.42);
	assert.equal(usage.windows[0]?.capAmount, undefined);
	assert.equal(usage.windows[0]?.label, "");
	assert.equal(usage.windows[0]?.resetAt, cycleEnd.toISOString());
	assert.ok(usage.windows[0]?.resetDescription);

	const urls = calls.map((call) => call.url);
	assert.ok(urls.includes("https://cursor.com/api/usage-summary"));
	assert.ok(urls.includes("https://cursor.com/api/dashboard/get-plan-info"));
	assert.ok(urls.includes("https://cursor.com/api/dashboard/get-hard-limit"));
	assert.ok(urls.includes("https://cursor.com/api/dashboard/teams"));
	assert.ok(urls.includes("https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents"));

	const summaryCall = calls.find((call) => call.url === "https://cursor.com/api/usage-summary");
	const planCall = calls.find((call) => call.url === "https://cursor.com/api/dashboard/get-plan-info");
	const usageCall = calls.find(
		(call) => call.url === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents",
	);
	const summaryHeaders = summaryCall?.init.headers as Record<string, string>;
	const planHeaders = planCall?.init.headers as Record<string, string>;
	const usageHeaders = usageCall?.init.headers as Record<string, string>;
	assert.equal(summaryHeaders.Authorization, `Bearer ${token}`);
	assert.equal(summaryHeaders.Cookie, `WorkosCursorSessionToken=user-1::${token}`);
	assert.equal(planHeaders.Authorization, `Bearer ${token}`);
	assert.equal(planHeaders.Cookie, `WorkosCursorSessionToken=user-1::${token}`);
	assert.equal(usageHeaders.Authorization, `Bearer ${token}`);
	assert.equal(usageHeaders["Connect-Protocol-Version"], "1");

	const usageBody = JSON.parse(String(usageCall?.init.body));
	assert.equal(usageBody.endDate, cycleEnd.getTime());
	assert.equal(usageBody.startDate, cycleStart.getTime());
});

test("cursor fetch prefers team/hard-limit dollars over the included pool", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const { deps, files } = createDeps({
		fetch: async (url, init) => {
			const href = String(url);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					individualUsage: { plan: { totalPercentUsed: 40, breakdown: { total: 10000 } } },
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({ planInfo: { includedAmountCents: 7000 } });
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse(body.teamId === 9 ? { hardLimit: 750 } : { noUsageBasedAllowed: true });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({ teams: [{ id: 9 }] });
			}
			if (href === "https://cursor.com/api/dashboard/team") {
				return createJsonResponse({ userId: 42 });
			}
			if (href === "https://cursor.com/api/dashboard/get-team-spend") {
				return createJsonResponse({
					teamMemberSpend: [{ userId: 42, spendCents: 12500, hardLimitOverrideDollars: 0 }],
					monthlyLimitDollars: 500,
				});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 9999 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.usedPercent, 40);
	assert.equal(usage.windows[0]?.usedAmount, 125);
	assert.equal(usage.windows[0]?.capAmount, 750);
});

test("cursor fetch prefers per-user hard-limit override over team hard-limit", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const { deps, files } = createDeps({
		fetch: async (url, init) => {
			const href = String(url);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					individualUsage: { plan: { totalPercentUsed: 40, breakdown: { total: 10000 } } },
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({ planInfo: { includedAmountCents: 7000 } });
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse(body.teamId === 9 ? { hardLimit: 750 } : { noUsageBasedAllowed: true });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({ teams: [{ id: 9 }] });
			}
			if (href === "https://cursor.com/api/dashboard/team") {
				return createJsonResponse({ userId: 42 });
			}
			if (href === "https://cursor.com/api/dashboard/get-team-spend") {
				return createJsonResponse({
					teamMemberSpend: [{ userId: 42, spendCents: 12500, hardLimitOverrideDollars: 900 }],
					monthlyLimitDollars: 500,
				});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 9999 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.usedAmount, 125);
	assert.equal(usage.windows[0]?.capAmount, 900);
});

test("cursor fetch uses team monthly dollars when hard-limit is absent", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const { deps, files } = createDeps({
		fetch: async (url) => {
			const href = String(url);
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					individualUsage: { plan: { totalPercentUsed: 40, breakdown: { total: 10000 } } },
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({ planInfo: { includedAmountCents: 7000 } });
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse({ noUsageBasedAllowed: true });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({ teams: [{ id: 9 }] });
			}
			if (href === "https://cursor.com/api/dashboard/team") {
				return createJsonResponse({ userId: 42 });
			}
			if (href === "https://cursor.com/api/dashboard/get-team-spend") {
				return createJsonResponse({
					teamMemberSpend: [{ userId: 42, spendCents: 12500 }],
					effectivePerUserLimitDollars: 500,
				});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 9999 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.usedAmount, 125);
	assert.equal(usage.windows[0]?.capAmount, 500);
});

test("cursor fetch uses personal hard-limit dollars when team is absent", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const { deps, files } = createDeps({
		fetch: async (url) => {
			const href = String(url);
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					individualUsage: {
						plan: { totalPercentUsed: 40, breakdown: { total: 61381 } },
						onDemand: { enabled: false, used: 0, limit: null },
					},
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({ planInfo: { includedAmountCents: 7000 } });
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse({ hardLimit: 750 });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 12500 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.usedAmount, 125);
	assert.equal(usage.windows[0]?.capAmount, 750);
});

test("cursor fetch uses on-demand cents as spend when usage-based is enabled", async () => {
	const provider = new CursorProvider();
	const token = cursorAccessToken("user-1");
	const { deps, files } = createDeps({
		fetch: async (url) => {
			const href = String(url);
			if (href === "https://cursor.com/api/usage-summary") {
				return createJsonResponse({
					individualUsage: {
						plan: { totalPercentUsed: 40, used: 7000, limit: 7000, breakdown: { total: 61381 } },
						onDemand: { enabled: true, used: 12500, limit: 75000, remaining: 62500 },
					},
				});
			}
			if (href === "https://cursor.com/api/dashboard/get-plan-info") {
				return createJsonResponse({ planInfo: { includedAmountCents: 7000 } });
			}
			if (href === "https://cursor.com/api/dashboard/get-hard-limit") {
				return createJsonResponse({ noUsageBasedAllowed: true });
			}
			if (href === "https://cursor.com/api/dashboard/teams") {
				return createJsonResponse({});
			}
			if (href === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents") {
				return createJsonResponse({ totalCostCents: 99999 });
			}
			throw new Error(`unexpected url ${href}`);
		},
	});
	withAuth(files, { cursor: { access: token } }, deps.homedir());

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.usedPercent, 40);
	assert.equal(usage.windows[0]?.usedAmount, 125);
	assert.equal(usage.windows[0]?.capAmount, 750);
});
