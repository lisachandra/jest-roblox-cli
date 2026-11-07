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
import { buildEmulatorHarnessLuau } from "./emulator-harness.luau.ts";
import type { EmulatorStageMapping, EmulatorStageResult } from "./emulator-stage.ts";
import { stageEmulatorMounts } from "./emulator-stage.ts";

/** How the backend launches `ree`; tests replace it. */
export type EmulatorLauncher = (request: {
	args: Array<string>;
	cwd: string;
	reePath: string;
}) => Promise<EmulatorRun>;

/** One `ree` process: stdout/stderr and the exit outcome. */
export interface EmulatorRun {
	readonly done: Promise<{ code: number; stderr: string; stdout: string }>;
}

export interface EmulatorBackendOptions {
	/** Root config; `rootDir` anchors the stage, `emulator` carries the knobs. */
	config: ResolvedConfig;
	/** Overrides the `ree` executable (defaults to `emulator.reePath ?? "ree"`). */
	reePath?: string | undefined;
	/** Launch seam for tests. */
	launch?: EmulatorLauncher | undefined;
	/** Process runner used by the default launcher. */
	processRunner?: ChildProcessRunner | undefined;
	/** Stage seam for tests. */
	stage?: typeof stageEmulatorMounts | undefined;
	/** Harness write seam for tests. Defaults to `node:fs.writeFileSync`. */
	writeFile?: ((filePath: string, contents: string) => void) | undefined;
}

interface ReeOutputEntry {
	kind?: string | undefined;
	message?: string | undefined;
}

interface ReeSummary {
	done?: boolean | undefined;
	errors?: Array<unknown> | undefined;
	failure?: unknown;
	output?: Array<ReeOutputEntry> | undefined;
	status?: string | undefined;
}

const JEST_RESULTS_MARKER = "@JEST_RESULTS ";
const DEFAULT_STAGE_DIRECTORY = ".jest-roblox/emulator";
const DEFAULT_SECONDS = 30;
const ERROR_TAIL_LINES = 15;

/**
 * Normalizes a filesystem-style pattern fragment to the Instance-path shape
 * the in-runner matcher sees: `src/` prefixes drop, TypeScript extensions
 * strip (`x.spec.ts` keeps its `.spec`), and `index` renames to `init`.
 */
