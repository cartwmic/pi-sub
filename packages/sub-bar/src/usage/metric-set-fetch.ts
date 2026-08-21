/**
 * When metricSet is nonempty, listed providers must be fetched even if they
 * are not the selected model. Cache-only entry reads omit them on a fresh or
 * expired cache; UI and headless starts therefore share a forced, long-timeout
 * entries request.
 */
export function metricSetEntriesRequest(
	metricSetLength: number,
): { timeoutMs: number; force: true } | null {
	if (metricSetLength <= 0) return null;
	return { timeoutMs: 45_000, force: true };
}
