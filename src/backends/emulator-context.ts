import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import type { ProjectJob } from "./interface.ts";
import type { EmulatorStageMapping } from "./emulator-stage.ts";

/** One output entry of ree's run summary. */
export interface ReeOutputEntry {
	/** The entry kind (`print`, `error`, ...). */
	kind?: string | undefined;
	/** The message text, when the entry carries one. */
	message?: string | undefined;
}

/** The run summary ree prints as its final stdout JSON value. */
export interface ReeSummary {
	/** Whether the run reached its normal end. */
	done?: boolean | undefined;
	/** Harness-reported errors, when the run failed. */
	errors?: Array<unknown> | undefined;
	/** The failure descriptor, when ree stopped the script. */
	failure?: unknown;
	/** In-order output entries the script produced. */
	output?: Array<ReeOutputEntry> | undefined;
	/** The run outcome (`ok`, `error`, `yielded`). */
	status?: string | undefined;
}

/** A stage's root directory and mount mappings, for path resolution. */
export interface EmulatorPathResolver {
	/** Stage mappings; the longest matching prefix owns a path. */
	mappings: ReadonlyArray<EmulatorStageMapping>;
	/** Absolute directory test files resolve against. */
	rootDirectory: string;
}

const ERROR_TAIL_LINES = 15;
const LEADING_DOT_SLASH = /^\.\//u;
const LEADING_SRC = /^src\//u;
const INDEX_RENAME = /(^|\/)index(\.spec)?$/iu;
const TS_EXTENSION = /\.tsx?$/iu;

/**
 * Normalizes a filesystem-style pattern fragment to the Instance-path shape
 * the in-runner matcher sees: `src/` prefixes drop, TypeScript extensions
 * strip (`x.spec.ts` keeps its `.spec`), and `index` renames to `init`.
 *
 * @param pattern - Filesystem-style pattern fragment.
 * @returns The Instance-path-shaped pattern.
 */
export function toInstancePattern(pattern: string): string {
	const normalized = pattern.replaceAll("\\", "/").replace(LEADING_SRC, "").replace(TS_EXTENSION, "");
	return normalized.replace(INDEX_RENAME, "$1init$2");
}

/**
 * Resolves a filesystem path against the stage mappings by longest-prefix
 * match, mirroring how the mount was written to disk.
 *
 * @param file - Absolute or rootDir-relative filesystem path.
 * @param resolver - Root directory and stage mappings to resolve against.
 * @returns The slash-separated DataModel path, or undefined when no mount owns it.
 */
