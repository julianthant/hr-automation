import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fillHrInquiryForm,
  parseTicketNumberFromUrl,
} from "../../../../src/workflows/oath-upload/fill-form.js";

test("parseTicketNumberFromUrl: parses HRC0XXXXXX number= param", () => {
  assert.equal(
    parseTicketNumberFromUrl("https://support.ucsd.edu/esc?id=ticket&number=HRC0123456"),
    "HRC0123456",
  );
});

test("parseTicketNumberFromUrl: returns null when no number= param", () => {
  assert.equal(
    parseTicketNumberFromUrl("https://support.ucsd.edu/esc?id=services"),
    null,
  );
});

test("parseTicketNumberFromUrl: returns null on non-HRC pattern", () => {
  assert.equal(
    parseTicketNumberFromUrl("https://support.ucsd.edu/esc?id=ticket&number=ABC123"),
    null,
  );
});

test("parseTicketNumberFromUrl: tolerates malformed URL", () => {
  assert.equal(parseTicketNumberFromUrl("not a url"), null);
});

test("fillHrInquiryForm: fills subject, description, attaches file, drives Specifically + Category", async () => {
  const calls: string[] = [];
  type FakeLocator = {
    fill: (v: string) => Promise<void>;
    click: (opts?: { timeout?: number }) => Promise<void>;
    setInputFiles: (p: string) => Promise<void>;
    type: (v: string) => Promise<void>;
    selectOption: (v: unknown, opts?: { timeout?: number }) => Promise<void>;
    isVisible: () => Promise<boolean>;
    first: () => FakeLocator;
  };
  const fakeLocator = (label: string): FakeLocator => ({
    fill: (v) => { calls.push(`fill[${label}]=${v}`); return Promise.resolve(); },
    click: () => { calls.push(`click[${label}]`); return Promise.resolve(); },
    setInputFiles: (p) => { calls.push(`setInputFiles[${label}]=${p}`); return Promise.resolve(); },
    type: (v) => { calls.push(`type[${label}]=${v}`); return Promise.resolve(); },
    selectOption: (v) => {
      calls.push(`selectOption[${label}]=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      return Promise.resolve();
    },
    isVisible: () => Promise.resolve(true),
    first: () => fakeLocator(`${label}[0]`),
  });
  const fakePage = {
    getByRole: (_role: string, opts: { name: string }) => fakeLocator(opts.name),
    locator: (sel: string) => fakeLocator(sel),
    waitForTimeout: (_ms: number) => Promise.resolve(),
    url: () => "https://support.ucsd.edu/esc?id=ticket&number=HRC0999999",
    title: () => Promise.resolve("HR General Inquiry - Employee Center"),
  };

  await fillHrInquiryForm(fakePage as never, {
    subject: "HDH New Hire Oaths",
    description: "Please see attached oaths for employees hired under HDH.",
    specifically: "Signing Ceremony (Oath)",
    category: "Payroll",
    attachmentPath: "/tmp/oaths.pdf",
  });

  assert.ok(
    calls.includes("fill[Subject]=HDH New Hire Oaths"),
    `expected Subject fill in calls: ${calls.join(" | ")}`,
  );
  assert.ok(
    calls.includes("fill[Description]=Please see attached oaths for employees hired under HDH."),
    `expected Description fill in calls: ${calls.join(" | ")}`,
  );
  // setInputFiles must hit the file input (registry uses page.locator('input[type="file"]').first()).
  assert.ok(
    calls.some((c) => c.startsWith("setInputFiles[") && c.endsWith("=/tmp/oaths.pdf")),
    `expected setInputFiles call for /tmp/oaths.pdf: ${calls.join(" | ")}`,
  );
  // Specifically + Category were exercised somehow.
  assert.ok(
    calls.some((c) => c.includes("Specifically")),
    `expected Specifically interaction: ${calls.join(" | ")}`,
  );
  assert.ok(
    calls.some((c) => c.includes("Category")),
    `expected Category interaction: ${calls.join(" | ")}`,
  );
});
