import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { decodeEnvelope } from "./envelope.ts";
import type {
	Backend,
	BackendKind,
	BackendOptions,
	BackendResult,
	EnvelopeEntry,
	ProjectJob,
	RawBackendEntry,
} from "./interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import {
	collectJobRoots,
	collectSetupFiles,
	failedJestOutput,
	parseSummary,
	type ReeOutputEntry,
	tail,
	toInstancePattern,
} from "./emulator-context.ts";
import { applyCoverageTwins } from "./emulator-coverage.ts";
import { buildEmulatorHarnessLuau } from "./emulator-harness.luau.ts";
import type { EmulatorStageResult } from "./emulator-stage.ts";
import { stageEmulatorMounts } from "./emulator-stage.ts";

/** One `ree` process: stdout/stderr and the exit outcome. */
export interface EmulatorRun {
	/** Resolves with the process outcome once it closes. */
	readonly done: Promise<{ code: number; stderr: string; stdout: string }>;
}

/** How the backend launches `ree`; tests replace it. */
export type EmulatorLauncher = (request: {
	args: Array<string>;
	cwd: string;
	reePath: string;
}) => Promise<EmulatorRun>;

/**
 * Injectable seams for {@link EmulatorBackend}.
 */
export interface EmulatorBackendOptions {
	/**
	 * Root config: `rootDir` anchors the stage, `emulator` carries the knobs.
	 */
	config: ResolvedConfig;
	/** Launch seam for tests. */
	launch?: EmulatorLauncher | undefined;
	/** Process runner used by the default launcher. */
	processRunner?: ChildProcessRunner | undefined;
	/**
	 * Overrides the `ree` executable (defaults to `emulator.reePath ?? "ree"`).
	 */
	reePath?: string | undefined;
	/** Stage seam for tests. */
	stage?: typeof stageEmulatorMounts | undefined;
	/** Harness write seam for tests. Defaults to `node:fs.writeFileSync`. */
	writeFile?: ((filePath: string, contents: string) => void) | undefined;
}

const JEST_RESULTS_MARKER = "@JEST_RESULTS ";
const DEFAULT_STAGE_DIRECTORY = ".jest-roblox/emulator";
const DEFAULT_SECONDS = 30;

/** One prepared run: the stage, its mount args and the written harness. */
interface PreparedRun {
	harnessPath: string;
	mountArgs: Array<string>;
	stage: EmulatorStageResult;
}

export { parseSummary, resolveInstancePath, toInstancePattern } from "./emulator-context.ts";
export type { ReeSummary } from "./emulator-context.ts";

/**
 * Runs the repo's compiled Luau specs inside the roblox-engine-emulator
 * (`ree`): one `ree run` per job against a physical mount stage mirroring the
 * Rojo project, results parsed from the run's JSON summary. Serial by
 * construction — `ree` runs one engine.
 *
 * Opt-in only (`backend: "emulator"`); Studio stays canonical. See
 * `docs/agents/offline-runtime-spike.md` in the consuming repo for the parity
 * shims the harness installs.
 */
export class EmulatorBackend implements Backend {
	private readonly config: ResolvedConfig;
	private readonly launch: EmulatorLauncher;
	private readonly reePath: string;
	private readonly stage: typeof stageEmulatorMounts;
	private readonly writeFile: (filePath: string, contents: string) => void;

	public readonly kind: BackendKind = "emulator";
	/** The emulator mounts directories; no place is built or opened. */
	public readonly placeInput = "none" as const;

	/** @param options - Config and injectable seams. */
	constructor(options: EmulatorBackendOptions) {
		this.config = options.config;
		this.reePath = options.reePath ?? options.config.emulator?.reePath ?? "ree";
		this.launch = options.launch ?? defaultLauncher(options.processRunner ?? nodeChildProcessRunner);
		this.stage = options.stage ?? stageEmulatorMounts;
		this.writeFile = options.writeFile ?? fs.writeFileSync;
	}

	/**
	 * Runs every job serially through its own `ree run`.
	 * @param options - Jobs, bail and progress hooks.
	 * @returns Envelope entries parallel to the jobs that ran.
	 */
	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		const { jobs } = options;
		const progress = options.progress ?? NOOP_RUN_PROGRESS;
		const executionStart = Date.now();
		const done = progress.begin("tests", describeProjectCount(jobs.length));

		let prepared: PreparedRun | undefined;
		const rawResults: Array<RawBackendEntry> = [];
		const bailedJobIndices: Array<number> = [];

		try {
			for (const [index, job] of jobs.entries()) {
				prepared ??= this.prepareOnce(job);

				const entry = await this.runJobAsync(job, prepared);
				rawResults.push({ entry });

				if (options.bail === true && failedJestOutput(entry.jestOutput)) {
					for (let remaining = index + 1; remaining < jobs.length; remaining += 1) {
						bailedJobIndices.push(remaining);
					}

					break;
				}
			}
		} finally {
			done();
		}

