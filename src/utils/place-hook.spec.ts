import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { applyPlaceHook } from "./place-hook.ts";

const PLACE_HOOK_ENV = "JEST_ROBLOX_PLACE_HOOK";
const COVERAGE_PLACE_HOOK_ENV = "JEST_ROBLOX_COVERAGE_PLACE_HOOK";
const RECORDER = path.join(import.meta.dirname, "../../test/fixtures/place-hook/recorder.mjs");

/**
 * What a hook run produced: the marker the recorder wrote (proving which hook
 * ran) and the place path the recorder received (proving `{placeFile}` was
 * substituted).
 */
interface HookResult {
	readonly marker: string | undefined;
	readonly placeArg: string | undefined;
}

/**
 * A throwaway directory for one test's recorder output. Vitest cleans its own
 * temp root between runs, so a leftover directory carries no state forward.
 */
function makeScratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "place-hook-spec-"));
}

/**
 * Build a recorder command writing `marker` to `markerFile` and forwarding the
 * place path to `placeArgFile`. The token is left bare because `applyPlaceHook`
 * shell-quotes whatever it substitutes for it.
 */
function recorderCommand({
	marker,
	markerFile,
	placeArgFile,
}: {
	marker: string;
	markerFile: string;
	placeArgFile: string;
}): string {
	return `node "${RECORDER}" ${marker} "${markerFile}" "${placeArgFile}" {placeFile}`;
}

/**
 * Run `applyPlaceHook` with the given hook variables and report what the
 * recorder produced. The process environment is restored before returning, so
 * the suite needs no setup or teardown hooks.
 */
function runHook({
	environment,
	placeFile,
}: {
	environment: Partial<Record<string, string>>;
	placeFile: string;
}): HookResult {
	const scratch = makeScratch();
	const markerFile = path.join(scratch, "marker.txt");
	const placeArgFile = path.join(scratch, "place-arg.txt");
	const savedPlace = process.env[PLACE_HOOK_ENV];
	const savedCoverage = process.env[COVERAGE_PLACE_HOOK_ENV];

	const resolved: Partial<Record<string, string>> = {};
	for (const [key, value] of Object.entries(environment)) {
		resolved[key] = value
			.replaceAll("{markerFile}", markerFile)
			.replaceAll("{placeArgFile}", placeArgFile);
	}

	Reflect.deleteProperty(process.env, PLACE_HOOK_ENV);
	Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);
	Object.assign(process.env, resolved);

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

	const read = (file: string): string | undefined =>
		fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;

	return { marker: read(markerFile), placeArg: read(placeArgFile) };
}

describe(applyPlaceHook, () => {
	it("should do nothing when neither hook variable is set", () => {
		expect.assertions(1);

		const result = runHook({ environment: {}, placeFile: "place.rbxl" });

		expect(result.marker).toBeUndefined();
	});

	it("should substitute the absolute place path for {placeFile}", () => {
		expect.assertions(2);

		const result = runHook({
			environment: {
				[PLACE_HOOK_ENV]: recorderCommand({
					marker: "general",
					markerFile: "{markerFile}",
					placeArgFile: "{placeArgFile}",
				}),
			},
			placeFile: "nested/place.rbxl",
		});

		expect(result.marker).toBe("general");
		// The hook shell-escapes the path, so compare with backslash runs
		// collapsed: the escaping differs between cmd.exe and a POSIX shell but
		// both resolve to the same file.
		expect(result.placeArg?.replaceAll("\\\\", "\\")).toBe(path.resolve("nested/place.rbxl"));
	});

	it("should prefer the general hook over the legacy coverage hook", () => {
		expect.assertions(1);

		const result = runHook({
			environment: {
				[COVERAGE_PLACE_HOOK_ENV]: recorderCommand({
					marker: "legacy",
					markerFile: "{markerFile}",
					placeArgFile: "{placeArgFile}",
				}),
				[PLACE_HOOK_ENV]: recorderCommand({
					marker: "general",
					markerFile: "{markerFile}",
					placeArgFile: "{placeArgFile}",
				}),
			},
			placeFile: "place.rbxl",
		});

		expect(result.marker).toBe("general");
	});

	it("should fall back to the legacy coverage hook when the general one is unset", () => {
		expect.assertions(1);

		const result = runHook({
			environment: {
				[COVERAGE_PLACE_HOOK_ENV]: recorderCommand({
					marker: "legacy",
					markerFile: "{markerFile}",
					placeArgFile: "{placeArgFile}",
				}),
			},
			placeFile: "place.rbxl",
		});

		expect(result.marker).toBe("legacy");
	});

	it("should treat a blank hook command as not configured", () => {
		expect.assertions(1);

		const result = runHook({
			environment: { [PLACE_HOOK_ENV]: " ".repeat(3) },
			placeFile: "place.rbxl",
		});

		expect(result.marker).toBeUndefined();
	});

	it("should name the hook that failed when the command exits non-zero", () => {
		expect.assertions(1);

		const scratch = makeScratch();
		const failCommand = `node "${RECORDER}" fail "${path.join(scratch, "unused.txt")}" unused`;

		process.env[COVERAGE_PLACE_HOOK_ENV] = failCommand;
		try {
			expect(() => {
				applyPlaceHook(path.join(scratch, "place.rbxl"));
			}).toThrow(`${COVERAGE_PLACE_HOOK_ENV} failed`);
		} finally {
			Reflect.deleteProperty(process.env, COVERAGE_PLACE_HOOK_ENV);
		}
	});
});
