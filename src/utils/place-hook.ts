import * as cp from "node:child_process";
import * as path from "node:path";
import process from "node:process";

/**
 * General-purpose hook that runs after any place build (clean or coverage).
 * Checked first; falls back to {@link COVERAGE_PLACE_HOOK_ENV} for backward
 * compatibility.
 */
const PLACE_HOOK_ENV = "JEST_ROBLOX_PLACE_HOOK";

/**
 * Legacy coverage-only hook. Still honoured when {@link PLACE_HOOK_ENV} is
 * unset, so existing workflows keep working.
 */
const COVERAGE_PLACE_HOOK_ENV = "JEST_ROBLOX_COVERAGE_PLACE_HOOK";

/**
 * Run the post-build place hook, if configured.
 *
 * Resolution order:
 *  1. `JEST_ROBLOX_PLACE_HOOK`  — runs for every place build (clean, coverage,
 *  workspace). 2. `JEST_ROBLOX_COVERAGE_PLACE_HOOK` — legacy fallback, runs
 *  only when the
 *     general hook is unset.
 *
 * The `{placeFile}` token in the command is replaced with the absolute,
 * shell-quoted path of the just-built `.rbxl`.
 * @param placeFile
 * @param _hookSource
 */
export function applyPlaceHook(
	placeFile: string,
	/** Which env var actually triggered this hook (for error messages). */
	_hookSource?: string,
): void {
	const command =
		process.env[PLACE_HOOK_ENV] ?? process.env[COVERAGE_PLACE_HOOK_ENV];
	if (command === undefined || command.trim() === "") {
		return;
	}

	const source = _hookSource ?? (process.env[PLACE_HOOK_ENV] !== undefined ? PLACE_HOOK_ENV : COVERAGE_PLACE_HOOK_ENV);
	const resolvedPlaceFile = path.resolve(placeFile);
	const expandedCommand = command.replaceAll("{placeFile}", shellQuote(resolvedPlaceFile));
	try {
		cp.execSync(expandedCommand, { stdio: "inherit" });
	} catch (err) {
		throw new Error(`${source} failed`, { cause: err });
	}
}

function shellQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
