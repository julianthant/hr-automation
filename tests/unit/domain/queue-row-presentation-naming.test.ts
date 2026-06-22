import { describe, it, expect } from "vitest";
import { resolveQueueRowPresentation } from "../../../src/domain/queue-row-presentation.js";

const personEntry = {
  id: "run-1",
  data: { queueRowKind: "person", name: "Jane Doe", emplId: "10012345", __traceId: "ws-143012-a3f1" },
};

describe("resolveQueueRowPresentation with naming", () => {
  it("custom title template overrides the person-name default", () => {
    const r = resolveQueueRowPresentation(personEntry, {
      naming: { title: { scheme: "custom-template", template: "{name} [{emplId}]" }, subtitle: { scheme: "trace-only" } },
    });
    expect(r?.title).toBe("Jane Doe [10012345]");
    expect(r?.subtitle).toBe("ws-143012-a3f1");
  });

  it("without naming, legacy person behavior is unchanged (EID subtitle)", () => {
    const r = resolveQueueRowPresentation(personEntry, {});
    expect(r?.title).toBe("Jane Doe");
    expect(r?.subtitle).toBe("10012345");
  });
});

describe("resolveQueueRowPresentation — parity: routed path equals legacy path", () => {
  it("catalog: readQueueTitle wins over label when __queueTitle is set", () => {
    const entry = {
      id: "r1",
      data: { queueRowKind: "catalog", __queueTitle: "My Roster", label: "Generic", __traceId: "sd-1-aa11" },
    };
    const legacy = resolveQueueRowPresentation(entry, {});
    const routed = resolveQueueRowPresentation(entry, {
      naming: { title: { scheme: "catalog-label" }, subtitle: { scheme: "trace-only" } },
    });
    expect(routed?.title).toBe(legacy?.title);
    expect(routed?.title).toBe("My Roster");
  });

  it("file: readQueueTitle used when no pdfOriginalName is set", () => {
    const entry = {
      id: "r2",
      data: { queueRowKind: "file", __queueTitle: "Doc Title", __traceId: "ou-1-bb22" },
    };
    const legacy = resolveQueueRowPresentation(entry, {});
    const routed = resolveQueueRowPresentation(entry, {
      naming: { title: { scheme: "pdf-filename" }, subtitle: { scheme: "trace-only" } },
    });
    expect(routed?.title).toBe(legacy?.title);
    expect(routed?.title).toBe("Doc Title");
  });
});
