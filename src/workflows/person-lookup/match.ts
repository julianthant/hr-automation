import type { Ctx } from "../../core/kernel/types.js";
import { searchPerson } from "../../systems/ucpath/navigate.js";
import type { PersonLookupMatchInput } from "./schema.js";

type PersonLookupMatchCtx = Pick<
  Ctx<readonly ["searching"], PersonLookupMatchInput>,
  "page" | "screenshot" | "updateData"
>;

/**
 * Run the UCPath HR-Tasks Search/Match lookup for one person.
 *
 * The caller owns the enclosing `searching` kernel step so Search and Match
 * modes retain one shared on-disk step vocabulary.
 */
export async function handlePersonMatch(
  ctx: PersonLookupMatchCtx,
  input: PersonLookupMatchInput,
  searchImpl: typeof searchPerson = searchPerson,
): Promise<void> {
  const page = await ctx.page("ucpath");
  const ssn = typeof input.ssn === "string" ? input.ssn : "";
  const dob = typeof input.dob === "string" ? input.dob : "";
  const result = await searchImpl(
    page,
    ssn,
    input.firstName,
    input.lastName,
    dob,
  );
  const match = result.matches?.[0];
  ctx.updateData({
    found: result.found ? "true" : "false",
    matchedEmplId: match?.emplId ?? "",
    matchedName: match
      ? [match.firstName, match.lastName].filter(Boolean).join(" ")
      : "",
  });
  await ctx.screenshot({
    kind: "form",
    label: "person-lookup-match-result",
    systems: ["ucpath"],
  });
}
