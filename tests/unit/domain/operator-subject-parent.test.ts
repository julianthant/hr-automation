import { test } from "node:test";
import assert from "node:assert/strict";
import { parentSubjectData, readParentSubject } from "../../../src/domain/operator-subject.js";

test("parentSubjectData stamps the parentSubject field", () => {
  const stamped = parentSubjectData("Oath Signature · #ab12");
  assert.deepEqual(stamped, { parentSubject: "Oath Signature · #ab12" });
});

test("parentSubjectData returns empty object for empty input", () => {
  assert.deepEqual(parentSubjectData(""), {});
  assert.deepEqual(parentSubjectData(undefined), {});
});

test("readParentSubject extracts from row.data", () => {
  assert.equal(readParentSubject({ parentSubject: "X" }), "X");
  assert.equal(readParentSubject({}), undefined);
  assert.equal(readParentSubject(undefined), undefined);
});
