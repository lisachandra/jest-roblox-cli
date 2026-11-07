import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import type { EmulatorRun } from "./emulator.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import { EmulatorBackend } from "./emulator.ts";
import type { EmulatorStageMapping, EmulatorStageResult } from "./emulator-stage.ts";

/** Captured launch request from the fake launcher. */
interface CapturedLaunch {
	args: Array<string>;
	reePath: string;
}

const MAPPINGS: Array<EmulatorStageMapping> = [
	{ dataModelPath: "ReplicatedStorage/TS/client", fsPath: "/repo/out/client" },
	{ dataModelPath: "ReplicatedStorage/TS/test", fsPath: "/repo/out/test" },
	{
		dataModelPath: "ReplicatedStorage/TS/rbxts_include/node_modules",
		fsPath: "/repo/packages/shared/node_modules",
	},
];

const STAGE_RESULT: EmulatorStageResult = {
	mappings: MAPPINGS,
	stageDirectory: "/stage",
};

function makeJob(overrides: Partial<ProjectJob> = {}): ProjectJob {
	return {
		config: createResolvedConfig({
			jestPath: "ReplicatedStorage/TS/rbxts_include/node_modules/@rbxts/jest/src",
			rootDir: "/repo",
			setupFiles: ["./out/test/setup"],
			testPathPattern: "hud/ballCam",
		}),
		displayName: "client",
		testFiles: ["/repo/out/client/ui/hud/ballCam/tests/ballCam.render.spec.luau"],
		...overrides,
	};
}

function makeBackendOptions(jobs: Array<ProjectJob>): BackendOptions {
	return { jobs, progress: NOOP_RUN_PROGRESS };
}

function jestResult(failedTestCount: number): string {
	return JSON.stringify({
		numFailedTests: failedTestCount,
		numPassedTests: failedTestCount === 0 ? 2 : 1,
		numTotalTests: 2,
		success: failedTestCount === 0,
	});
}

function reeSummary(entryJestOutput: string): { code: number; stderr: string; stdout: string } {
	const envelope = JSON.stringify({ entries: [{ jestOutput: entryJestOutput }] });
	return {
		code: 0,
		stderr: "ree: run ok; 30 frames\n",
		stdout: `${JSON.stringify({
			done: true,
			output: [
				{ kind: "print", message: "[harness] running" },
				{ kind: "print", message: `@JEST_RESULTS ${envelope}` },
			],
			status: "ok",
		})}\n`,
	};
}

function makeBackend(
	runs: Array<{ code: number; stderr: string; stdout: string }>,
): { backend: EmulatorBackend; launches: Array<CapturedLaunch>; writes: Map<string, string> } {
	const launches: Array<CapturedLaunch> = [];
	const queue = [...runs];
	const writes = new Map<string, string>();
	const backend = new EmulatorBackend({
		config: createResolvedConfig({ rootDir: "/repo" }),
		launch: async (request) => {
			launches.push({ args: request.args, reePath: request.reePath });
			const run = queue.shift();
			if (run === undefined) {
				throw new Error("unexpected extra launch");
			}

			const outcome: EmulatorRun = { done: Promise.resolve(run) };
			return outcome;
		},
		stage: () => STAGE_RESULT,
		writeFile: (filePath, contents) => {
			writes.set(filePath, contents);
		},
	});
	return { backend, launches, writes };
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
	if (text === undefined) {
		throw new Error("missing argument");
	}

	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}

	return Object.fromEntries(Object.entries(parsed));
}

function numberFailedTestsOf(jestOutput: string): number {
	const parsed: unknown = JSON.parse(jestOutput);
	if (typeof parsed !== "object" || parsed === null || !("numFailedTests" in parsed)) {
		return -1;
	}

	const { numFailedTests: failedTests } = parsed;
	return typeof failedTests === "number" ? failedTests : -1;
}

function luauScriptErrorOf(caught: unknown): LuauScriptError {
	if (!(caught instanceof LuauScriptError)) {
		throw new Error(`expected a LuauScriptError, got ${String(caught)}`);
	}

	return caught;
}

