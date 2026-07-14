import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("package contract", () => {
  it("locks identity, compatibility, exports, and dependency boundaries", () => {
    expect(packageJson).toMatchObject({
      name: "fastify-observability",
      version: "0.1.0",
      type: "module",
      sideEffects: false,
      engines: { node: ">=24" },
      packageManager: "pnpm@11.13.0",
      dependencies: { "fastify-plugin": "^6.0.0" },
      peerDependencies: { fastify: "^5.10.0" },
    });
    expect(packageJson.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
    });
  });

  it("keeps the canonical README setup complete", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const required of [
      "requestIdHeader: false",
      "genReqId: createRequestIdGenerator()",
      "disableRequestLogging: true",
      'requestIdLogLabel: "request_id"',
      "AccessLogLevel",
      "debug",
    ]) {
      expect(readme).toContain(required);
    }
  });

  it("has no forbidden observability dependencies", () => {
    const names = JSON.stringify({
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
    });
    expect(names).not.toContain("opentelemetry");
    expect(names).not.toContain("request-context");
    expect(names).not.toContain('"pino"');
  });
});