export function resolveInstancePath(
	file: string,
	resolver: EmulatorPathResolver,
): string | undefined {
	const cleaned = file.replaceAll("\\", "/").replace(LEADING_DOT_SLASH, "");
	const candidates = path.posix.isAbsolute(cleaned)
		? [cleaned]
		: [path.posix.join(resolver.rootDirectory.replaceAll("\\", "/"), cleaned)];

	const owner = longestOwningMapping(candidates, resolver.mappings);
	if (owner === undefined) {
		return undefined;
	}

	const prefix = owner.fsPath.replaceAll("\\", "/");
	const suffix = candidates
		.map((candidate) => relativeUnder(prefix, candidate))
		.find((relative) => relative !== undefined);
	if (suffix === undefined) {
		return undefined;
	}

	const parts = [...owner.dataModelPath.split("/")];
	for (const part of suffix.split("/")) {
		if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return parts.join("/");
}

/**
 * Derives the DataModel roots a job's runner discovers under: the mount owning
 * the project's compiled output directory.
 *
 * @param job - The runtime job.
 * @param mappings - Stage mappings.
 * @returns The mount-owning DataModel paths, in stage order when nothing matches.
 */
export function collectJobRoots(
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

	const resolver: EmulatorPathResolver = { mappings, rootDirectory: job.config.rootDir };
	const outDirectory = readOutDirectory(job);
	if (outDirectory !== undefined) {
		const instancePath = resolveInstancePath(outDirectory, resolver);
		if (instancePath !== undefined) {
			return [instancePath];
		}
	}

	return mappings.map((mapping) => mapping.dataModelPath);
}

/**
 * Maps the job's setup files onto their staged DataModel paths.
 *
 * @param job - The runtime job.
 * @param mappings - Stage mappings.
 * @returns The Instance paths, falling back to the authored path per entry.
 */
export function collectSetupFiles(
	job: ProjectJob,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): Array<string> {
	const resolver: EmulatorPathResolver = { mappings, rootDirectory: job.config.rootDir };
	const resolved: Array<string> = [];
	const setupFiles = job.config.setupFiles ?? [];
	for (const setupFile of setupFiles) {
		resolved.push(resolveInstancePath(setupFile, resolver) ?? setupFile);
	}

	return resolved;
}

/**
 * Reads the Jest aggregate result and reports whether any test failed.
 *
 * @param jestOutput - The envelope entry's nested Jest result JSON.
 * @returns Whether `numFailedTests` is a positive number.
 */
export function failedJestOutput(jestOutput: string): boolean {
	try {
		const parsed: unknown = JSON.parse(jestOutput);
		if (typeof parsed !== "object" || parsed === null || !("numFailedTests" in parsed)) {
			return false;
		}

		const { numFailedTests: failedTests } = parsed;
		return typeof failedTests === "number" && failedTests > 0;
	} catch {
		return false;
	}
}

/**
 * Returns the last lines of the joined outputs, for error messages.
 *
 * @param parts - Outputs to join and trim.
 * @returns The trailing lines, or "no output" when everything is blank.
 */
export function tail(...parts: Array<string>): string {
	const text = parts.join("\n").trim();
	if (text === "") {
		return "no output";
	}

	return text.split("\n").slice(-ERROR_TAIL_LINES).join("\n");
}

/**
 * Parses ree's run summary: the single JSON value it prints to stdout at the
 * end of the run. A run that exits without one surfaces as a
 * {@link LuauScriptError} so the CLI reports it like any runner failure.
 *
 * @param stdout - The ree process stdout.
 * @param outcome - Exit code and stderr for the error message.
 * @returns The parsed summary.
 */
export function parseSummary(stdout: string, outcome: { code: number; stderr: string }): ReeSummary {
	const lines = stdout.split("\n").map((line) => line.trimEnd());
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").trim();
		if (!line.startsWith("{")) {
			continue;
		}

		const parsed: unknown = JSON.parse(line);
		if (isReeSummary(parsed)) {
			return parsed;
		}
	}

	throw new LuauScriptError(
		`emulator run exited ${outcome.code.toString()} without a summary: ${tail(outcome.stderr, stdout)}`,
	);
}

/**
 * Returns the part of `candidate` under `prefix`.
 *
 * @param prefix - Posix prefix directory.
 * @param candidate - Posix path to relativize.
 * @returns The relative path, or undefined when the candidate escapes the prefix.
 */
function relativeUnder(prefix: string, candidate: string): string | undefined {
	const relative = path.posix.relative(prefix, candidate);
	if (relative.startsWith("..") || path.posix.isAbsolute(relative)) {
		return undefined;
	}

	return relative;
}

/**
 * Finds the mapping with the longest prefix owning one candidate path.
 *
 * @param candidate - Normalized posix path to test.
 * @param mappings - Stage mappings.
 * @returns The owning mapping, or undefined when none matches.
 */
function longestMappingFor(
	candidate: string,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): EmulatorStageMapping | undefined {
	let best: EmulatorStageMapping | undefined;
	for (const mapping of mappings) {
		const prefix = mapping.fsPath.replaceAll("\\", "/");
		if (relativeUnder(prefix, candidate) === undefined) {
			continue;
		}

		if (best === undefined || prefix.length > best.fsPath.length) {
			best = mapping;
		}
	}

	return best;
}

/**
 * Finds the mapping whose mount owns any one of the candidate paths,
 * preferring the longest prefix.
 *
 * @param candidates - Normalized posix paths to test.
 * @param mappings - Stage mappings.
 * @returns The owning mapping, or undefined when none matches.
 */
function longestOwningMapping(
	candidates: ReadonlyArray<string>,
	mappings: ReadonlyArray<EmulatorStageMapping>,
): EmulatorStageMapping | undefined {
	let best: EmulatorStageMapping | undefined;
	for (const candidate of candidates) {
		const owner = longestMappingFor(candidate, mappings);
		if (owner !== undefined && (best === undefined || owner.fsPath.length > best.fsPath.length)) {
			best = owner;
		}
	}

	return best;
}

/**
 * Reads the job's per-project compiled output directory, when configured.
 *
 * @param job - The runtime job.
 * @returns The `outDir`, or undefined when the project config omits it.
 */
function readOutDirectory(job: ProjectJob): string | undefined {
	const config = job.config as ResolvedConfig & { outDir?: string | undefined };
	return config.outDir;
}

/**
 * Whether the parsed value carries ree's summary shape.
 * @param value
 */
function isReeSummary(value: unknown): value is ReeSummary {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	return "output" in value || "status" in value;
}
