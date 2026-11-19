import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { applyPlaceHook } from "./place-hook.ts";

const PLACE_HOOK_ENV = "JEST_ROBLOX_PLACE_HOOK";
const COVERAGE_PLACE_HOOK_ENV = "JEST_ROBLOX_COVERAGE_PLACE_HOOK";
const RECORDER = path.join(import.meta.dirname, "../../test/fixtures/place-hook/recorder.mjs");

/** The token `applyPlaceHook` substitutes the resolved place path for. */
const PLACE_FILE_TOKEN = "{placeFile}";

/**
 * What a hook run produced: the marker the recorder wrote (proving which hook
 * ran) and the place path the recorder received (proving `{placeFile}` was
 * substituted).
 */
interface HookResult {
	readonly marker: string | undefined;
	readonly placeArgument: string | undefined;
}

/**
 * A throwaway directory for one test's recorder output. Vitest cleans its own
 * temp root between runs, so a leftover directory carries no state forward.
 *
 * @returns Absolute path of the scratch directory.
 */
function makeScratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "place-hook-spec-"));
}

/**
 * Read a file the recorder may or may not have written.
 *
 * @param file - Absolute path to check.
 * @returns The file's contents, or `undefined` when it was never written.
 */
function readIfPresent(file: string): string | undefined {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

/**
 * Collapse each run of backslashes to a single one, so a path escaped for
 * `cmd.exe` and one escaped for a POSIX shell compare equal.
 *
 * @param value - The possibly-escaped path, or `undefined` when no path was
 * recorded.
 * @returns The path with backslash runs collapsed to one, or an empty string
 * when nothing was recorded.
 */
function collapseBackslashes(value: string | undefined): string {
	return (value ?? "").replaceAll("\\\\", "\\");
}

/**
 * Build a hook command that writes `marker` to `markerPath`, records the place
 * path it received into `placeArgumentPath`, and forwards `{placeFile}` as its
 * last argument.
 *
 * The token is left bare because `applyPlaceHook` shell-quotes whatever it
 * substitutes for it.
 *
 * @param options - The marker to write and where to write the two outputs.
 * @param options.marker - Marker the recorder writes, proving which hook ran.
 * @param options.markerPath - Absolute path the marker is written to.
 * @param options.placeArgumentPath - Absolute path the received place path is
 * written to.
 * @returns A shell command string containing a bare `{placeFile}` token.
 */
function recorderCommand({
	marker,
	markerPath,
	placeArgumentPath,
}: {
	marker: string;
	markerPath: string;
	placeArgumentPath: string;
}): string {
	const quoted = [marker, markerPath, placeArgumentPath]
		.map((argument) => `"${argument}"`)
		.join(" ");
	return `node "${RECORDER}" ${quoted} ${PLACE_FILE_TOKEN}`;
}

/**
 * Run `applyPlaceHook` with the given hook variables and report what the
 * recorder produced.
 *
 * The process environment is restored before returning, so the suite needs no
 * setup or teardown hooks.
 *
 * @param options - The hook to set and the place path to pass.
 * @param options.hook - Which hook variable to set, and the marker it writes.
 * @param options.placeFile - Path passed through to the hook.
 * @returns The marker and place argument the recorder produced.
 */
function runHook({
	hook,
	placeFile,
}: {
	hook: undefined | { readonly kind: "general" | "legacy"; readonly marker: string };
	placeFile: string;
}): HookResult {
	const scratch = makeScratch();
	const markerPath = path.join(scratch, "marker.txt");
	const placeArgumentPath = path.join(scratch, "place-argument.txt");
	const savedPlace = process.env[PLACE_HOOK_ENV];
	const savedCoverage = process.env[COVERAGE_PLACE_HOOK_ENV];

	Reflect.deleteProperty(process.env, PLACE_HOOK_ENV);
	Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);

	if (hook !== undefined) {
		const command = recorderCommand({
			marker: hook.marker,
			markerPath,
			placeArgumentPath,
		});
		process.env[hook.kind === "general" ? PLACE_HOOK_ENV : COVERAGE_PLACE_HOOK_ENV] = command;
	}

	try {
		applyPlaceHook(placeFile);
	} finally {
		Reflect.deleteProperty(process.env, PLACE_HOOK_ENV);
		Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);

		if (savedPlace !== undefined) {
			process.env[PLACE_HOOK_ENV] = savedPlace;
		}

		if (savedCoverage !== undefined) {
			process.env[COVERAGE_PLACE_HOOK_ENV] = savedCoverage;
		}
	}

	return {
		marker: readIfPresent(markerPath),
		placeArgument: readIfPresent(placeArgumentPath),
	};
}

/**
 * Run a hook command that exits non-zero, and report the error message
 * `applyPlaceHook` raised.
 *
 * @param options - The hook variable to set and the failing command.
 * @param options.kind - Which hook variable to set.
 * @param options.command - The command string the hook runs.
 * @returns The thrown error's message, or a sentinel when nothing was thrown.
 */
function runFailingHook({
	command,
	kind,
}: {
	command: string;
	kind: "general" | "legacy";
}): string {
	const scratch = makeScratch();
	const savedPlace = process.env[PLACE_HOOK_ENV];
	const savedCoverage = process.env[COVERAGE_PLACE_HOOK_ENV];

	Reflect.deleteProperty(process.env, PLACE_HOOK_ENV);
	Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);
	process.env[kind === "general" ? PLACE_HOOK_ENV : COVERAGE_PLACE_HOOK_ENV] = command;

	try {
		applyPlaceHook(path.join(scratch, "place.rbxl"));
		return "(did not throw)";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		Reflect.deleteProperty(process.env, PLACE_HOOK_ENV);
		Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);

		if (savedPlace !== undefined) {
			process.env[PLACE_HOOK_ENV] = savedPlace;
		}

		if (savedCoverage !== undefined) {
			process.env[COVERAGE_PLACE_HOOK_ENV] = savedCoverage;
		}
	}
}

describe(applyPlaceHook, () => {
	it("should do nothing when neither hook variable is set", () => {
		expect.assertions(1);

		const result = runHook({ hook: undefined, placeFile: "place.rbxl" });

		expect(result.marker).toBeUndefined();
	});

	it("should substitute the absolute place path for {placeFile}", () => {
		expect.assertions(2);

		const result = runHook({
			hook: { kind: "general", marker: "general" },
			placeFile: "nested/place.rbxl",
		});

		expect(result.marker).toBe("general");
		// The hook shell-escapes the path, so compare with backslash runs
		// collapsed: the escaping differs between cmd.exe and a POSIX shell but
		// both resolve to the same file.
		expect(collapseBackslashes(result.placeArgument)).toBe(path.resolve("nested/place.rbxl"));
	});

	it("should fall back to the legacy coverage hook when the general one is unset", () => {
		expect.assertions(1);

		const result = runHook({
			hook: { kind: "legacy", marker: "legacy" },
			placeFile: "place.rbxl",
		});

		expect(result.marker).toBe("legacy");
	});

	it("should name the hook that failed when the command exits non-zero", () => {
		expect.assertions(1);

		const message = runFailingHook({
			command: `node "${RECORDER}" fail unused`,
			kind: "legacy",
		});

		expect(message).toBe(`${COVERAGE_PLACE_HOOK_ENV} failed`);
	});
});
