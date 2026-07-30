import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths, type ArtifactDirPreference } from "./types.ts";
import { getAgentDir } from "./utils.ts";

const CLEANUP_MARKER_FILE = ".last-cleanup";
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function getProjectSubagentsDir(cwd: string): string {
	return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}

export function getProjectArtifactsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "artifacts");
}

export function getProjectChainRunsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "chain-runs");
}

/**
 * Resolve artifacts according to the configured placement policy. An explicit
 * invocation session directory owns its artifacts when session placement is
 * selected, rather than leaking them into the parent session directory.
 */
export function getArtifactsDir(
	sessionFile: string | null,
	projectCwd?: string,
	dirPreference: ArtifactDirPreference = "project",
	invocationSessionDir?: string,
): string {
	switch (dirPreference) {
		case "session":
			if (invocationSessionDir) return path.join(path.resolve(invocationSessionDir), "artifacts");
			if (sessionFile) return path.join(path.dirname(sessionFile), "subagent-artifacts");
			return TEMP_ARTIFACTS_DIR;
		case "temp":
			return TEMP_ARTIFACTS_DIR;
		case "project":
			if (projectCwd) return getProjectArtifactsDir(projectCwd);
			if (sessionFile) return path.join(path.dirname(sessionFile), "subagent-artifacts");
			return TEMP_ARTIFACTS_DIR;
		default:
			throw new Error(`Unsupported artifactDir ${JSON.stringify(dirPreference)}; expected "project", "session", or "temp".`);
	}
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: unknown }).code
		: undefined;
}

function assertOwnedByCurrentUser(stat: fs.Stats, target: string): void {
	if (typeof process.getuid !== "function") return;
	if (stat.uid !== process.getuid()) throw new Error(`Unsafe artifact ownership for '${target}'.`);
}

function assertNoSymlinkComponents(target: string): void {
	const resolved = path.resolve(target);
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink component '${current}'.`);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}

function ensureSafeDirectory(dir: string, privateLeaf: boolean): void {
	const resolved = path.resolve(dir);
	assertNoSymlinkComponents(resolved);
	const missing: string[] = [];
	let cursor = resolved;
	while (!fs.existsSync(cursor)) {
		missing.push(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	const existing = fs.lstatSync(cursor);
	if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Unsafe directory '${cursor}'.`);
	for (const entry of missing.reverse()) {
		fs.mkdirSync(entry, { mode: PRIVATE_DIR_MODE });
		fs.chmodSync(entry, PRIVATE_DIR_MODE);
	}
	const stat = fs.lstatSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe artifact directory '${resolved}'.`);
	if (privateLeaf) {
		assertOwnedByCurrentUser(stat, resolved);
		fs.chmodSync(resolved, PRIVATE_DIR_MODE);
	}
}

/** Create or repair a runtime-owned private directory without chmodding parents. */
export function ensurePrivateDirectory(dir: string): void {
	ensureSafeDirectory(dir, true);
}

/** Validate/create a caller-owned base without changing an existing base mode. */
export function ensureCallerOwnedDirectory(dir: string): void {
	ensureSafeDirectory(dir, false);
}

export function ensureArtifactsDir(dir: string): void {
	ensurePrivateDirectory(dir);
}

function assertPrivateArtifactStat(stat: fs.Stats, filePath: string): void {
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
		throw new Error(`Unsafe artifact file '${filePath}'.`);
	}
	assertOwnedByCurrentUser(stat, filePath);
}

export function assertSafePrivateArtifactFile(filePath: string): void {
	assertNoSymlinkComponents(path.dirname(filePath));
	try {
		assertPrivateArtifactStat(fs.lstatSync(filePath), filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function openPrivateArtifact(filePath: string, mode: "append" | "write"): number {
	ensurePrivateDirectory(path.dirname(filePath));
	assertSafePrivateArtifactFile(filePath);
	const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	// Validate the opened inode before truncation so a hard-link swap cannot
	// mutate an external victim between lstat and open.
	const flags = fs.constants.O_WRONLY
		| fs.constants.O_CREAT
		| (mode === "append" ? fs.constants.O_APPEND : 0)
		| noFollow;
	const fd = fs.openSync(filePath, flags, PRIVATE_FILE_MODE);
	try {
		assertPrivateArtifactStat(fs.fstatSync(fd), filePath);
		fs.fchmodSync(fd, PRIVATE_FILE_MODE);
		if (mode === "write") fs.ftruncateSync(fd, 0);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

export function openPrivateArtifactForAppend(filePath: string): number {
	return openPrivateArtifact(filePath, "append");
}

export function openPrivateArtifactForWrite(filePath: string): number {
	return openPrivateArtifact(filePath, "write");
}

export function ensurePrivateArtifactFile(filePath: string): void {
	ensurePrivateDirectory(path.dirname(filePath));
	assertSafePrivateArtifactFile(filePath);
	const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow, PRIVATE_FILE_MODE);
	try {
		assertPrivateArtifactStat(fs.fstatSync(fd), filePath);
		fs.fchmodSync(fd, PRIVATE_FILE_MODE);
	} finally {
		fs.closeSync(fd);
	}
}

export function readPrivateArtifact(filePath: string): string {
	assertSafePrivateArtifactFile(filePath);
	const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		assertPrivateArtifactStat(fs.fstatSync(fd), filePath);
		fs.fchmodSync(fd, PRIVATE_FILE_MODE);
		return fs.readFileSync(fd, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

function writePrivateFile(filePath: string, content: string, append = false): void {
	const fd = append ? openPrivateArtifactForAppend(filePath) : openPrivateArtifactForWrite(filePath);
	try {
		fs.writeFileSync(fd, content, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

export function writeArtifact(filePath: string, content: string): void {
	writePrivateFile(filePath, content);
}

export function writeMetadata(filePath: string, metadata: object): void {
	writePrivateFile(filePath, JSON.stringify(metadata, null, 2));
}

export function appendArtifact(filePath: string, content: string): void {
	writePrivateFile(filePath, content, true);
}

export function appendJsonl(filePath: string, line: string): void {
	appendArtifact(filePath, `${line}\n`);
}

export function formatOutputArtifactContent(input: {
	output: string;
	error?: string;
	transcriptPath?: string;
	metadataPath?: string;
}): string {
	if (input.output.trim() || !input.error) return input.output;
	const lines = ["Subagent run failed before producing output.", "", "Error:", input.error];
	if (input.transcriptPath) lines.push("", `Transcript: ${input.transcriptPath}`);
	if (input.metadataPath) lines.push(`Metadata: ${input.metadataPath}`);
	return lines.join("\n");
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	try {
		const root = fs.lstatSync(dir);
		if (!root.isDirectory() || root.isSymbolicLink()) return;
	} catch {
		return;
	}

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();
	try {
		const marker = fs.lstatSync(markerPath);
		if (!marker.isSymbolicLink() && now - marker.mtimeMs < 24 * 60 * 60 * 1000) return;
	} catch {
		// No marker yet.
	}

	const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = fs.lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
		} catch {
			// Best-effort cleanup must never follow/remove unsafe entries.
		}
	}
	try {
		writePrivateFile(markerPath, String(now));
	} catch {
		// Best-effort cleanup marker.
	}
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	const sessionsBase = path.join(getAgentDir(), "sessions");
	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsBase);
	} catch {
		return;
	}
	for (const dir of dirs) {
		cleanupOldArtifacts(path.join(sessionsBase, dir, "subagent-artifacts"), maxAgeDays);
	}
}
