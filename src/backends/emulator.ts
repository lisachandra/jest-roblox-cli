import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import {
	collectJobRoots,
	collectSetupFiles,
	deriveRunContext,
	failedJestOutput,
	parseSummary,
	type ReeOutputEntry,
	tail,
	toInstancePattern,
} from "./emulator-context.ts";
import { applyCoverageTwins } from "./emulator-coverage.ts";
import { buildEmulatorHarnessLuau } from "./emulator-harness.luau.ts";
import type { EmulatorStageResult } from "./emulator-stage.ts";
import { assertStagedMounts, EmulatorStagingError, stageEmulatorMounts } from "./emulator-stage.ts";
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
/**
 * What ree says when a `--mount` target is not on disk. Windows reports the
 * path in the message with `os error 3`; the message text is stable across
 * the platforms that reach this branch.
 */
const MOUNT_PATH_MISS_PATTERN = /(?:os error 3\b|cannot find the path specified)/iu;

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
		this.launch =
			options.launch ?? defaultLauncher(options.processRunner ?? nodeChildProcessRunner);
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

	/**
	 * Launches one ree process and waits for its outcome.
	 *
	 * @param args - The full argument list for `ree run`.
	 * @returns The process exit code and captured output.
	 */
	private async launchRunAsync(
		args: Array<string>,
	): Promise<{ code: number; stderr: string; stdout: string }> {
		const run = await this.launch({
			args,
			cwd: this.config.rootDir,
			reePath: this.reePath,
		});
		return run.done;
	}

	private prepareOnce(firstJob: ProjectJob): PreparedRun {
		// A stage that leaves a mount missing is rebuilt once before it is
		// reported: the miss is usually a link that dangled mid-copy, and a
		// second walk of the tree resolves or drops it for good. Only a miss
		// that survives the rebuild is a staging failure worth failing the run
		// on — and it fails here, naming both ends of the pair, instead of at
		// ree launch as a bare "cannot find the path specified".
		const prepared = this.stageOnce(firstJob);
		try {
			this.verifyMounts(prepared);
			return prepared;
		} catch (err) {
			if (!(err instanceof EmulatorStagingError)) {
				throw err;
			}

			console.warn(`[jest-roblox] emulator: ${err.message}\nRebuilding the stage once.`);
		}

		const rebuilt = this.stageOnce(firstJob);
		this.verifyMounts(rebuilt);
		return rebuilt;
	}

	private async runJobAsync(job: ProjectJob, prepared: PreparedRun): Promise<EnvelopeEntry> {
		const emulatorConfig = this.config.emulator;
		const startedAt = Date.now();

		const roots = collectJobRoots(job, prepared.stage.mappings);
		const setupFiles = collectSetupFiles(job, prepared.stage.mappings);
		const ignorePatterns = (emulatorConfig?.ignorePatterns ?? []).map(toInstancePattern);

		const context = {
			ci: false,
			coverage: this.config.collectCoverage,
			ignorePatterns,
			pattern: job.config.testPathPattern,
			roots,
			runnerPath: job.config.jestPath,
			setupFiles,
			testNamePattern: job.config.testNamePattern,
			verbose: false,
		};

		const args = [
			"run",
			"--harness",
			prepared.harnessPath,
			...prepared.mountArgs,
			"--mode",
			"play",
			"--seconds",
			String(emulatorConfig?.seconds ?? DEFAULT_SECONDS),
			"--run-context",
			deriveRunContext(roots),
			"--context",
			JSON.stringify(context),
		];

		// Verify immediately before the launch: the stage was built once for
		// the whole run and is read by every job, so a mount directory removed
		// since then would surface as ree's path miss rather than as the
		// staging problem it is. Throwing here names the mapping and its source.
		this.verifyMounts(prepared);
		let outcome = await this.launchRunAsync(args);

		// One retry when ree reports a mount path miss. Re-staging here would
		// mean mutating a stage other jobs may still be reading, so the retry
		// re-verifies and relaunches: a miss that was transient (a filesystem
		// still settling, a cleaner that has moved on) resolves, and one that
		// persists fails at `verifyMounts` with the mapping named. The retry is
		// bounded to one so a genuinely missing mount cannot loop.
		if (isMountPathMiss(outcome)) {
			console.warn(
				`[jest-roblox] emulator: ree reported a missing mount path; verifying the stage and retrying once: ${tail(outcome.stderr)}`,
			);
			this.verifyMounts(prepared);
			outcome = await this.launchRunAsync(args);
		}

		const summary = parseSummary(outcome.stdout, outcome);

		const output = summary.output ?? [];
		const markerEntry = output.find((entry): entry is ReeOutputEntry & { message: string } => {
			return entry.message?.startsWith(JEST_RESULTS_MARKER) === true;
		});
		const gameOutput = JSON.stringify(
			output.filter((entry) => {
				return (
					entry.message === undefined || !entry.message.startsWith(JEST_RESULTS_MARKER)
				);
			}),
		);

		if (markerEntry === undefined) {
			const error = new LuauScriptError(
				`emulator run produced no test results (status ${summary.status ?? "unknown"}): ${tail(
					outcome.stderr,
					outcome.stdout,
				)}`,
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

	private stageOnce(firstJob: ProjectJob): PreparedRun {
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
				emulatorConfig?.rojoProjectPath ??
					firstJob.config.rojoProject ??
					"default.project.json",
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
			mountArgs.push(
				"--mount",
				`${mapping.dataModelPath}=${stageRoot}/${mapping.dataModelPath}`,
			);
		}

		// Studio-authored containers (ReplicatedStorage.{UI,Models,VFX,...}) are
		// spliced into the Studio place by the place pipeline; the emulator lane
		// loads them as ree snapshots (`<Service>.rbxm` bundles, exported from
		// the place cache). Missing exports degrade to the harness's empty
		// container stubs, so a fresh checkout without the place cache still
		// runs specs that only need the containers to exist.
		if (emulatorConfig?.snapshotsDirectory !== undefined) {
			const snapshotsDirectory = path.resolve(
				this.config.rootDir,
				emulatorConfig.snapshotsDirectory,
			);
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

	/**
	 * Fails when a stage mapping has no directory under the stage root.
	 *
	 * Called once at staging and again immediately before every launch: the
	 * stage is built once per run and read many times, so a directory that was
	 * removed between the two — a cleaner running alongside, a tree rewritten
	 * by a later stage attempt — would otherwise reach ree as a path miss.
	 *
	 * @param prepared - The prepared run whose stage must be intact.
	 * @throws {EmulatorStagingError} Naming every mapping the stage is missing.
	 */
	private verifyMounts(prepared: PreparedRun): void {
		assertStagedMounts({
			mappings: prepared.stage.mappings,
			stageDirectory: prepared.stage.stageDirectory,
		});
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

/**
 * Whether ree's outcome reads as a missing mount directory rather than as a
 * script failure. Ree reports a `--mount` target it cannot open before any
 * Luau runs, so a run carrying this text produced no results at all.
 *
 * @param outcome - The failed ree outcome.
 * @returns True when the process output names a mount path miss.
 */
function isMountPathMiss(outcome: { code: number; stderr: string; stdout: string }): boolean {
	if (outcome.code === 0) {
		return false;
	}

	return (
		MOUNT_PATH_MISS_PATTERN.test(outcome.stderr) || MOUNT_PATH_MISS_PATTERN.test(outcome.stdout)
	);
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
