import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
	ensureArtifactsDir,
	openPrivateArtifactForAppend,
	readPrivateArtifact,
	writeArtifact,
} from "../../src/shared/artifacts.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .pi-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});

	it("contains session-preference artifacts under an explicit invocation directory", () => {
		const sessionDir = path.join("tmp", "sessions", "invocation");
		assert.equal(getArtifactsDir(null, undefined, "session", sessionDir), path.resolve(sessionDir, "artifacts"));
		assert.equal(getArtifactsDir(null, "repo", "project", sessionDir), path.join("repo", ".pi-subagents", "artifacts"));
		assert.equal(getArtifactsDir(null, "repo", "temp", sessionDir), getArtifactsDir(null, undefined, "temp"));
	});

	it("creates private artifact directories and files and rejects symlink targets", { skip: process.platform === "win32" ? "POSIX permissions/symlinks" : undefined }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));
		try {
			const artifacts = path.join(root, "artifacts");
			ensureArtifactsDir(artifacts);
			const artifact = path.join(artifacts, "report.md");
			writeArtifact(artifact, "private");
			assert.equal(fs.statSync(artifacts).mode & 0o777, 0o700);
			assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
			const appendPath = path.join(artifacts, "events.jsonl");
			const appendFd = openPrivateArtifactForAppend(appendPath);
			fs.writeFileSync(appendFd, "event\n");
			fs.closeSync(appendFd);
			assert.equal(fs.statSync(appendPath).mode & 0o777, 0o600);
			fs.symlinkSync(path.join(root, "elsewhere"), path.join(artifacts, "link.md"));
			assert.throws(() => writeArtifact(path.join(artifacts, "link.md"), "nope"), /Unsafe artifact file/);
			assert.throws(() => openPrivateArtifactForAppend(path.join(artifacts, "link.md")), /Unsafe artifact file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked directory components without touching the linked target", { skip: process.platform === "win32" ? "POSIX symlinks" : undefined }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-component-"));
		try {
			const artifacts = path.join(root, "artifacts");
			const external = path.join(root, "external");
			ensureArtifactsDir(artifacts);
			fs.mkdirSync(external);
			fs.symlinkSync(external, path.join(artifacts, "linked-dir"));
			assert.throws(() => writeArtifact(path.join(artifacts, "linked-dir", "victim.md"), "must not write"), /Unsafe symlink component/);
			assert.equal(fs.existsSync(path.join(external, "victim.md")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects hard-linked runtime artifacts before read or overwrite", { skip: process.platform === "win32" ? "POSIX hard links" : undefined }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-hardlink-"));
		try {
			const artifacts = path.join(root, "artifacts");
			const victim = path.join(root, "external-victim.md");
			const linkedArtifact = path.join(artifacts, "report.md");
			ensureArtifactsDir(artifacts);
			fs.writeFileSync(victim, "external victim", "utf-8");
			fs.linkSync(victim, linkedArtifact);
			assert.throws(() => readPrivateArtifact(linkedArtifact), /Unsafe artifact file/);
			assert.throws(() => writeArtifact(linkedArtifact, "must not overwrite"), /Unsafe artifact file/);
			assert.throws(() => openPrivateArtifactForAppend(linkedArtifact), /Unsafe artifact file/);
			assert.equal(fs.readFileSync(victim, "utf-8"), "external victim");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hardens a runtime leaf without chmodding its caller-owned base", { skip: process.platform === "win32" ? "POSIX permissions" : undefined }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-modes-"));
		try {
			const callerBase = path.join(root, "caller-base");
			const invocation = path.join(callerBase, "invocation-run");
			fs.mkdirSync(invocation, { recursive: true, mode: 0o755 });
			fs.chmodSync(callerBase, 0o755);
			fs.chmodSync(invocation, 0o755);
			ensureArtifactsDir(invocation);
			assert.equal(fs.statSync(callerBase).mode & 0o777, 0o755);
			assert.equal(fs.statSync(invocation).mode & 0o777, 0o700);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
