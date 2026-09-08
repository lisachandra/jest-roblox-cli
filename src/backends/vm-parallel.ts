import type { ParallelOption } from "./interface.ts";

/**
 * The Actor-host pool size the pre-prune plugin shipped (`host1`..`host4`).
 *
 * Kept as a stable exported constant so the "Studio-only" validation in
 * `auto.ts` can keep bounding requests against something meaningful; the
 * parallel path itself is pruned, so this no longer bounds a real pool.
 */
export const VM_HOST_POOL_SIZE = 4;


/**
 * Resolve the VM count an in-session parallel run would want.
 *
 * The Studio plugin's Actor-host parallel runner has been pruned from the fork
 * (single-VM-for-stability), so this always returns `undefined` and a run the
 * CLI was asked to parallelize lands on the sequential path instead. Kept as
 * the single decision point the payload builder shares with the plugin so
 * dead code reads as deliberate rather than absent.
 */
export function resolveVmHostCount(
	vmParallel: ParallelOption | undefined,
	_configCount: number,
): number | undefined {
	void vmParallel;
	return undefined;
}
