import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSkillInjection,
	clearSkillCache,
	discoverAvailableSkills,
	resolveSkills,
	resolveSkillsWithFallback,
} from "../../src/agents/skills.ts";

let tempDir = "";

const STAN_REVIEWER_SKILLS = [
	"review-plan",
	"review-diff-before-final",
	"validate-code-change",
	"codeguard",
	"codeguard-reviewer",
	"trace-work",
];

function writeSkillFile(skillDir: string, body: string, description = "Test description"): void {
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\ndescription: ${description}\n---\n\n${body}\n`,
		"utf-8",
	);
}

function makeProjectSkill(cwd: string, name: string, body: string, description = "Test description"): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	writeSkillFile(skillDir, body, description);
}

function makeProjectPackageSkill(cwd: string, packageName: string, name: string, body: string): void {
	const packageRoot = path.join(cwd, ".pi", "npm", "node_modules", packageName);
	makePackageSkill(packageRoot, name, body, packageName);
}

function makePackageSkill(packageRoot: string, name: string, body: string, packageName = `${name}-pkg`): void {
	const skillDir = path.join(packageRoot, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${body}\n`, "utf-8");
}

function writePackageManifest(packageRoot: string, skills: string[], packageName = "test-skill-package"): void {
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", pi: { skills } }, null, 2),
		"utf-8",
	);
}

function makeManifestSkill(packageRoot: string, skillsDir: string, name: string, body: string): void {
	writeSkillFile(path.join(packageRoot, skillsDir, name), body, `${name} description`);
}

async function importSkillsFresh() {
	const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const modulePath = path.resolve(projectRoot, "src/agents/skills.ts");
	const bust = `${Date.now()}-${Math.random()}`;
	return await import(`${pathToFileURL(modulePath).href}?bust=${bust}`) as typeof import("../../src/agents/skills.ts");
}

