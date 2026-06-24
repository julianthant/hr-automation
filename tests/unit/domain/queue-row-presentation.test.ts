/**
 * Unit tests for src/domain/queue-row-presentation.ts
 *
 * Covers:
 *   - resolveQueueRowPresentation: title+subtitle per kind (person/file/catalog)
 *   - pending vs resolved phase (name presence)
 *   - "EID if present else trace id" subtitle rule for person rows
 *   - preferTraceIdSubtitle flag for batch/preview anchors
 *   - returns undefined for unmigrated rows (no queueRowKind stamped)
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveQueueRowPresentation } from "../../../src/domain/queue-row-presentation.js";

describe("resolveQueueRowPresentation — returns undefined for unmigrated rows", () => {
  it("returns undefined when queueRowKind is absent from data", () => {
    const result = resolveQueueRowPresentation({ id: "item-1", data: {} });
    assert.equal(result, undefined);
  });

  it("returns undefined when data is null", () => {
    const result = resolveQueueRowPresentation({ id: "item-1", data: null });
    assert.equal(result, undefined);
  });

  it("returns undefined when data is not provided", () => {
    const result = resolveQueueRowPresentation({ id: "item-1" });
    assert.equal(result, undefined);
  });
});

describe("resolveQueueRowPresentation — person kind, resolved name", () => {
  it("uses data.name as title when present", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: { queueRowKind: "person", name: "Jane Doe", emplId: "11111", __traceId: "ws-120000-ab12" },
    });
    assert.ok(result);
    assert.equal(result.title, "Jane Doe");
  });

  it("uses data.employeeName as title fallback when name is absent", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: { queueRowKind: "person", employeeName: "John Smith", emplId: "22222" },
    });
    assert.ok(result);
    assert.equal(result.title, "John Smith");
  });

  it("uses data.searchName as title fallback when name and employeeName are absent", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: { queueRowKind: "person", searchName: "Alice", emplId: "33333" },
    });
    assert.ok(result);
    assert.equal(result.title, "Alice");
  });
});

describe("resolveQueueRowPresentation — person kind, subtitle rule (EID else trace id)", () => {
  it("uses emplId as subtitle when EID is present (flat single row)", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Jane Doe",
        emplId: "12345",
        __traceId: "ws-120000-ab12",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "12345");
  });

  it("falls back to trace id when emplId is absent but trace id is present", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Jane Doe",
        __traceId: "ws-130000-cd34",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "ws-130000-cd34");
  });

  it("uses data.ucpathId as the EID subtitle for onbase members (ISS-003) — not the trace id", () => {
    // OnBase stamps the EID only as `ucpathId` (its schema/getId/deriveItemId
    // never use emplId); without ucpathId in resolveEid the subtitle fell
    // through to the trace id for every onbase operation-member row.
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Coleman, Renee",
        ucpathId: "10706431",
        __traceId: "ob-004859-61b0",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "10706431");
  });

  it("accepts data.eid as the EID field", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Bob Jones",
        eid: "99999",
        __traceId: "ws-140000-ef56",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "99999");
  });

  it("accepts data.employeeId as the EID field", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Carol White",
        employeeId: "88888",
        __traceId: "ws-150000-gh78",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "88888");
  });

  it("ignores a prose 'Not found' sentinel in emplId, falling through to trace id", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Jane Doe",
        emplId: "Not found",
        __traceId: "pl-160000-ab12",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "pl-160000-ab12");
  });

  it("ignores a prose 'Error' sentinel in emplId, falling through to trace id", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Jane Doe",
        emplId: "Error",
        __traceId: "pl-170000-cd34",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "pl-170000-cd34");
  });

  it("ignores a non-numeric eid value (defense in depth)", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        name: "Jane Doe",
        eid: "pending",
        __traceId: "pl-180000-ef56",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "pl-180000-ef56");
  });
});

describe("resolveQueueRowPresentation — person kind, preferTraceIdSubtitle flag", () => {
  it("returns trace id as subtitle when preferTraceIdSubtitle is true and trace id is present", () => {
    const result = resolveQueueRowPresentation(
      {
        id: "item-1",
        data: {
          queueRowKind: "person",
          name: "Diana Prince",
          emplId: "77777",
          __traceId: "ws-160000-ij90",
        },
      },
      { preferTraceIdSubtitle: true },
    );
    assert.ok(result);
    // With preferTraceIdSubtitle, trace id takes precedence over EID
    assert.equal(result.subtitle, "ws-160000-ij90");
  });

  it("falls back to EID when preferTraceIdSubtitle is true but trace id is absent", () => {
    const result = resolveQueueRowPresentation(
      {
        id: "item-1",
        data: {
          queueRowKind: "person",
          name: "Diana Prince",
          emplId: "77777",
        },
      },
      { preferTraceIdSubtitle: true },
    );
    assert.ok(result);
    assert.equal(result.subtitle, "77777");
  });
});

describe("resolveQueueRowPresentation — person kind, pending phase (no resolved name)", () => {
  it("falls back to __subject when no direct name fields are present", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        __subject: "Bruce Wayne",
        __subjectKind: "person",
        __traceId: "ws-170000-kl01",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "Bruce Wayne");
  });

  it("falls back to __name when __subject is absent and subjectKind is eid", () => {
    const result = resolveQueueRowPresentation({
      id: "item-1",
      data: {
        queueRowKind: "person",
        __name: "Clark Kent",
        __subjectKind: "eid",
        __traceId: "ws-180000-mn23",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "Clark Kent");
  });

  it("uses entry.id as last-resort title fallback when no name fields present", () => {
    const result = resolveQueueRowPresentation({
      id: "item-fallback",
      data: {
        queueRowKind: "person",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "item-fallback");
  });
});

describe("resolveQueueRowPresentation — file kind", () => {
  it("uses pdfOriginalName as title", () => {
    const result = resolveQueueRowPresentation({
      id: "session-1",
      data: {
        queueRowKind: "file",
        pdfOriginalName: "oath-form.pdf",
        __traceId: "oc-190000-op45",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "oath-form.pdf");
    assert.equal(result.subtitle, "oc-190000-op45");
  });

  it("falls back to __name when pdfOriginalName is absent", () => {
    const result = resolveQueueRowPresentation({
      id: "session-1",
      data: {
        queueRowKind: "file",
        __name: "document.pdf",
        __traceId: "oc-200000-qr67",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "document.pdf");
  });

  it("uses entry.id as last-resort title when no name fields present", () => {
    const result = resolveQueueRowPresentation({
      id: "session-fallback",
      data: { queueRowKind: "file" },
    });
    assert.ok(result);
    assert.equal(result.title, "session-fallback");
  });

  it("sets subtitle to trace id (not EID) for file rows", () => {
    const result = resolveQueueRowPresentation({
      id: "session-1",
      data: {
        queueRowKind: "file",
        pdfOriginalName: "doc.pdf",
        emplId: "99999",
        __traceId: "oc-210000-st89",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "oc-210000-st89");
  });

  it("sets subtitle to undefined when trace id is absent", () => {
    const result = resolveQueueRowPresentation({
      id: "session-1",
      data: { queueRowKind: "file", pdfOriginalName: "doc.pdf" },
    });
    assert.ok(result);
    assert.equal(result.subtitle, undefined);
  });
});

describe("resolveQueueRowPresentation — catalog kind", () => {
  it("uses __queueTitle as title for catalog rows", () => {
    const result = resolveQueueRowPresentation({
      id: "catalog-1",
      data: {
        queueRowKind: "catalog",
        __queueTitle: "Sharepoint Report",
        __traceId: "sp-220000-uv90",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "Sharepoint Report");
    assert.equal(result.subtitle, "sp-220000-uv90");
  });

  it("falls back to __name when __queueTitle is absent", () => {
    const result = resolveQueueRowPresentation({
      id: "catalog-1",
      data: {
        queueRowKind: "catalog",
        __name: "Some Catalog",
        __traceId: "sp-230000-wx12",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "Some Catalog");
  });

  it("falls back to data.label when other fields are absent", () => {
    const result = resolveQueueRowPresentation({
      id: "catalog-1",
      data: {
        queueRowKind: "catalog",
        label: "My Report",
        __traceId: "sp-240000-yz34",
      },
    });
    assert.ok(result);
    assert.equal(result.title, "My Report");
  });

  it("uses entry.id as last-resort title for catalog rows", () => {
    const result = resolveQueueRowPresentation({
      id: "catalog-fallback",
      data: { queueRowKind: "catalog" },
    });
    assert.ok(result);
    assert.equal(result.title, "catalog-fallback");
  });

  it("sets subtitle to trace id (not EID) for catalog rows", () => {
    const result = resolveQueueRowPresentation({
      id: "catalog-1",
      data: {
        queueRowKind: "catalog",
        __queueTitle: "Report",
        emplId: "55555",
        __traceId: "sp-250000-ab56",
      },
    });
    assert.ok(result);
    assert.equal(result.subtitle, "sp-250000-ab56");
  });
});
