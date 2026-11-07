import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import type { EmulatorRun } from "./emulator.ts";
import { EmulatorBackend, parseSummary, resolveInstancePath, toInstancePattern } from "./emulator.ts";
import type { EmulatorStageMapping, EmulatorStageResult } from "./emulator-stage.ts";

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

function jestResult(numFailedTests: number): string {
	return JSON.stringify({
		numFailedTests,
		numPassedTests: numFailedTests === 0 ? 2 : 1,
		numTotalTests: 2,
		success: numFailedTests === 0,
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

interface CapturedLaunch {
	args: Array<string>;
	reePath: string;
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

describe("emulatorBackend", () => {
	it("should run one ree process per job and parse the envelope", async () => {
		expect.assertions(6);

		const { backend, launches } = makeBackend([reeSummary(jestResult(0)), reeSummary(jestResult(0))]);
		const result = await backend.runTestsAsync(makeBackendOptions([makeJob(), makeJob()]));

		expect(result.rawResults).toHaveLength(2);
		expect((JSON.parse(result.rawResults[0]!.entry.jestOutput) as { numFailedTests: number }).numFailedTests).toBe(0);
		expect(result.rawResults[0]!.entry.project).toBe("client");
		expect(result.rawResults[1]!.entry.project).toBe("client");
		expect(launches).toHaveLength(2);
		expect(result.timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should build mount and context args from the stage mappings", async () => {
		expect.assertions(7);

		const { backend, launches, writes } = makeBackend([reeSummary(jestResult(0))]);
		await backend.runTestsAsync(makeBackendOptions([makeJob()]));

		const args = launches[0]!.args;
		const context = JSON.parse(args[args.indexOf("--context") + 1]!) as Record<string, unknown>;

		expect(args).toContain("--harness");
		expect(args).toContain("--mount");
		expect(args).toContain("ReplicatedStorage/TS/client=/stage/ReplicatedStorage/TS/client");
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

		const args = launches[0]!.args;
		const context = JSON.parse(args[args.indexOf("--context") + 1]!) as {
			ignorePatterns: Array<string>;
		};
		expect(context.ignorePatterns).toStrictEqual(["server/tests/simulation.spec"]);
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

		expect((JSON.parse(result.rawResults[0]!.entry.jestOutput) as { numFailedTests: number }).numFailedTests).toBe(2);
	});

	it("should throw a LuauScriptError when the run carries no results", async () => {
		expect.assertions(2);

		const stdout = `${JSON.stringify({
			errors: ["harness crashed"],
			output: [{ kind: "error", message: "attempt to index nil" }],
			status: "error",
		})}\n`;
		const { backend } = makeBackend([{ code: 0, stderr: "", stdout }]);
		const run = backend.runTestsAsync(makeBackendOptions([makeJob()]));

		await expect(run).rejects.toThrow("produced no test results");
		await run.catch((err: unknown) => {
			expect((err as Error & { gameOutput?: string }).gameOutput).toContain(
				"attempt to index nil",
			);
		});
	});

	it("should throw a LuauScriptError when ree exits without a summary", async () => {
		expect.assertions(1);

		const { backend } = makeBackend([{ code: 126, stderr: "ree: script timeout", stdout: "" }]);
		const run = backend.runTestsAsync(makeBackendOptions([makeJob()]));

		await expect(run).rejects.toThrow("exited 126 without a summary");
	});
});

describe("parseSummary", () => {
	it("should read the trailing JSON summary from ree stdout", () => {
		expect.assertions(2);

		const summary = parseSummary('status line\n{"output":[],"status":"ok"}\n', {
			code: 0,
			stderr: "",
		});

		expect(summary.status).toBe("ok");
		expect(summary.output).toStrictEqual([]);
	});

	it("should reject stdout without a summary object", () => {
		expect.assertions(1);

		expect(() => parseSummary("no json here\n", { code: 1, stderr: "boom" })).toThrow(
			"exited 1 without a summary",
		);
	});
});

describe("toInstancePattern", () => {
	it("should strip src prefixes and TypeScript extensions", () => {
		expect.assertions(4);

		expect(toInstancePattern("src/server/tests/simulation.spec.ts")).toBe(
			"server/tests/simulation.spec",
		);
		expect(toInstancePattern("src/client/ui/init.spec.tsx")).toBe("client/ui/init.spec");
		expect(toInstancePattern("ui/hud/ballCam")).toBe("ui/hud/ballCam");
		expect(toInstancePattern("src/shared/index.ts")).toBe("shared/init");
	});
});

describe("resolveInstancePath", () => {
	it("should map a file under a mount to its DataModel path", () => {
		expect.assertions(3);

		expect(
			resolveInstancePath("/repo/out/client/ui/hud/ballCam.spec.luau", "/repo", MAPPINGS),
		).toBe("ReplicatedStorage/TS/client/ui/hud/ballCam.spec.luau");
		expect(resolveInstancePath("./out/test/setup", "/repo", MAPPINGS)).toBe(
			"ReplicatedStorage/TS/test/setup",
		);
		expect(resolveInstancePath("/repo/unknown/where.luau", "/repo", MAPPINGS)).toBeUndefined();
	});
});