describe("skills filesystem fallback", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-fallback-"));
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers project skills from filesystem paths", () => {
		makeProjectSkill(tempDir, "fallback-skill", "Use fallback mode.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "fallback-skill");
		assert.ok(discovered, "expected fallback-skill to be discovered");
		assert.equal(discovered?.source, "project");
		assert.equal(discovered?.description, "Test description");
	});

	it("discovers project skills nested below grouping directories", () => {
		writeSkillFile(
			path.join(tempDir, ".pi", "skills", "shell", "issue-262-nested-skill"),
			"Use nested project skill.",
			"Nested issue 262 skill",
		);

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "issue-262-nested-skill");
		assert.ok(discovered, "expected grouped nested skill to be discovered");
		assert.equal(discovered?.source, "project");
		assert.equal(discovered?.description, "Nested issue 262 skill");

		const { resolved, missing } = resolveSkills(["issue-262-nested-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.match(resolved[0]?.content ?? "", /Use nested project skill\./);
	});

	it("stops recursive project skill discovery at the first SKILL.md anchor", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		writeSkillFile(path.join(groupedRoot, "issue-262-anchor"), "Use anchor skill.");
		writeSkillFile(path.join(groupedRoot, "issue-262-anchor", "nested", "issue-262-leaked-skill"), "Should not leak.");
		writeSkillFile(path.join(groupedRoot, "issue-262-sibling"), "Use sibling skill.");

		const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(names.includes("issue-262-anchor"), true);
		assert.equal(names.includes("issue-262-sibling"), true);
		assert.equal(names.includes("issue-262-leaked-skill"), false);
	});

	it("skips hidden directories and node_modules while recursing for project skills", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		writeSkillFile(path.join(groupedRoot, ".hidden", "issue-262-hidden-skill"), "Should stay hidden.");
		writeSkillFile(path.join(groupedRoot, "node_modules", "issue-262-node-skill"), "Should stay ignored.");
		writeSkillFile(path.join(groupedRoot, "visible", "issue-262-visible-skill"), "Use visible nested skill.");

		const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(names.includes("issue-262-visible-skill"), true);
		assert.equal(names.includes("issue-262-hidden-skill"), false);
		assert.equal(names.includes("issue-262-node-skill"), false);
	});

	it("keeps direct markdown skills from explicit settings roots after parent recursion", () => {
		const groupedRoot = path.join(tempDir, ".pi", "skills", "group");
		fs.mkdirSync(groupedRoot, { recursive: true });
		fs.writeFileSync(path.join(groupedRoot, "issue-262-direct.md"), "Use direct markdown skill.\n", "utf-8");
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["./skills/group"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-direct"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use direct markdown skill\./);
	});

	it("keeps nested skills from higher-priority explicit settings roots after parent recursion", () => {
		writeSkillFile(
			path.join(tempDir, "skills", "group", "issue-262-settings-nested"),
			"Use settings nested skill.",
		);
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
			"utf-8",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["../skills/group"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-settings-nested"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use settings nested skill\./);
	});

	it("keeps nested skills from higher-priority explicit settings roots when the root path is duplicated", () => {
		writeSkillFile(
			path.join(tempDir, "skills", "group", "issue-262-settings-same-root"),
			"Use settings same root skill.",
		);
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
			"utf-8",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ skills: ["../skills"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["issue-262-settings-same-root"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-settings");
		assert.match(resolved[0]?.content ?? "", /Use settings same root skill\./);
	});

	it("resolves and reads skill content via filesystem fallback", () => {
		makeProjectSkill(tempDir, "resolve-skill", "Run local fallback checks.");

		const { resolved, missing } = resolveSkills(["resolve-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.name, "resolve-skill");
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Run local fallback checks\./);
	});

	it("builds lazy skill references instead of inlining full skill bodies", () => {
		makeProjectSkill(tempDir, "lazy-skill", "This body should stay out of the system prompt.");

		const { resolved, missing } = resolveSkills(["lazy-skill"], tempDir);
		assert.deepEqual(missing, []);

		const injection = buildSkillInjection(resolved);
		assert.match(injection, /The following configured skills are available to this subagent/);
		assert.match(injection, /Use the read tool to load a skill's file/);
		assert.match(injection, /<available_skills>/);
		assert.match(injection, /<name>lazy-skill<\/name>/);
		assert.match(injection, /<description>Test description<\/description>/);
		assert.match(injection, /<location>.*lazy-skill.*SKILL\.md<\/location>/);
		assert.doesNotMatch(injection, /This body should stay out/);
		assert.doesNotMatch(injection, /<skill name=/);
	});

	it("escapes XML-sensitive skill metadata in lazy references", () => {
		makeProjectSkill(tempDir, "amp&skill", "Body", "Use A & B <carefully>");

		const { resolved } = resolveSkills(["amp&skill"], tempDir);
		const injection = buildSkillInjection(resolved);
		assert.match(injection, /<name>amp&amp;skill<\/name>/);
		assert.match(injection, /<description>Use A &amp; B &lt;carefully&gt;<\/description>/);
		assert.match(injection, /amp&amp;skill[\\/]SKILL\.md/);
	});

	it("does not expose pi-subagents as a child-injectable skill", () => {
		makeProjectSkill(tempDir, "pi-subagents", "Parent orchestration only.");
		makeProjectSkill(tempDir, "safe-bash", "Use safe bash.");

		const available = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(available.includes("pi-subagents"), false);
		assert.equal(available.includes("safe-bash"), true);

		const { resolved, missing } = resolveSkills(["pi-subagents", "safe-bash"], tempDir);
		assert.deepEqual(missing, ["pi-subagents"]);
		assert.deepEqual(resolved.map((skill) => skill.name), ["safe-bash"]);

		const agentDir = path.join(tempDir, "agent");
		writeSkillFile(path.join(agentDir, "skills", "pi-subagents"), "Still parent-only.");
		const local = resolveSkills(["pi-subagents"], tempDir, ["./skills"], agentDir);
		assert.deepEqual(local.resolved, []);
		assert.deepEqual(local.missing, ["pi-subagents"]);
	});

	it("classifies package-provided skills as project-package", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "pkg-skill", "Use package skill.");

		const skills = discoverAvailableSkills(tempDir);
		const discovered = skills.find((skill) => skill.name === "pkg-skill");
		assert.ok(discovered, "expected pkg-skill to be discovered");
		assert.equal(discovered?.source, "project-package");
	});

	it("prefers project skills over project-package skills with the same name", () => {
		makeProjectPackageSkill(tempDir, "test-skill-package", "shared-skill", "Package version");
		makeProjectSkill(tempDir, "shared-skill", "Project version");

		const { resolved, missing } = resolveSkills(["shared-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Project version/);
	});

	it("discovers skills from project settings packages", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "local-skill-pkg");
		makePackageSkill(packageRoot, "settings-package-skill", "Settings package skill.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/local-skill-pkg"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["settings-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers skills from project settings npm package sources", () => {
		const packageRoot = path.join(tempDir, ".pi", "npm", "node_modules", "@scope", "skill-package");
		makePackageSkill(
			packageRoot,
			"project-settings-scoped-npm-package-skill",
			"Project settings scoped npm package skill.",
			"@scope/skill-package",
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:@scope/skill-package@1.2.3"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["project-settings-scoped-npm-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers the six Stan reviewer skills from a one-level Pi manifest glob", () => {
		const packageRoot = path.join(tempDir, ".pi", "git", "github.com", "StanleyOneG", "stan_stack");
		writePackageManifest(packageRoot, [".pi/skills/*/SKILL.md"], "stan_stack");
		for (const skillName of STAN_REVIEWER_SKILLS) {
			makeManifestSkill(packageRoot, ".pi/skills", skillName, `Use ${skillName}.`);
		}
		fs.writeFileSync(path.join(packageRoot, ".pi", "skills", "SKILL-INDEX.md"), "Package skill index.\n", "utf-8");
		makeManifestSkill(packageRoot, ".pi/skills", ".hidden-skill", "Must not be exposed.");
		makeManifestSkill(packageRoot, ".pi/skills/group", "nested-skill", "Must not be exposed.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["git:github.com/StanleyOneG/stan_stack@v0.4.0"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(STAN_REVIEWER_SKILLS, tempDir);
		assert.deepEqual(missing, []);
		assert.deepEqual(resolved.map((skill) => skill.name), STAN_REVIEWER_SKILLS);
		assert.deepEqual(resolved.map((skill) => skill.source), STAN_REVIEWER_SKILLS.map(() => "project-package"));
		assert.deepEqual(
			resolved.map((skill) => skill.path),
			STAN_REVIEWER_SKILLS.map((name) => path.join(packageRoot, ".pi", "skills", name, "SKILL.md")),
		);

		const names = discoverAvailableSkills(tempDir).map((skill) => skill.name);
		assert.equal(names.includes("SKILL-INDEX"), false);
		assert.equal(names.includes(".hidden-skill"), false);
		assert.equal(names.includes("nested-skill"), false);
	});

	it("honors manifest exclusions, exact re-inclusions, and final exact exclusions for skill paths", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "manifest-overrides");
		writePackageManifest(packageRoot, [
			"./skills",
			"+skills/reinclude",
			"-skills/final",
			"-skills/final-*",
			"!excluded-by-name",
			"!reinclude",
			"!final",
			"!skills/glob-*",
			"!wildcard-plus",
			"+skills/wildcard-*",
			"+skills/final",
		]);
		makeManifestSkill(packageRoot, "skills", "kept", "Keep this skill.");
		makeManifestSkill(packageRoot, "skills", "excluded-by-name", "Exclude this skill by SKILL.md parent name.");
		makeManifestSkill(packageRoot, "skills", "reinclude", "Reinclude this skill.");
		makeManifestSkill(packageRoot, "skills", "final", "Exclude this skill after re-inclusion.");
		makeManifestSkill(packageRoot, "skills", "glob-hidden", "Exclude this skill with a relative glob.");
		makeManifestSkill(packageRoot, "skills", "wildcard-plus", "Do not re-include this skill with a glob-looking exact path.");
		makeManifestSkill(packageRoot, "skills", "final-keep", "Do not exclude this skill with a glob-looking exact path.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/manifest-overrides"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(
			["kept", "excluded-by-name", "reinclude", "final", "glob-hidden", "wildcard-plus", "final-keep"],
			tempDir,
		);
		assert.deepEqual(resolved.map((skill) => skill.name), ["kept", "reinclude", "final-keep"]);
		assert.deepEqual(missing, ["excluded-by-name", "final", "glob-hidden", "wildcard-plus"]);
	});

	it("expands question-mark package-manifest source globs", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "question-glob");
		writePackageManifest(packageRoot, ["skills/skill-?/SKILL.md"]);
		makeManifestSkill(packageRoot, "skills", "skill-a", "Question glob skill A.");
		makeManifestSkill(packageRoot, "skills", "skill-b", "Question glob skill B.");
		makeManifestSkill(packageRoot, "skills", "skill-aa", "Must not match one question mark.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/question-glob"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["skill-a", "skill-b", "skill-aa"], tempDir);
		assert.deepEqual(resolved.map((skill) => skill.name), ["skill-a", "skill-b"]);
		assert.deepEqual(missing, ["skill-aa"]);
	});

	it("keeps direct manifest file discovery Markdown-only", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "direct-files");
		const skillsRoot = path.join(packageRoot, "skills");
		writePackageManifest(packageRoot, [
			"skills/direct.md",
			"skills/metadata.json",
			"skills/uppercase.MD",
			"skills/skill-directory/SKILL.md",
			"skills/*",
		]);
		fs.mkdirSync(skillsRoot, { recursive: true });
		fs.writeFileSync(path.join(skillsRoot, "direct.md"), "Direct Markdown skill.\n", "utf-8");
		fs.writeFileSync(path.join(skillsRoot, "broad.md"), "Broad-glob Markdown skill.\n", "utf-8");
		fs.writeFileSync(path.join(skillsRoot, "metadata.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(skillsRoot, "script.ts"), "export {};\n", "utf-8");
		fs.writeFileSync(path.join(skillsRoot, "uppercase.MD"), "Not a case-sensitive manifest Markdown match.\n", "utf-8");
		writeSkillFile(path.join(skillsRoot, "skill-directory"), "Direct SKILL.md manifest match.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/direct-files"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(
			["direct", "broad", "skill-directory", "metadata", "script", "uppercase"],
			tempDir,
		);
		assert.deepEqual(resolved.map((skill) => skill.name), ["direct", "broad", "skill-directory"]);
		assert.deepEqual(missing, ["metadata", "script", "uppercase"]);
	});

	it("keeps root package-manifest Markdown discovery case-sensitive", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "root-markdown-case");
		const skillsRoot = path.join(packageRoot, "skills");
		writePackageManifest(packageRoot, ["./skills"]);
		fs.mkdirSync(skillsRoot, { recursive: true });
		fs.writeFileSync(path.join(skillsRoot, "lower.md"), "Pi-compatible lower-case Markdown.\n", "utf-8");
		fs.writeFileSync(path.join(skillsRoot, "UPPER.MD"), "Must not be exposed by a package manifest directory.\n", "utf-8");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/root-markdown-case"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["lower", "UPPER"], tempDir);
		assert.deepEqual(resolved.map((skill) => skill.name), ["lower"]);
		assert.deepEqual(missing, ["UPPER"]);
	});

	it("evaluates sibling symlink aliases independently within one manifest traversal", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "sibling-aliases");
		const sharedRoot = path.join(tempDir, ".pi", "shared-skills");
		writePackageManifest(packageRoot, ["./skills", "!skills/alias-a/foo", "!skills/alias-b/bar"], "sibling-aliases");
		makeManifestSkill(sharedRoot, ".", "foo", "Only alias B should expose foo.");
		makeManifestSkill(sharedRoot, ".", "bar", "Only alias A should expose bar.");
		const aliasesRoot = path.join(packageRoot, "skills");
		fs.mkdirSync(aliasesRoot, { recursive: true });
		fs.symlinkSync(sharedRoot, path.join(aliasesRoot, "alias-a"), process.platform === "win32" ? "junction" : "dir");
		fs.symlinkSync(sharedRoot, path.join(aliasesRoot, "alias-b"), process.platform === "win32" ? "junction" : "dir");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/sibling-aliases"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["foo", "bar"], tempDir);
		assert.deepEqual(missing, []);
		assert.deepEqual(resolved.map((skill) => skill.path), [
			path.join(aliasesRoot, "alias-b", "foo", "SKILL.md"),
			path.join(aliasesRoot, "alias-a", "bar", "SKILL.md"),
		]);
	});

	it("filters shared manifest roots independently before deduplicating enabled skill files", () => {
		const packagesRoot = path.join(tempDir, ".pi", "packages");
		const packageA = path.join(packagesRoot, "package-a");
		const packageB = path.join(packagesRoot, "package-b");
		const sharedRoot = path.join(packagesRoot, "shared-skills");
		writePackageManifest(packageA, ["../shared-skills", "!from-b"], "package-a");
		writePackageManifest(packageB, ["../shared-skills", "!from-a"], "package-b");
		makeManifestSkill(sharedRoot, ".", "from-a", "Enabled by package A.");
		makeManifestSkill(sharedRoot, ".", "from-b", "Enabled by package B.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/package-a", "./packages/package-b"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["from-a", "from-b"], tempDir);
		assert.deepEqual(missing, []);
		assert.deepEqual(resolved.map((skill) => skill.name), ["from-a", "from-b"]);
		assert.deepEqual(resolved.map((skill) => skill.source), ["project-package", "project-package"]);
	});

	it("traverses symlink aliases independently when package manifests have conflicting overrides", () => {
		const packagesRoot = path.join(tempDir, ".pi", "packages");
		const packageA = path.join(packagesRoot, "package-a");
		const packageB = path.join(packagesRoot, "package-b");
		const sharedRoot = path.join(packagesRoot, "shared-real");
		writePackageManifest(packageA, ["./alias-a", "!from-b"], "package-a");
		writePackageManifest(packageB, ["./alias-b", "!from-a"], "package-b");
		makeManifestSkill(sharedRoot, ".", "from-a", "Enabled through alias A.");
		makeManifestSkill(sharedRoot, ".", "from-b", "Enabled through alias B.");
		fs.symlinkSync(sharedRoot, path.join(packageA, "alias-a"), process.platform === "win32" ? "junction" : "dir");
		fs.symlinkSync(sharedRoot, path.join(packageB, "alias-b"), process.platform === "win32" ? "junction" : "dir");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/package-a", "./packages/package-b"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["from-a", "from-b"], tempDir);
		assert.deepEqual(missing, []);
		assert.deepEqual(resolved.map((skill) => skill.name), ["from-a", "from-b"]);
	});

	it("honors Pi ignore files for directory-valued package-manifest globs", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "ignored-glob");
		const bundleRoot = path.join(packageRoot, "skills", "bundle");
		writePackageManifest(packageRoot, ["skills/*"]);
		makeManifestSkill(packageRoot, "skills/bundle", "visible", "Visible skill.");
		makeManifestSkill(packageRoot, "skills/bundle", "git-ignored", "Ignored by .gitignore.");
		makeManifestSkill(packageRoot, "skills/bundle/ignored", "hidden", "Ignored before negation.");
		makeManifestSkill(packageRoot, "skills/bundle/ignored", "reincluded", "Restored by negation.");
		makeManifestSkill(packageRoot, "skills/bundle/nested", "ignored-by-ignore", "Ignored by nested .ignore.");
		makeManifestSkill(packageRoot, "skills/bundle/nested", "ignored-by-fdignore", "Ignored by nested .fdignore.");
		makeManifestSkill(packageRoot, "skills/bundle", ".hidden", "Hidden traversal entry.");
		makeManifestSkill(packageRoot, "skills/bundle/node_modules", "node-package", "node_modules traversal entry.");
		fs.writeFileSync(
			path.join(bundleRoot, ".gitignore"),
			"git-ignored/\nignored/*\n!ignored/reincluded/\n",
			"utf-8",
		);
		fs.mkdirSync(path.join(bundleRoot, "nested"), { recursive: true });
		fs.writeFileSync(path.join(bundleRoot, "nested", ".ignore"), "ignored-by-ignore/\n", "utf-8");
		fs.writeFileSync(path.join(bundleRoot, "nested", ".fdignore"), "ignored-by-fdignore/\n", "utf-8");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/ignored-glob"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(
			["visible", "git-ignored", "hidden", "reincluded", "ignored-by-ignore", "ignored-by-fdignore", ".hidden", "node-package"],
			tempDir,
		);
		assert.deepEqual(resolved.map((skill) => skill.name), ["visible", "reincluded"]);
		assert.deepEqual(missing, ["git-ignored", "hidden", "ignored-by-ignore", "ignored-by-fdignore", ".hidden", "node-package"]);
	});

	it("keeps project-local skills ahead of glob-backed package skills", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "glob-package");
		writePackageManifest(packageRoot, ["skills/*/SKILL.md"]);
		makeManifestSkill(packageRoot, "skills", "shared-skill", "Package version.");
		makeManifestSkill(packageRoot, "skills", "package-sentinel", "Package-only version.");
		makeProjectSkill(tempDir, "shared-skill", "Project version.");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/glob-package"] }, null, 2),
			"utf-8",
		);

		const { resolved, missing } = resolveSkills(["shared-skill", "package-sentinel"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved[0]?.source, "project");
		assert.match(resolved[0]?.content ?? "", /Project version\./);
		assert.equal(resolved[1]?.source, "project-package");
		assert.match(resolved[1]?.content ?? "", /Package-only version\./);
	});

	it("discovers skills from the current cwd package", () => {
		makePackageSkill(tempDir, "cwd-package-skill", "Cwd package skill.");

		const { resolved, missing } = resolveSkills(["cwd-package-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("skips optional global npm discovery in offline mode", () => {
		const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
		const binDir = path.join(tempDir, "bin");
		const fakeHome = path.join(tempDir, "home");
		const marker = path.join(tempDir, "npm-calls.txt");
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(fakeHome, { recursive: true });
		fs.writeFileSync(
			path.join(binDir, "npm"),
			"#!/bin/sh\nprintf 'npm-root-called\\n' >> \"$PI_DISCOVERY_MARKER\"\nexit 1\n",
			{ encoding: "utf-8", mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(binDir, "npm.cmd"),
			"@echo off\r\n>>\"%PI_DISCOVERY_MARKER%\" echo npm-root-called\r\nexit /b 1\r\n",
			"utf-8",
		);

		const script = `
			import fs from "node:fs";
			const [{ clearSkillCache, discoverAvailableSkills }, { discoverAgents }] = await Promise.all([
				import("./src/agents/skills.ts"),
				import("./src/agents/agents.ts"),
			]);
			discoverAvailableSkills(process.cwd());
			discoverAgents(process.cwd(), "both");
			if (fs.existsSync(process.env.PI_DISCOVERY_MARKER)) {
				throw new Error("npm was invoked while PI_OFFLINE was enabled");
			}
			delete process.env.PI_OFFLINE;
			clearSkillCache();
			discoverAvailableSkills(process.cwd());
			discoverAgents(process.cwd(), "both");
		`;
		execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{
				cwd: projectRoot,
				env: {
					...process.env,
					HOME: fakeHome,
					USERPROFILE: fakeHome,
					PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
					PI_DISCOVERY_MARKER: marker,
					PI_OFFLINE: "1",
				},
				stdio: "pipe",
			},
		);
		assert.deepEqual(fs.readFileSync(marker, "utf-8").trim().split(/\r?\n/), ["npm-root-called", "npm-root-called"]);
	});

	it("falls back to the runtime cwd when the execution cwd lacks the skill", () => {
		const nestedDir = path.join(tempDir, "nested");
		fs.mkdirSync(nestedDir, { recursive: true });
		makePackageSkill(tempDir, "runtime-fallback-skill", "Runtime fallback skill.");

		const { resolved, missing } = resolveSkillsWithFallback(["runtime-fallback-skill"], nestedDir, tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("discovers skills from user settings packages", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const userPackageRoot = path.join(userAgentDir, "user-pkg");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(userPackageRoot, "user-settings-package-skill", "User settings package skill.");
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: [{ source: "./user-pkg" }] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("discovers skills from user settings git package sources", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const packageRoot = path.join(userAgentDir, "git", "github.com", "user", "repo");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(packageRoot, "user-settings-git-package-skill", "User settings git package skill.");
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: ["git:github.com/user/repo.git@main"] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-git-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("discovers skills from user settings scoped npm package sources", async () => {
		const fakeHome = path.join(tempDir, "fake-home");
		const userAgentDir = path.join(fakeHome, ".pi", "agent");
		const packageRoot = path.join(userAgentDir, "npm", "node_modules", "@scope", "skill-package");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			makePackageSkill(
				packageRoot,
				"user-settings-scoped-npm-package-skill",
				"User settings scoped npm package skill.",
				"@scope/skill-package",
			);
			fs.mkdirSync(userAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(userAgentDir, "settings.json"),
				JSON.stringify({ packages: [{ source: "npm:@scope/skill-package@latest" }] }, null, 2),
				"utf-8",
			);

			const fresh = await importSkillsFresh();
			fresh.clearSkillCache();
			const discovered = fresh.discoverAvailableSkills(tempDir);
			const skill = discovered.find((entry) => entry.name === "user-settings-scoped-npm-package-skill");
			assert.ok(skill);
			assert.equal(skill?.source, "user-package");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("resolves agent-local files and directories before global skills without publishing them", () => {
		makeProjectSkill(tempDir, "shared", "global body");
		const agentDir = path.join(tempDir, "agents", "nested");
		writeSkillFile(path.join(agentDir, "skills", "shared"), "local shared body");
		writeSkillFile(path.join(agentDir, "direct"), "local direct body");

		const local = resolveSkills(["shared", "direct", "missing"], tempDir, ["./skills", "./direct/SKILL.md"], agentDir);
		assert.deepEqual(local.resolved.map((skill) => [skill.name, skill.content]), [
			["shared", "local shared body"],
			["direct", "local direct body"],
		]);
		assert.deepEqual(local.missing, ["missing"]);
		assert.equal(resolveSkills(["shared"], tempDir).resolved[0]?.content, "global body");
		assert.equal(discoverAvailableSkills(tempDir).some((skill) => skill.name === "direct"), false);
	});

	it("does not read malformed global settings when every selected local skill resolves", () => {
		const agentDir = path.join(tempDir, "agents", "nested");
		writeSkillFile(path.join(agentDir, "skills", "local"), "local body");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

		const result = resolveSkills(["local"], tempDir, ["./skills"], agentDir);
		assert.deepEqual(result.missing, []);
		assert.equal(result.resolved[0]?.content, "local body");
	});

	it("falls back globally when an agent-local skill candidate cannot be read", () => {
		makeProjectSkill(tempDir, "shared", "global body");
		const agentDir = path.join(tempDir, "agents", "nested");
		const invalidLocalFile = path.join(agentDir, "skills", "shared", "SKILL.md");
		fs.mkdirSync(invalidLocalFile, { recursive: true });

		const result = resolveSkills(["shared"], tempDir, ["./skills"], agentDir);
		assert.deepEqual(result.missing, []);
		assert.equal(result.resolved[0]?.content, "global body");
	});

	it("keeps same-named agent-local skills isolated between invocations", () => {
		makeProjectSkill(tempDir, "global-only", "global fallback");
		const one = path.join(tempDir, "one");
		const two = path.join(tempDir, "two");
		writeSkillFile(path.join(one, "skills", "private"), "one private");
		writeSkillFile(path.join(two, "skills", "private"), "two private");

		assert.equal(resolveSkills(["private", "global-only"], tempDir, ["./skills"], one).resolved[0]?.content, "one private");
		assert.equal(resolveSkills(["private", "global-only"], tempDir, ["./skills"], two).resolved[0]?.content, "two private");
		assert.equal(resolveSkills(["global-only"], tempDir, ["./skills"], one).resolved[0]?.content, "global fallback");
	});

	it("surfaces malformed project settings files instead of silently ignoring them", () => {
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{bad-json", "utf-8");

		assert.throws(
			() => resolveSkills(["missing-skill"], tempDir),
			/Failed to read skills settings file .+\.pi[\\/]settings\.json/,
		);
	});

	it("ignores malformed installed-package siblings during best-effort package scans", () => {
		const packagesRoot = path.join(tempDir, ".pi", "npm", "node_modules");
		const brokenRoot = path.join(packagesRoot, "broken-package");
		fs.mkdirSync(brokenRoot, { recursive: true });
		fs.writeFileSync(path.join(brokenRoot, "package.json"), "{bad-json", "utf-8");
		makePackageSkill(path.join(packagesRoot, "valid-package"), "installed-sibling-skill", "Installed sibling skill.");

		const { resolved, missing } = resolveSkills(["installed-sibling-skill"], tempDir);
		assert.deepEqual(missing, []);
		assert.equal(resolved[0]?.source, "project-package");
	});

	it("surfaces malformed explicit settings package manifests instead of silently ignoring them", () => {
		const packageRoot = path.join(tempDir, ".pi", "packages", "broken-package");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), "{bad-json", "utf-8");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["./packages/broken-package"] }, null, 2),
			"utf-8",
		);

		assert.throws(
			() => discoverAvailableSkills(tempDir),
			/Failed to read package manifest .+broken-package[\\/]package\.json/,
		);
	});
});
