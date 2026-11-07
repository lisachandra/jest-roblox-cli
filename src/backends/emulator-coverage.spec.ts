import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EmulatorStageMapping } from "./emulator-stage.ts";
import { applyCoverageTwins } from "./emulator-coverage.ts";

const MAPPINGS: Array<EmulatorStageMapping> = [
	{ dataModelPath: "ReplicatedStorage/TS/client", fsPath: "out/client" },
	{ dataModelPath: "ReplicatedStorage/TS/test", fsPath: "out/test" },
];

/**
 * Writes a coverage manifest declaring one instrumented twin for
 * `out/client/mod.luau`, plus the twin itself.
 *
 * @param rootDirectory - Temporary root the shadow and manifest live under.
 */
function writeManifestAndTwin(rootDirectory: string): void {
	const shadow = path.join(rootDirectory, ".jest-roblox", "coverage", "out", "client");
	fs.mkdirSync(shadow, { recursive: true });
	fs.writeFileSync(path.join(shadow, "mod.luau"), "__PROBED__");
	fs.writeFileSync(
		path.join(rootDirectory, ".jest-roblox", "coverage", "coverage-manifest.json"),
		JSON.stringify({
			files: {
				"out/client/mod.luau": {
					instrumentedLuauPath: ".jest-roblox/coverage/out/client/mod.luau",
					originalLuauPath: "out/client/mod.luau",
				},
			},
		}),
	);
}

/**
 * Stages the original file's tree under the mapping's DataModel path.
 *
 * @param rootDirectory - Temporary root the stage lives under.
 * @returns The stage directory.
 */
function writeStagedOriginal(rootDirectory: string): string {
	const stageDirectory = path.join(rootDirectory, ".jest-roblox", "emulator");
	const staged = path.join(stageDirectory, "ReplicatedStorage/TS/client/mod.luau");
	fs.mkdirSync(path.dirname(staged), { recursive: true });
	fs.writeFileSync(staged, "__ORIGINAL__");
	return stageDirectory;
}

/**
 * Absolutizes the shared mappings against the temporary root.
 *
 * @param rootDirectory - Temporary root the mappings resolve against.
 * @returns The absolutized stage mappings.
 */
function mappingsFor(rootDirectory: string): Array<EmulatorStageMapping> {
	return MAPPINGS.map((mapping) => {
		return {
			...mapping,
			fsPath: path.resolve(rootDirectory, mapping.fsPath),
		};
	});
}

describe("applyCoverageTwins", () => {
	it("should overwrite staged originals with their instrumented twins", () => {
		expect.assertions(2);

		const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "emu-cov-"));
		let applied = 0;
		let stagedContents = "";
		try {
			writeManifestAndTwin(rootDirectory);
			const stageDirectory = writeStagedOriginal(rootDirectory);

			applied = applyCoverageTwins({
				mappings: mappingsFor(rootDirectory),
				rootDirectory,
				stageDirectory,
			});
			stagedContents = fs.readFileSync(
				path.join(stageDirectory, "ReplicatedStorage/TS/client/mod.luau"),
				"utf-8",
			);
		} finally {
			fs.rmSync(rootDirectory, { force: true, recursive: true });
		}

		expect(applied).toBe(1);

		expect(stagedContents).toBe("__PROBED__");
	});

	it("should apply nothing and not throw without a manifest", () => {
		expect.assertions(2);

		const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "emu-cov-"));
		let applied = -1;
		let stagedContents = "";
		try {
			const stageDirectory = writeStagedOriginal(rootDirectory);

			applied = applyCoverageTwins({
				mappings: mappingsFor(rootDirectory),
				rootDirectory,
				stageDirectory,
			});
			stagedContents = fs.readFileSync(
				path.join(stageDirectory, "ReplicatedStorage/TS/client/mod.luau"),
				"utf-8",
			);
		} finally {
			fs.rmSync(rootDirectory, { force: true, recursive: true });
		}

		expect(applied).toBe(0);

		expect(stagedContents).toBe("__ORIGINAL__");
	});

	it("should skip twins whose original no mount owns", () => {
		expect.assertions(1);

		const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "emu-cov-"));
		let applied = -1;
		try {
			writeManifestAndTwin(rootDirectory);
			const stageDirectory = writeStagedOriginal(rootDirectory);

			applied = applyCoverageTwins({
				mappings: [
					{
						dataModelPath: "ReplicatedStorage/TS/other",
						fsPath: path.resolve(rootDirectory, "elsewhere"),
					},
				],
				rootDirectory,
				stageDirectory,
			});
		} finally {
			fs.rmSync(rootDirectory, { force: true, recursive: true });
		}

		expect(applied).toBe(0);
	});
});
