/**
 * Unit tests for src/domain/queue-row-kind.ts
 *
 * Covers:
 *   - subjectToQueueRowKind: all InputSubject values mapping to QueueRowKind
 *   - resolveQueueRowKind: stamped kind on entry data
 *   - resolveQueueRowKindFromValue: literal and resolver forms
 *   - queueRowKindFromInputSubject: converts subject or resolver to kind or kind-resolver
 *   - isQueueRowKind / isInputSubject
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  subjectToQueueRowKind,
  resolveQueueRowKind,
  resolveQueueRowKindFromValue,
  queueRowKindFromInputSubject,
  isQueueRowKind,
  isInputSubject,
} from "../../../src/domain/queue-row-kind.js";

describe("isQueueRowKind", () => {
  it("returns true for 'person'", () => {
    assert.equal(isQueueRowKind("person"), true);
  });

  it("returns true for 'file'", () => {
    assert.equal(isQueueRowKind("file"), true);
  });

  it("returns true for 'catalog'", () => {
    assert.equal(isQueueRowKind("catalog"), true);
  });

  it("returns false for an unknown string", () => {
    assert.equal(isQueueRowKind("unknown"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isQueueRowKind(""), false);
  });

  it("returns false for non-string values", () => {
    assert.equal(isQueueRowKind(null), false);
    assert.equal(isQueueRowKind(undefined), false);
    assert.equal(isQueueRowKind(42), false);
  });
});

describe("isInputSubject", () => {
  it("returns true for all valid subjects", () => {
    for (const s of ["name", "eid", "email", "kualiId", "pdf", "selector"] as const) {
      assert.equal(isInputSubject(s), true, `expected ${s} to be a valid InputSubject`);
    }
  });

  it("returns false for an unknown string", () => {
    assert.equal(isInputSubject("unknown"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isInputSubject(""), false);
  });
});

describe("subjectToQueueRowKind — person subjects", () => {
  it("maps 'name' to 'person'", () => {
    assert.equal(subjectToQueueRowKind("name"), "person");
  });

  it("maps 'eid' to 'person'", () => {
    assert.equal(subjectToQueueRowKind("eid"), "person");
  });

  it("maps 'email' to 'person'", () => {
    assert.equal(subjectToQueueRowKind("email"), "person");
  });

  it("maps 'kualiId' to 'person'", () => {
    assert.equal(subjectToQueueRowKind("kualiId"), "person");
  });
});

describe("subjectToQueueRowKind — file and catalog subjects", () => {
  it("maps 'pdf' to 'file'", () => {
    assert.equal(subjectToQueueRowKind("pdf"), "file");
  });

  it("maps 'selector' to 'catalog'", () => {
    assert.equal(subjectToQueueRowKind("selector"), "catalog");
  });
});

describe("subjectToQueueRowKind — invalid input throws", () => {
  it("throws for an unknown subject value", () => {
    assert.throws(
      () => subjectToQueueRowKind("bogus" as never),
      /is not a valid InputSubject/,
    );
  });
});

describe("resolveQueueRowKind — reading stamped data", () => {
  it("returns undefined when queueRowKind is absent", () => {
    assert.equal(resolveQueueRowKind({ data: {} }), undefined);
  });

  it("returns undefined when data is null", () => {
    assert.equal(resolveQueueRowKind({ data: null }), undefined);
  });

  it("returns undefined when queueRowKind is empty string", () => {
    assert.equal(resolveQueueRowKind({ data: { queueRowKind: "" } }), undefined);
  });

  it("returns undefined when queueRowKind is null (unmigrated row)", () => {
    assert.equal(resolveQueueRowKind({ data: { queueRowKind: null as unknown as string } }), undefined);
  });

  it("returns 'person' when stamped with 'person'", () => {
    assert.equal(resolveQueueRowKind({ data: { queueRowKind: "person" } }), "person");
  });

  it("returns 'file' when stamped with 'file'", () => {
    assert.equal(resolveQueueRowKind({ data: { queueRowKind: "file" } }), "file");
  });

  it("returns 'catalog' when stamped with 'catalog'", () => {
    assert.equal(resolveQueueRowKind({ data: { queueRowKind: "catalog" } }), "catalog");
  });

  it("throws for a present but invalid kind value", () => {
    assert.throws(
      () => resolveQueueRowKind({ data: { queueRowKind: "alien" } }),
      /data\.queueRowKind is set but not a valid QueueRowKind/,
    );
  });
});

describe("resolveQueueRowKindFromValue — literal form", () => {
  it("returns the kind directly when passed a literal string", () => {
    assert.equal(resolveQueueRowKindFromValue("person", {}, "wf"), "person");
    assert.equal(resolveQueueRowKindFromValue("file", {}, "wf"), "file");
    assert.equal(resolveQueueRowKindFromValue("catalog", {}, "wf"), "catalog");
  });

  it("throws when the resolver function returns an invalid kind", () => {
    const badResolver = () => "bad" as never;
    assert.throws(
      () => resolveQueueRowKindFromValue(badResolver, {}, "my-workflow"),
      /my-workflow/,
    );
  });
});

describe("resolveQueueRowKindFromValue — resolver form", () => {
  it("calls the resolver with the input and returns the kind", () => {
    const resolver = (input: { type: string }) =>
      input.type === "pdf" ? "file" as const : "person" as const;
    assert.equal(resolveQueueRowKindFromValue(resolver, { type: "pdf" }, "wf"), "file");
    assert.equal(resolveQueueRowKindFromValue(resolver, { type: "name" }, "wf"), "person");
  });
});

describe("queueRowKindFromInputSubject — literal subject", () => {
  it("returns a literal kind for a literal subject", () => {
    assert.equal(queueRowKindFromInputSubject("eid"), "person");
    assert.equal(queueRowKindFromInputSubject("pdf"), "file");
    assert.equal(queueRowKindFromInputSubject("selector"), "catalog");
  });
});

describe("queueRowKindFromInputSubject — resolver subject", () => {
  it("wraps a subject resolver into a kind resolver", () => {
    const subjectResolver = (input: { method: string }) =>
      input.method === "upload" ? "pdf" as const : "name" as const;
    const kindResolver = queueRowKindFromInputSubject(subjectResolver);
    assert.equal(typeof kindResolver, "function");
    assert.equal((kindResolver as (i: { method: string }) => string)({ method: "upload" }), "file");
    assert.equal((kindResolver as (i: { method: string }) => string)({ method: "search" }), "person");
  });
});
