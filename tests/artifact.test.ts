import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("package contract", () => {
  it("locks identity, compatibility, exports, and dependency boundaries", () => {
    expect(packageJson).toMatchObject({
      name: "fastify-observability",
      type: "module",
      sideEffects: false,
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      engines: { node: ">=24" },
      packageManager: "pnpm@11.13.0",
    });
    expect(packageJson.files).toEqual(["dist", "CHANGELOG.md"]);
    expect(packageJson.dependencies).toEqual({ "fastify-plugin": "^6.0.0", pino: "^10.3.1" });
    expect(packageJson.peerDependencies).toEqual({ fastify: "^5.10.0" });
    expect(packageJson.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
    });
  });

  it("has no forbidden observability dependency in any manifest section", () => {
    const dependencySections = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      Reflect.get(packageJson, "optionalDependencies"),
    ];
    const dependencyNames = dependencySections
      .filter((section): section is Record<string, unknown> => section !== null && typeof section === "object")
      .flatMap((section) => Object.keys(section))
      .map((name) => name.toLowerCase());
    expect(dependencyNames.some((name) => name.includes("opentelemetry"))).toBe(false);
    expect(dependencyNames.some((name) => name.includes("request-context"))).toBe(false);
  });
});
