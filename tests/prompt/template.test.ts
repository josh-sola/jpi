import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { interpolate } from "../../modules/prompt/template.ts";

test("interpolate substitutes known variables", () => {
  const result = interpolate("# Tools\n\n${TOOL_LIST}\n\n${GUIDELINES}", {
    TOOL_LIST: "- read: reads files",
    GUIDELINES: "- Be concise",
  });
  assert.equal(result, "# Tools\n\n- read: reads files\n\n- Be concise");
});

test("interpolate leaves an unrecognized ${...} sequence literal", () => {
  const result = interpolate("Hello ${NAME}, your ${UNKNOWN_VAR} stays put.", {
    NAME: "Josh",
  });
  assert.equal(result, "Hello Josh, your ${UNKNOWN_VAR} stays put.");
});

test("interpolate renders an empty variable as an empty string, not literal", () => {
  const result = interpolate("before[${EMPTY}]after", { EMPTY: "" });
  assert.equal(result, "before[]after");
});

test("interpolate ignores non-uppercase or malformed ${...} sequences", () => {
  const result = interpolate("literal ${lowercase} and ${123} and ${}", { LOWERCASE: "nope" });
  assert.equal(result, "literal ${lowercase} and ${123} and ${}");
});

test("interpolate substitutes every occurrence of a repeated variable", () => {
  const result = interpolate("${X} and ${X} again", { X: "yo" });
  assert.equal(result, "yo and yo again");
});
