import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import type { EmulatorStageMapping, EmulatorStageResult } from "./emulator-stage.ts";
import { EmulatorStagingError } from "./emulator-stage.ts";
import type { EmulatorRun } from "./emulator.ts";
import { EmulatorBackend } from "./emulator.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";

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

/**
 * Creates a real stage tree for the mappings above.
 *
 * The backend verifies every mapped directory exists under the stage root
 * before it launches, so a fixture that only *claims* `/stage` no longer
 * reaches the launch seam. Tests that care about the verification mechanics
 * build their own tree instead of using this one.
 *
 * The root is a fixed path under the OS temp directory, wiped and rebuilt on
 * every call: these specs run in one file and the fork's lint forbids hooks
 * to tear a per-test directory down, so the next call is the cleanup. Tests
 * that delete the tree mid-run (`cleanup`) get a fresh one from the next call.
 *
 * @returns The stage result and a `cleanup` that removes the tree.
 */
function makeStageFixture(): { cleanup: () => void; stage: EmulatorStageResult } {
	const root = path.join(os.tmpdir(), "jest-roblox-emulator-spec-stage");
	fs.rmSync(root, { force: true, recursive: true });
	for (const mapping of MAPPINGS) {
		fs.mkdirSync(path.join(root, mapping.dataModelPath), { recursive: true });
	}

	return {
		cleanup: () => {
			fs.rmSync(root, { force: true, recursive: true });
		},
		stage: { mappings: MAPPINGS, stageDirectory: root },
	};
}

/**
 * Shared stage tree for the whole file; each backend construction rebuilds it.
 */
const STAGE_FIXTURE = makeStageFixture();

/**
 * The stage root as the mount args spell it: posix separators, whatever the
 * platform.
 *
 * @returns The stage root with forward slashes.
 */
function stageRootArgument(): string {
	return STAGE_FIXTURE.stage.stageDirectory.replaceAll("\\", "/");
}

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

