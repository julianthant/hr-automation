import { beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

import { lookupPersonInUcpath } from "../../../../src/workflows/person-lookup/lookup.js";

const page = {} as never;
const result = {
  emplId: "10090071",
  name: "Moz V Towa",
  lastName: "Towa",
  department: "HOUSING/DINING/HOSPITALITY",
  hrStatus: "Active",
};

describe("lookupPersonInUcpath name candidate handling", () => {
  const searchByName = vi.fn();

  beforeEach(() => {
    searchByName.mockReset();
  });

  it("normalizes First Last names before searching UCPath", async () => {
    searchByName.mockResolvedValue({
      sdcmpResults: [result],
      allAttempts: [{ query: { lastName: "Towa", name: "Moz" }, results: [result], sdcmpResults: [result] }],
    });

    const lookup = await lookupPersonInUcpath(page, { kind: "by-name", name: "Moz Towa" }, {
      searchByNameImpl: searchByName,
    });

    assert.equal(searchByName.mock.calls[0]?.[1], "Towa, Moz");
    assert.equal(lookup.input.kind, "by-name");
    assert.equal(lookup.input.name, "Towa, Moz");
    assert.equal(lookup.selection.searchName, "Towa, Moz");
  });

  it("tries no-comma Last First order when natural First Last order returns no candidates", async () => {
    searchByName.mockImplementation(async (_page, name: string) => ({
      sdcmpResults: name === "Towa, Moz" ? [result] : [],
      allAttempts: [{ query: { lastName: name.split(",")[0] ?? "", name }, results: [], sdcmpResults: [] }],
    }));

    const lookup = await lookupPersonInUcpath(page, { kind: "by-name", name: "Towa Moz" }, {
      searchByNameImpl: searchByName,
    });

    assert.deepEqual(
      searchByName.mock.calls.map((call) => call[1]),
      ["Moz, Towa", "Towa, Moz"],
    );
    assert.equal(lookup.input.kind, "by-name");
    assert.equal(lookup.input.name, "Towa, Moz");
  });
});
