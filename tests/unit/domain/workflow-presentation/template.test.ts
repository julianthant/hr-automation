import { describe, it, expect } from "vitest";
import { renderTemplate, extractTokens, KNOWN_TOKENS } from "../../../../src/domain/workflow-presentation/template.js";

describe("renderTemplate", () => {
  it("interpolates known tokens", () => {
    expect(renderTemplate("{name} ({emplId})", { name: "Person 905", emplId: "10090001" })).toBe("Person 905 (10090001)");
  });
  it("drops a token whose value is empty/missing, trimming dangling separators", () => {
    expect(renderTemplate("{name} ({emplId})", { name: "Person 905", emplId: "" })).toBe("Person 905");
  });
  it("renders trace-style template", () => {
    expect(renderTemplate("{code}-{HHMMSS}-{runId4}", { code: "ou", HHMMSS: "143012", runId4: "a3f1" })).toBe("ou-143012-a3f1");
  });
  it("leaves unknown braces literal-safe (no throw, renders empty)", () => {
    expect(renderTemplate("x {nope} y", {})).toBe("x y");
  });
});

describe("extractTokens", () => {
  it("returns the token names used", () => {
    expect(extractTokens("{name} ({emplId})")).toEqual(["name", "emplId"]);
  });
});

describe("KNOWN_TOKENS", () => {
  it("includes the core vocabulary", () => {
    for (const t of ["name", "emplId", "email", "pdfOriginalName", "code", "HHMMSS", "runId4", "traceId"]) {
      expect(KNOWN_TOKENS).toContain(t);
    }
  });
});
