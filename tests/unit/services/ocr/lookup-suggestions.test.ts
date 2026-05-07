import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLookupSuggestionPrompt,
  parseLookupSuggestionResponse,
} from "../../../../src/services/ocr/lookup-suggestions.js";

test("buildLookupSuggestionPrompt asks for two to three lookup candidates", () => {
  const prompt = buildLookupSuggestionPrompt({
    formType: "oath",
    recordJson: JSON.stringify({ printedName: "Jhn Batistessa", employeeId: "" }),
  });

  assert.match(prompt, /2-3/i);
  assert.match(prompt, /name/i);
  assert.match(prompt, /emplId/i);
});

test("parseLookupSuggestionResponse tolerates object wrapper and normalizes EIDs", () => {
  const parsed = parseLookupSuggestionResponse(`
    {"suggestions":[
      {"name":"Johnnie Battistessa","confidence":0.72},
      {"emplId":"A10873698","confidence":0.81},
      {"name":"  ","emplId":"","confidence":0.1}
    ]}
  `);

  assert.deepEqual(parsed, [
    { name: "Johnnie Battistessa", confidence: 0.72 },
    { emplId: "10873698", confidence: 0.81 },
  ]);
});

test("parseLookupSuggestionResponse caps suggestions at three", () => {
  const parsed = parseLookupSuggestionResponse(JSON.stringify([
    { name: "A" },
    { name: "B" },
    { name: "C" },
    { name: "D" },
  ]));

  assert.deepEqual(parsed.map((s) => s.name), ["A", "B", "C"]);
});
