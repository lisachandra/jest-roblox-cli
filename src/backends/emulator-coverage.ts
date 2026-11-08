import * as fs from "node:fs";
import * as path from "node:path";

import { COVERAGE_MANIFEST_PATH } from "../coverage-pipeline/prepare.ts";
import type { EmulatorStageMapping } from "./emulator-stage.ts";

/**
 * Overwrites the staged Luau files with their coverage-instrumented twins so
 * the run collects probe hits. Ree mounts directories, so a twin must sit at
 * the exact staged path its original occupies — legal because the
 * instrumenter keeps twins line-for-line aligned with their originals, which
 * leaves every Instance path and source map valid.
 *
 * A missing or malformed manifest warns and applies nothing: the run still
 * executes, and the report step reports the empty coverage like the Studio
 * lanes do.
 *
 * @param root0
 * @returns The number of twins applied.
 */
export function applyCoverageTwins({
	mappings,
	rootDirectory,
	stageDirectory,
}: {
	mappings: ReadonlyArray<EmulatorStageMapping>;
	rootDirectory: string;
	stageDirectory: string;
}): number {
	const manifestPath = path.resolve(rootDirectory, COVERAGE_MANIFEST_PATH);
	const files = readManifestFiles(manifestPath);
	if (files === undefined) {
		return 0;
	}

	const ordered = mappings.toSorted((left, right) => right.fsPath.length - left.fsPath.length);
	let applied = 0;
	for (const [fileKey, record] of Object.entries(files)) {
		const twinPath = recordString(record, "instrumentedLuauPath");
		if (twinPath === undefined) {
			continue;
		}

		const stagedPath = stagedPathFor({
			ordered,
			original: recordString(record, "originalLuauPath") ?? fileKey,
			rootDirectory,
			stageDirectory,
		});
		if (stagedPath === undefined || !fs.existsSync(stagedPath)) {
			continue;
		}

		fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
		fs.copyFileSync(path.resolve(rootDirectory, twinPath), stagedPath);
		applied += 1;
	}

	return applied;
}

/**
 * Reads the manifest's `files` records, warning when the coverage staging did
 * not leave a usable manifest behind.
 *
 * @param manifestPath
 * @returns The file records, or undefined when the manifest is absent/malformed.
 */
function readManifestFiles(manifestPath: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		console.warn(
			"[jest-roblox] emulator: no coverage manifest beside the stage; continuing without instrumented sources",
		);
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || !("files" in parsed)) {
		console.warn(
			"[jest-roblox] emulator: coverage manifest is malformed; continuing without instrumented sources",
		);
		return undefined;
	}

	const files: unknown = parsed.files;
	if (typeof files !== "object" || files === null) {
		return undefined;
	}

	return Object.fromEntries(Object.entries(files));
}

/**
 * Resolves the staged path of an original file by longest-prefix mount match.
 *
 * @param root0
 * @returns The staged path, or undefined when no mount owns the file.
 */
function stagedPathFor({
	ordered,
	original,
	rootDirectory,
	stageDirectory,
}: {
	ordered: ReadonlyArray<EmulatorStageMapping>;
	original: string;
	rootDirectory: string;
	stageDirectory: string;
}): string | undefined {
	const absolute = path.resolve(rootDirectory, original.replaceAll("\\", "/"));
	for (const mapping of ordered) {
		const relative = path.relative(path.resolve(mapping.fsPath), absolute);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			continue;
		}

		return path.join(stageDirectory, mapping.dataModelPath, relative);
	}

	return undefined;
}

/**
 * The record's string field, or undefined when absent or mistyped.
 * @param record
 * @param field
 */
function recordString(record: unknown, field: string): string | undefined {
	if (typeof record !== "object" || record === null || !(field in record)) {
		return undefined;
	}

	const container: Record<string, unknown> = Object.fromEntries(Object.entries(record));
	const value: unknown = container[field];
	return typeof value === "string" ? value : undefined;
}