describe("emulatorBackend", () => {
	it("should run one ree process per job", async () => {
		expect.assertions(3);

		const { backend, launches } = makeBackend([reeSummary(jestResult(0)), reeSummary(jestResult(0))]);
		const result = await backend.runTestsAsync(makeBackendOptions([makeJob(), makeJob()]));

		expect(result.rawResults).toHaveLength(2);

		expect(launches).toHaveLength(2);
		expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should shape each envelope entry with the project label", async () => {
		expect.assertions(3);

		const { backend } = makeBackend([reeSummary(jestResult(0)), reeSummary(jestResult(0))]);
		const result = await backend.runTestsAsync(makeBackendOptions([makeJob(), makeJob()]));

		expect(numberFailedTestsOf(result.rawResults[0]!.entry.jestOutput)).toBe(0);

		expect(result.rawResults[0]!.entry.project).toBe("client");
		expect(result.rawResults[1]!.entry.project).toBe("client");
	});

	it("should build mount args from the stage mappings", async () => {
		expect.assertions(3);

		const { backend, launches } = makeBackend([reeSummary(jestResult(0))]);
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;

		expect(args).toContain("--harness");

		expect(args).toContain("--mount");
		expect(args).toContain("ReplicatedStorage/TS/client=/stage/ReplicatedStorage/TS/client");
	});

	it("should build the runner context from the job and stage", async () => {
		expect.assertions(4);

		const { backend, launches, writes } = makeBackend([reeSummary(jestResult(0))]);
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;
		const context: Record<string, unknown> = parseJsonObject(args.at(args.indexOf("--context") + 1));

		expect(context["roots"]).toStrictEqual(["ReplicatedStorage/TS/client"]);

		expect(context["setupFiles"]).toStrictEqual(["ReplicatedStorage/TS/test/setup"]);
		expect(context["pattern"]).toBe("hud/ballCam");
		expect(writes.get("/stage/harness.luau")).toContain("debug.loadmodule");
	});

	it("should normalize emulator ignore patterns to instance shape", async () => {
		expect.assertions(1);

		const launches: Array<CapturedLaunch> = [];
		const backend = new EmulatorBackend({
			config: createResolvedConfig({
				emulator: { ignorePatterns: ["src/server/tests/simulation.spec.ts"] },
				rootDir: "/repo",
			}),
			launch: async (request) => {
				launches.push({ args: request.args, reePath: request.reePath });
				return { done: Promise.resolve(reeSummary(jestResult(0))) };
			},
			stage: () => STAGE_RESULT,
			writeFile: () => {},
		});
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;
		const context: Record<string, unknown> = parseJsonObject(args.at(args.indexOf("--context") + 1));

		expect(context["ignorePatterns"]).toStrictEqual(["server/tests/simulation.spec"]);
	});

	it("should bail remaining jobs after a failing one", async () => {
		expect.assertions(3);

		const { backend, launches } = makeBackend([reeSummary(jestResult(1)), reeSummary(jestResult(0))]);
		const result = await backend.runTestsAsync({
			...makeBackendOptions([makeJob(), makeJob()]),
			bail: true,
		});

		expect(result.rawResults).toHaveLength(1);

		expect(result.bailedJobIndices).toStrictEqual([1]);
		expect(launches).toHaveLength(1);
	});

	it("should keep failed tests in the envelope instead of erroring", async () => {
		expect.assertions(1);

		const { backend } = makeBackend([reeSummary(jestResult(2))]);
		const result = await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		expect(numberFailedTestsOf(result.rawResults[0]!.entry.jestOutput)).toBe(2);
	});

	it("should throw a LuauScriptError when the run carries no results", async () => {
		expect.assertions(2);

		const stdout = `${JSON.stringify({
			errors: ["harness crashed"],
			output: [{ kind: "error", message: "attempt to index nil" }],
			status: "error",
		})}\n`;
		const { backend } = makeBackend([{ code: 0, stderr: "", stdout }]);
		let caught: unknown;
		try {
			await backend.runTestsAsync(makeBackendOptions([makeJob()]));
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(LuauScriptError);

		expect(luauScriptErrorOf(caught).gameOutput).toContain("attempt to index nil");
	});

	it("should throw a LuauScriptError when ree exits without a summary", async () => {
		expect.assertions(1);

		const { backend } = makeBackend([{ code: 126, stderr: "ree: script timeout", stdout: "" }]);
		const run = backend.runTestsAsync(makeBackendOptions([makeJob()]));

		await expect(run).rejects.toThrow("exited 126 without a summary");
	});

	it("should pass --snapshot-dir when the configured directory exists", async () => {
		expect.assertions(2);

		const snapshotsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "emu-snapshots-"));
		const launches: Array<CapturedLaunch> = [];
		try {
			const backend = new EmulatorBackend({
				config: createResolvedConfig({
					emulator: { snapshotsDirectory },
					rootDir: "/repo",
				}),
				launch: async (request) => {
					launches.push({ args: request.args, reePath: request.reePath });
					return { done: Promise.resolve(reeSummary(jestResult(0))) };
				},
				stage: () => STAGE_RESULT,
				writeFile: () => {},
			});
			await backend.runTestsAsync(makeBackendOptions([makeJob()]));
		} finally {
			fs.rmSync(snapshotsDirectory, { force: true, recursive: true });
		}

		const { args } = launches[0]!;

		expect(args).toContain("--snapshot-dir");

		expect(args.at(args.indexOf("--snapshot-dir") + 1)).toBe(snapshotsDirectory);
	});

	it("should omit --snapshot-dir and warn when the configured directory is missing", async () => {
		expect.assertions(2);

		const launches: Array<CapturedLaunch> = [];
		const backend = new EmulatorBackend({
			config: createResolvedConfig({
				emulator: { snapshotsDirectory: "/repo/build/absent-templates" },
				rootDir: "/repo",
			}),
			launch: async (request) => {
				launches.push({ args: request.args, reePath: request.reePath });
				return { done: Promise.resolve(reeSummary(jestResult(0))) };
			},
			stage: () => STAGE_RESULT,
			writeFile: () => {},
		});
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;

		expect(args).not.toContain("--snapshot-dir");
		expect(args).toContain("--mount");
	});
});
