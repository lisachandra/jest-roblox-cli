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
 * Resolution order: `JEST_ROBLOX_PLACE_HOOK` runs for every place build (clean,
 * coverage, workspace); `JEST_ROBLOX_COVERAGE_PLACE_HOOK` is the legacy fallback
 * and runs only while the general hook is unset.
 *
 * The `{placeFile}` token in the command is replaced with the absolute,
 * shell-quoted path of the just-built `.rbxl`.
 *
 * @param placeFile - Path of the place the hook is running against.
 */
export function applyPlaceHook(placeFile: string): void {
	const command = process.env[PLACE_HOOK_ENV] ?? process.env[COVERAGE_PLACE_HOOK_ENV];
	if (command === undefined || command.trim() === "") {
		return;
	}

	const source =
		process.env[PLACE_HOOK_ENV] !== undefined ? PLACE_HOOK_ENV : COVERAGE_PLACE_HOOK_ENV;
	const resolvedPlaceFile = path.resolve(placeFile);
	// `split().join()` rather than `replaceAll()`: the replacement is a computed
	// path, and a `$` in it would be read as a capture-group reference by
	// `String#replace`. Splitting sidesteps that substitution entirely.
	const expandedCommand = command.split("{placeFile}").join(shellQuote(resolvedPlaceFile));
	try {
		cp.execSync(expandedCommand, { stdio: "inherit" });
	} catch (err) {
		throw new Error(`${source} failed`, { cause: err });
	}
}

/**
 * Quote a path for the shell `execSync` will use.
 *
 * Backslashes and double quotes are both escaped: on a POSIX shell `\\`
 * collapses back to `\`, and leaving either unescaped would let a path break
 * out of its quotes.
 *
 * @param value - The path to quote.
 * @returns The path wrapped in double quotes with both characters escaped.
 */
function shellQuote(value: string): string {
	const escapedBackslashes = value.replaceAll("\\", "\\\\");
	const escapedQuotes = escapedBackslashes.replaceAll('"', '\\"');
	return ['"', escapedQuotes, '"'].join("");
}
