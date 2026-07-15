import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = new URL("../.github/workflows/", import.meta.url);
const usesClause = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/;
const fullActionVersion = /^[^@\s]+@v\d+\.\d+\.\d+$/;

describe("workflow policy", () => {
  it("pins every external action to a full release version", () => {
    let externalActions = 0;
    const names = readdirSync(workflows)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();

    for (const name of names) {
      const lines = readFileSync(new URL(name, workflows), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const match = usesClause.exec(line);
        if (match === null) {
          continue;
        }
        const action = match?.[1];
        if (action === undefined || action.startsWith("./")) {
          continue;
        }
        externalActions += 1;
        expect(action, `${name}:${index + 1}: use @vMAJOR.MINOR.PATCH`).toMatch(fullActionVersion);
      }
    }

    expect(externalActions).toBeGreaterThan(0);
  });

  it("uses the pinned pnpm CLI for staged publishing", () => {
    const release = readFileSync(new URL("release.yml", workflows), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", workflows), "utf8")) as {
      packageManager?: string;
    };
    const pinned = /^pnpm@(\d+)\.(\d+)\.(\d+)$/.exec(manifest.packageManager ?? "");

    expect(pinned, "packageManager must pin an exact pnpm version").not.toBeNull();
    const major = Number(pinned?.[1]);
    const minor = Number(pinned?.[2]);
    expect(major > 11 || (major === 11 && minor >= 3), "pnpm stage requires pnpm >=11.3.0").toBe(true);

    const setupIndex = release.indexOf("uses: pnpm/action-setup@");
    const stageIndex = release.indexOf("pnpm stage publish");
    expect(setupIndex, "release.yml must install the packageManager pnpm version").toBeGreaterThan(-1);
    expect(stageIndex, "release.yml must stage the package").toBeGreaterThan(-1);
    expect(setupIndex, "pnpm must be installed before staging").toBeLessThan(stageIndex);
    expect(release).toContain("pnpm stage publish artifacts/*.tgz --ignore-scripts --no-git-checks");
    expect(release).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(release).not.toContain("npm install --global");
    expect(release.split("\n").some((line) => line.trimStart().startsWith("npm stage publish"))).toBe(false);
  });

  it("stages through OIDC without generating npm token placeholders", () => {
    const release = readFileSync(new URL("release.yml", workflows), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", workflows), "utf8")) as {
      publishConfig?: { access?: string; registry?: string };
    };

    expect(release).toContain("id-token: write");
    expect(release).toContain("pnpm stage publish artifacts/*.tgz --ignore-scripts --no-git-checks");
    expect(release).not.toMatch(/^\s*registry-url:/m);
    expect(release).not.toMatch(/\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/);
    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });
});
