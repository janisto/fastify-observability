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
});