export function toInstancePattern(pattern: string): string {
	const normalized = pattern.replaceAll("\\", "/").replace(/^src\//, "").replace(/\.tsx?$/i, "");
	return normalized.replace(/(^|\/)index(\.spec)?$/i, "$1init$2");
}

/**
 * Resolves a filesystem path against the stage mappings by longest-prefix
 * match, mirroring how the mount was written to disk.
 * @param file - Absolute or rootDir-relative filesystem path.
 * @returns The slash-separated DataModel path, or undefined when no mount owns it.
 */
export function resolveInstancePath(
	file: string,
	rootDirectory: string,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): string | undefined {
	const cleaned = file.replaceAll("\\", "/").replace(/^\.\//, "");
	const candidates = path.posix.isAbsolute(cleaned)
		? [cleaned]
		: [path.posix.join(rootDirectory.replaceAll("\\", "/"), cleaned)];

	let best: EmulatorStageMapping | undefined;
	for (const candidate of candidates) {
		for (const mapping of mappings) {
			const prefix = mapping.fsPath.replaceAll("\\", "/");
			const relative = path.posix.relative(prefix, candidate);
			if (relative.startsWith("..") || path.posix.isAbsolute(relative)) {
				continue;
			}

			if (best === undefined || prefix.length > best.fsPath.length) {
				best = mapping;
			}
		}
	}

	if (best === undefined) {
		return undefined;
	}

	const suffix = candidates
		.map((candidate) => path.posix.relative(best.fsPath.replaceAll("\\", "/"), candidate))
		.find((relative) => !relative.startsWith(".."));
	if (suffix === undefined) {
		return undefined;
	}

	const parts = [...best.dataModelPath.split("/")];
	for (const part of suffix.split("/")) {
		if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return parts.join("/");
}

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
	public readonly kind: BackendKind = "emulator";

	/** The emulator mounts directories; no place is built or opened. */
	public readonly placeInput = "none" as const;

	private readonly config: ResolvedConfig;
	private readonly launch: EmulatorLauncher;
	private readonly reePath: string;
	private readonly stage: typeof stageEmulatorMounts;
	private readonly writeFile: (filePath: string, contents: string) => void;

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

		const prepared = this.prepareOnce(jobs[0]!);
		const rawResults: Array<RawBackendEntry> = [];
		const bailedJobIndices: Array<number> = [];

		try {
			for (const [index, job] of jobs.entries()) {
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

		const mountArgs: Array<string> = [];
		// ree accepts forward slashes on every platform; mount args stay posix
		// so the stage path reads identically in CI and locally.
		const stageRoot = stage.stageDirectory.replaceAll("\\", "/");
		for (const mapping of stage.mappings) {
			mountArgs.push("--mount", `${mapping.dataModelPath}=${stageRoot}/${mapping.dataModelPath}`);
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
			ignorePatterns,
			pattern: job.config.testPathPattern,
			runnerPath: job.config.jestPath,
			roots,
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
		const markerEntry = output.find(
			(entry): entry is ReeOutputEntry & { message: string } =>
				entry.message !== undefined && entry.message.startsWith(JEST_RESULTS_MARKER),
		);
		const gameOutput = JSON.stringify(
			output.filter(
				(entry) => entry.message === undefined || !entry.message.startsWith(JEST_RESULTS_MARKER),
			),
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

interface PreparedRun {
	harnessPath: string;
	mountArgs: Array<string>;
	stage: EmulatorStageResult;
}

/**
 * Builds an {@link EmulatorBackend} from a resolved root config.
 * @param options - Config and injectable seams.
 * @returns The backend.
 */
export function createEmulatorBackend(options: EmulatorBackendOptions): EmulatorBackend {
	return new EmulatorBackend(options);
}

function collectJobRoots(
	job: ProjectJob,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): Array<string> {
	// The runner discovers specs under whole mount roots, so a job's root is
	// the mount owning its first test file — not the file itself.
	for (const testFile of job.testFiles) {
		const cleaned = testFile.replaceAll("\\", "/");
		for (const mapping of mappings) {
			const prefix = mapping.fsPath.replaceAll("\\", "/");
			if (cleaned === prefix || cleaned.startsWith(`${prefix}/`)) {
				return [mapping.dataModelPath];
			}
		}
	}

	const outDirectory = readOutDirectory(job);
	if (outDirectory !== undefined) {
		const instancePath = resolveInstancePath(outDirectory, job.config.rootDir, mappings);
		if (instancePath !== undefined) {
			return [instancePath];
		}
	}

	return mappings.map((mapping) => mapping.dataModelPath);
}

function readOutDirectory(job: ProjectJob): string | undefined {
	const config = job.config as ResolvedConfig & { outDir?: string | undefined };
	return config.outDir;
}

function collectSetupFiles(
	job: ProjectJob,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): Array<string> {
	const resolved: Array<string> = [];
	for (const setupFile of job.config.setupFiles ?? []) {
		resolved.push(resolveInstancePath(setupFile, job.config.rootDir, mappings) ?? setupFile);
	}

	return resolved;
}

function failedJestOutput(jestOutput: string): boolean {
	try {
		const parsed = JSON.parse(jestOutput) as { numFailedTests?: number };
		return (parsed.numFailedTests ?? 0) > 0;
	} catch {
		return false;
	}
}

/**
 * Parses ree's run summary: the single JSON value it prints to stdout at the
 * end of the run. A run that exits without one surfaces as a
 * {@link LuauScriptError} so the CLI reports it like any runner failure.
 */
export function parseSummary(
	stdout: string,
	outcome: { code: number; stderr: string },
): ReeSummary {
	const lines = stdout.split("\n").map((line) => line.trimEnd());
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!.trim();
		if (!line.startsWith("{")) {
			continue;
		}

		try {
			const parsed = JSON.parse(line) as ReeSummary;
			if (Array.isArray(parsed.output) || typeof parsed.status === "string") {
				return parsed;
			}
		} catch {
			// Not the summary line; keep scanning.
		}
	}

	throw new LuauScriptError(
		`emulator run exited ${outcome.code.toString()} without a summary: ${tail(outcome.stderr, stdout)}`,
	);
}

function tail(...parts: Array<string>): string {
	const text = parts.join("\n").trim();
	if (text === "") {
		return "no output";
	}

	return text.split("\n").slice(-ERROR_TAIL_LINES).join("\n");
}

function defaultLauncher(processRunner: ChildProcessRunner): EmulatorLauncher {
	return async ({ args, cwd, reePath }) => {
		const child = processRunner.spawn(reePath, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Array<Buffer> = [];
		const stderrChunks: Array<Buffer> = [];
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		const done = new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
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
		});
		return { done };
	};
}
