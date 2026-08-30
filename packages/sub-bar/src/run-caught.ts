/**
 * Fire-and-forget a promise without letting a rejection become an unhandled
 * rejection. Node 24 promotes those to uncaughtException and Pi then exits.
 */
export function runCaught(label: string, work: Promise<unknown>): void {
	void work.catch((err: unknown) => {
		console.error(label, err);
	});
}
