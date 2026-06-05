import { beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

import { lookupPersonInUcpath } from "../../../../src/workflows/person-lookup/lookup.js";

const page = {} as never;
const result = {
  emplId: "10535890",
  name: "Mia V Tran",
  lastName: "Tran",
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
      allAttempts: [{ query: { lastName: "Tran", name: "Mia" }, results: [result], sdcmpResults: [result] }],
    });

    const lookup = await lookupPersonInUcpath(page, { kind: "by-name", name: "Mia Tran" }, {
      searchByNameImpl: searchByName,
    });

    assert.equal(searchByName.mock.calls[0]?.[1], "Tran, Mia");
    assert.equal(lookup.input.kind, "by-name");
    assert.equal(lookup.input.name, "Tran, Mia");
    assert.equal(lookup.selection.searchName, "Tran, Mia");
  });

  it("tries no-comma Last First order when natural First Last order returns no candidates", async () => {
    searchByName.mockImplementation(async (_page, name: string) => ({
      sdcmpResults: name === "Tran, Mia" ? [result] : [],
      allAttempts: [{ query: { lastName: name.split(",")[0] ?? "", name }, results: [], sdcmpResults: [] }],
    }));

    const lookup = await lookupPersonInUcpath(page, { kind: "by-name", name: "Tran Mia" }, {
      searchByNameImpl: searchByName,
    });

    assert.deepEqual(
      searchByName.mock.calls.map((call) => call[1]),
      ["Mia, Tran", "Tran, Mia"],
    );
    assert.equal(lookup.input.kind, "by-name");
    assert.equal(lookup.input.name, "Tran, Mia");
  });
});