function makeBackend(runs: Array<{ code: number; stderr: string; stdout: string }>): {
	backend: EmulatorBackend;
	launches: Array<CapturedLaunch>;
	writes: Map<string, string>;
} {
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
		stage: () => makeStageFixture().stage,
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

function stagingErrorOf(caught: unknown): EmulatorStagingError {
	if (!(caught instanceof EmulatorStagingError)) {
		throw new Error(`expected an EmulatorStagingError, got ${String(caught)}`);
	}

	return caught;
}

/**
 * Lands the mapped directory from the second stage attempt on: the first pass
 * is the one that missed.
 *
 * @param options - The attempt count, the mapping to land, and the fixture.
 */
function landOnSecondStage({
	calls,
	missing,
	stage,
}: {
	calls: number;
	missing: EmulatorStageMapping;
	stage: { stage: EmulatorStageResult };
}): void {
	if (calls <= 1) {
		return;
	}

	fs.mkdirSync(path.join(stage.stage.stageDirectory, missing.dataModelPath), { recursive: true });
}

describe("emulatorBackend", () => {
	it("should run one ree process per job", async () => {
		expect.assertions(3);

		const { backend, launches } = makeBackend([
			reeSummary(jestResult(0)),
			reeSummary(jestResult(0)),
		]);
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
		expect(args).toContain(
			`ReplicatedStorage/TS/client=${stageRootArgument()}/ReplicatedStorage/TS/client`,
		);
	});

	it("should build the runner context from the job and stage", async () => {
		expect.assertions(5);

		const { backend, launches, writes } = makeBackend([reeSummary(jestResult(0))]);
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;
		const context: Record<string, unknown> = parseJsonObject(
			args.at(args.indexOf("--context") + 1),
		);

		expect(context["roots"]).toStrictEqual(["ReplicatedStorage/TS/client"]);

		expect(context["setupFiles"]).toStrictEqual(["ReplicatedStorage/TS/test/setup"]);
		expect(context["pattern"]).toBe("hud/ballCam");
		expect(context["coverage"]).toBeFalse();
		expect(writes.get(`${stageRootArgument()}/harness.luau`)).toContain("debug.loadmodule");
	});

	it("should request coverage collection when the config enables it", async () => {
		expect.assertions(1);

		const launches: Array<CapturedLaunch> = [];
		const backend = new EmulatorBackend({
			config: createResolvedConfig({ collectCoverage: true, rootDir: "/repo" }),
			launch: async (request) => {
				launches.push({ args: request.args, reePath: request.reePath });
				return { done: Promise.resolve(reeSummary(jestResult(0))) };
			},
			stage: () => makeStageFixture().stage,
			writeFile: () => {},
		});
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;
		const context: Record<string, unknown> = parseJsonObject(
			args.at(args.indexOf("--context") + 1),
		);

		expect(context["coverage"]).toBeTrue();
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
			stage: () => makeStageFixture().stage,
			writeFile: () => {},
		});
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;
		const context: Record<string, unknown> = parseJsonObject(
			args.at(args.indexOf("--context") + 1),
		);

		expect(context["ignorePatterns"]).toStrictEqual(["server/tests/simulation.spec"]);
	});

	it("should bail remaining jobs after a failing one", async () => {
		expect.assertions(3);

		const { backend, launches } = makeBackend([
			reeSummary(jestResult(1)),
			reeSummary(jestResult(0)),
		]);
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
				stage: () => makeStageFixture().stage,
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
			stage: () => makeStageFixture().stage,
			writeFile: () => {},
		});
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const { args } = launches[0]!;

		expect(args).not.toContain("--snapshot-dir");
		expect(args).toContain("--mount");
	});

	it("should fail at staging, naming the mapping, when a staged mount is missing", async () => {
		expect.assertions(5);

		const stage = makeStageFixture();
		// A mount the stage never wrote: the source was gone by copy time, so
		// the mapping exists but its directory does not.
		const missing: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/PacketProfiler/Components",
			fsPath: "/repo/submodules/packet-profiler/src/Components",
		};
		const brokenStage: EmulatorStageResult = {
			mappings: [...stage.stage.mappings, missing],
			stageDirectory: stage.stage.stageDirectory,
		};
		let stageCalls = 0;
		const backend = new EmulatorBackend({
			config: createResolvedConfig({ rootDir: "/repo" }),
			launch: async () => ({ done: Promise.resolve(reeSummary(jestResult(0))) }),
			stage: () => {
				stageCalls += 1;
				return brokenStage;
			},
			writeFile: () => {},
		});

		let caught: unknown;
		try {
			await backend.runTestsAsync(makeBackendOptions([makeJob()]));
		} catch (err) {
			caught = err;
		} finally {
			stage.cleanup();
		}

		expect(caught).toBeInstanceOf(EmulatorStagingError);

		const error = stagingErrorOf(caught);

		expect(error.missing).toStrictEqual([missing]);

		// Both attempts failed the same way, and neither reached the launcher.
		expect(stageCalls).toBe(2);

		expect(error.message).toContain(missing.dataModelPath);
		expect(error.message).toContain(missing.fsPath);
	});

	it("should rebuild the stage once when the first stage misses a mount", async () => {
		expect.assertions(4);

		const stage = makeStageFixture();
		const missing: EmulatorStageMapping = {
			dataModelPath: "ReplicatedStorage/PacketProfiler/Components",
			fsPath: "/repo/submodules/packet-profiler/src/Components",
		};
		let stageCalls = 0;
		const launches: Array<CapturedLaunch> = [];
		const backend = new EmulatorBackend({
			config: createResolvedConfig({ rootDir: "/repo" }),
			launch: async (request) => {
				launches.push({ args: request.args, reePath: request.reePath });
				return { done: Promise.resolve(reeSummary(jestResult(0))) };
			},
			stage: () => {
				stageCalls += 1;
				landOnSecondStage({ calls: stageCalls, missing, stage });
				return {
					mappings: [...stage.stage.mappings, missing],
					stageDirectory: stage.stage.stageDirectory,
				};
			},
			writeFile: () => {},
		});

		const result = await backend.runTestsAsync(makeBackendOptions([makeJob()]));
		stage.cleanup();

		expect(stageCalls).toBe(2);

		expect(result.rawResults).toHaveLength(1);
		expect(launches).toHaveLength(1);
		expect(launches[0]!.args).toContain(
			`${missing.dataModelPath}=${stage.stage.stageDirectory.replaceAll("\\", "/")}/${missing.dataModelPath}`,
		);
	});

	it("should retry a launch once when ree reports a missing mount path", async () => {
		expect.assertions(5);

		const pathMiss = {
			code: 1,
			stderr: "ree run: ReplicatedStorage/PacketProfiler/Components=/stage/ReplicatedStorage/PacketProfiler/Components: The system cannot find the path specified. (os error 3)\n",
			stdout: "",
		};
		const { backend, launches } = makeBackend([pathMiss, reeSummary(jestResult(0))]);

		const result = await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		expect(launches).toHaveLength(2);

		expect(result.rawResults).toHaveLength(1);
		expect(numberFailedTestsOf(result.rawResults[0]!.entry.jestOutput)).toBe(0);

		// The retry is a relaunch of the same prepared run, not a re-stage.
		expect(launches[1]!.args).toStrictEqual(launches[0]!.args);
		expect(launches[1]!.reePath).toBe(launches[0]!.reePath);
	});

	it("should fail the run when the retried launch misses a mount path again", async () => {
		expect.assertions(2);

		const pathMiss = {
			code: 1,
			stderr: "ree run: cannot find the path specified (os error 3)\n",
			stdout: "",
		};
		const { backend, launches } = makeBackend([pathMiss, pathMiss]);

		await expect(backend.runTestsAsync(makeBackendOptions([makeJob()]))).rejects.toThrow(
			"exited 1 without a summary",
		);

		// Bounded: exactly one retry, never a loop.
		expect(launches).toHaveLength(2);
	});

	it("should propagate a staging error that is not a missing mount", async () => {
		expect.assertions(1);

		const backend = new EmulatorBackend({
			config: createResolvedConfig({ rootDir: "/repo" }),
			launch: async () => ({ done: Promise.resolve(reeSummary(jestResult(0))) }),
			stage: () => {
				throw new Error("place.project.json is not readable");
			},
			writeFile: () => {},
		});

		// The rebuild is for a missing mount only: a stage that cannot even
		// read its project must fail on the first attempt, not be retried.
		await expect(backend.runTestsAsync(makeBackendOptions([makeJob()]))).rejects.toThrow(
			"place.project.json is not readable",
		);
	});
});