		return {
			bailedJobIndices: bailedJobIndices.length > 0 ? bailedJobIndices : undefined,
			rawResults,
			timing: { executionMs: Date.now() - executionStart },
		};
	}

	private prepareOnce(firstJob: ProjectJob): PreparedRun {
		const emulatorConfig = this.config.emulator;
		const stageDirectory = path.resolve(
			this.config.rootDir,
			emulatorConfig?.stagingDirectory ?? DEFAULT_STAGE_DIRECTORY,
		);
		const stage = this.stage({
			reflectionPath:
				emulatorConfig?.reflectionPath === undefined
					? undefined
					: path.resolve(this.config.rootDir, emulatorConfig.reflectionPath),
			rojoProjectPath: path.resolve(
				this.config.rootDir,
				emulatorConfig?.rojoProjectPath ?? firstJob.config.rojoProject ?? "default.project.json",
			),
			stageDirectory,
		});

		const harnessPath = `${stage.stageDirectory.replaceAll("\\", "/")}/harness.luau`;
		this.writeFile(harnessPath, buildEmulatorHarnessLuau(emulatorConfig?.globals ?? {}));

		// Coverage run: swap the staged originals for their instrumented twins
		// (staging already built the shadow + manifest for every backend); the
		// harness then reports the probe hits as `runner.coverage`.
		if (this.config.collectCoverage) {
			applyCoverageTwins({
				mappings: stage.mappings,
				rootDirectory: this.config.rootDir,
				stageDirectory: stage.stageDirectory,
			});
		}

		const mountArgs: Array<string> = [];
		// ree accepts forward slashes on every platform; mount args stay posix
		// so the stage path reads identically in CI and locally.
		const stageRoot = stage.stageDirectory.replaceAll("\\", "/");
		for (const mapping of stage.mappings) {
			mountArgs.push("--mount", `${mapping.dataModelPath}=${stageRoot}/${mapping.dataModelPath}`);
		}

		// Studio-authored containers (ReplicatedStorage.{UI,Models,VFX,...}) are
		// spliced into the Studio place by the place pipeline; the emulator lane
		// loads them as ree snapshots (`<Service>.rbxm` bundles, exported from
		// the place cache). Missing exports degrade to the harness's empty
		// container stubs, so a fresh checkout without the place cache still
		// runs specs that only need the containers to exist.
		if (emulatorConfig?.snapshotsDirectory !== undefined) {
			const snapshotsDirectory = path.resolve(this.config.rootDir, emulatorConfig.snapshotsDirectory);
			if (fs.existsSync(snapshotsDirectory)) {
				mountArgs.push("--snapshot-dir", snapshotsDirectory);
			} else {
				console.warn(
					`[jest-roblox] emulator: snapshotsDirectory "${emulatorConfig.snapshotsDirectory}" does not exist; continuing with empty container stubs`,
				);
			}
		}

		return {
			harnessPath,
			mountArgs,
			stage,
		};
	}

	private async runJobAsync(job: ProjectJob, prepared: PreparedRun): Promise<EnvelopeEntry> {
		const emulatorConfig = this.config.emulator;
		const startedAt = Date.now();

		const roots = collectJobRoots(job, prepared.stage.mappings);
		const setupFiles = collectSetupFiles(job, prepared.stage.mappings);
		const ignorePatterns = (emulatorConfig?.ignorePatterns ?? []).map(toInstancePattern);

		const context = {
			ci: false,
			coverage:  this.config.collectCoverage,
			ignorePatterns,
			pattern: job.config.testPathPattern,
			roots,
			runnerPath: job.config.jestPath,
			setupFiles,
			testNamePattern: job.config.testNamePattern,
			verbose: false,
		};

		const run = await this.launch({
			args: [
				"run",
				"--harness",
				prepared.harnessPath,
				...prepared.mountArgs,
				"--mode",
				"play",
				"--seconds",
				String(emulatorConfig?.seconds ?? DEFAULT_SECONDS),
				"--context",
				JSON.stringify(context),
			],
			cwd: this.config.rootDir,
			reePath: this.reePath,
		});
		const outcome = await run.done;
		const summary = parseSummary(outcome.stdout, outcome);

		const output = summary.output ?? [];
		const markerEntry = output.find((entry): entry is ReeOutputEntry & { message: string } => {
			return entry.message?.startsWith(JEST_RESULTS_MARKER) === true;
		});
		const gameOutput = JSON.stringify(
			output.filter((entry) => {
				return entry.message === undefined || !entry.message.startsWith(JEST_RESULTS_MARKER);
			}),
		);

		if (markerEntry === undefined) {
			const error = new LuauScriptError(
				`emulator run produced no test results (status ${summary.status ?? "unknown"}): ${ 
					tail(outcome.stderr, outcome.stdout)}`,
			);
			error.gameOutput = gameOutput;
			throw error;
		}

		const envelope = decodeEnvelope(markerEntry.message.slice(JEST_RESULTS_MARKER.length));
		const first = envelope.entries[0];
		if (first === undefined) {
			const error = new LuauScriptError("emulator envelope carried no entries");
			error.gameOutput = gameOutput;
			throw error;
		}

		return {
			elapsedMs: Date.now() - startedAt,
			gameOutput,
			jestOutput: first.jestOutput,
			pkg: job.pkg,
			project: job.displayName,
		};
	}
}

/**
 * Builds an {@link EmulatorBackend} from a resolved root config.
 * @param options - Config and injectable seams.
 * @returns The backend.
 */
export function createEmulatorBackend(options: EmulatorBackendOptions): EmulatorBackend {
	return new EmulatorBackend(options);
}

function defaultLauncher(processRunner: ChildProcessRunner): EmulatorLauncher {
	return async ({ args, cwd, reePath }) => {
		const child = processRunner.spawn(reePath, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Array<Buffer> = [];
		const stderrChunks: Array<Buffer> = [];
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		const outcome = await new Promise<{ code: number; stderr: string; stdout: string }>(
			(resolve, reject) => {
				child.on("error", (error) => {
					reject(new Error(`failed to launch ree (${reePath}): ${error.message}`));
				});
				child.on("close", (code) => {
					resolve({
						code: code ?? -1,
						stderr: Buffer.concat(stderrChunks).toString("utf-8"),
						stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					});
				});
			},
		);
		return { done: Promise.resolve(outcome) };
	};
}
