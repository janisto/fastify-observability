import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const caller = /\bgh\s+api\b|\b(?:github|octokit)\.(?:rest\b|request\s*\(|paginate\s*\()|https?:\/\/api\.github\.com\b/;
const lockedHeader = /X-GitHub-Api-Version["']?\s*(?::|=|\s)\s*["']?2026-03-10\b/;
const headerName = /X-GitHub-Api-Version/gi;
const clientAlias =
  /\b(?:const\s+|let\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:new\s+)?[^\n]*(?:Octokit|GitHub|Github|octokit|github)\b/g;
const automatedExtensions = new Set([
  ".bash",
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
  ".zsh",
]);
const skippedDirectories = new Set([
  ".git",
  ".venv",
  "artifacts",
  "coverage",
  "dist",
  "mutants",
  "node_modules",
  "target",
]);

function isAutomatedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized !== "tests/github-api-policy.test.ts" &&
    !normalized.endsWith(".md") &&
    (automatedExtensions.has(extname(normalized)) || normalized.endsWith("/Justfile") || normalized === "Justfile")
  );
}

function policyViolations(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, content] of files) {
    if (!isAutomatedPath(path)) {
      continue;
    }
    const lines = content.split("\n");
    const aliases = new Set(
      [...content.matchAll(clientAlias)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
    );
    const isCaller = (line: string) =>
      caller.test(line) ||
      [...aliases].some((alias) => new RegExp(`\\b${alias}\\.(?:rest\\b|request\\s*\\(|paginate\\s*\\()`).test(line));
    for (const [index, line] of lines.entries()) {
      if (!isCaller(line)) {
        continue;
      }
      const limit = Math.min(lines.length, index + 12);
      let end = index + 1;
      while (end < limit && !isCaller(lines[end] ?? "")) {
        end += 1;
      }
      const block = lines.slice(index, end).join("\n");
      if ((block.match(headerName) ?? []).length !== 1 || !lockedHeader.test(block)) {
        violations.push(`${path}:${index + 1}`);
      }
    }
  }
  return violations;
}

function repositoryPolicyFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          visit(join(current, entry.name));
        }
        continue;
      }
      const path = relative(directory, join(current, entry.name));
      if (entry.isFile() && isAutomatedPath(path)) {
        files.set(path, readFileSync(join(current, entry.name), "utf8"));
      }
    }
  };
  visit(directory);
  return files;
}

describe("GitHub REST API version policy", () => {
  it("passes with zero automated callers and ignores human documentation", () => {
    expect(policyViolations(new Map([["README.md", "Use `gh api` with the locally installed CLI."]]))).toEqual([]);
  });

  it("accepts the exact locked header on an automated caller", () => {
    const files = new Map([
      [
        ".github/workflows/example.yml",
        'github.request("GET /repos/{owner}/{repo}", {\n  headers: {"X-GitHub-Api-Version": "2026-03-10"},\n});',
      ],
    ]);
    expect(policyViolations(files)).toEqual([]);
  });

  it.each([
    ["missing", 'github.request("GET /repos/{owner}/{repo}");'],
    [
      "dynamic",
      'github.request("GET /repos/{owner}/{repo}", {headers: {"X-GitHub-Api-Version": process.env.VERSION}});',
    ],
    ["different", 'github.request("GET /repos/{owner}/{repo}", {headers: {"X-GitHub-Api-Version": "2022-11-28"}});'],
  ])("rejects an automated caller with a %s version", (_name, content) => {
    expect(policyViolations(new Map([["client.ts", content]]))).toEqual(["client.ts:1"]);
  });

  it("does not let one pinned caller mask a later unpinned caller", () => {
    const content = [
      'github.request("GET /one", {headers: {"X-GitHub-Api-Version": "2026-03-10"}});',
      'github.request("GET /two");',
    ].join("\n");
    expect(policyViolations(new Map([["client.ts", content]]))).toEqual(["client.ts:2"]);
  });

  it("rejects conflicting versions in one caller block", () => {
    const content = [
      'github.request("GET /one", {headers: {"X-GitHub-Api-Version": "2026-03-10"}});',
      'headers["X-GitHub-Api-Version"] = "2022-11-28";',
    ].join("\n");
    expect(policyViolations(new Map([["client.ts", content]]))).toEqual(["client.ts:1"]);
  });

  it("detects an aliased Octokit caller", () => {
    const content = 'const client = new Octokit();\nclient.request("GET /repos/{owner}/{repo}");';
    expect(policyViolations(new Map([["client.ts", content]]))).toEqual(["client.ts:2"]);
  });

  it("finds no unpinned automated caller in the repository", () => {
    expect(policyViolations(repositoryPolicyFiles(root))).toEqual([]);
  });
});
