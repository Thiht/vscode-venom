"use strict";

const assert = require("assert");
const path = require("path");
const {
  parseVenomVariables,
  findTestCaseIndexAtLine,
  findStepIndexAtLine,
  getScopedVariables,
  getTemplateBraceRange,
  completionItemsForPartial,
} = require("../out/venomVariables");

const sampleYaml = `name: demo
vars:
  baseUrl: https://example.com
testcases:
  - name: First case
    steps:
      - type: http
        name: login
        url: "{{.baseUrl}}/login"
        vars:
          token:
            from: result.bodyjson.access_token
      - type: http
        url: "{{.token}}/api"
`;

assert.strictEqual(parseVenomVariables(sampleYaml).suiteVars.includes("baseUrl"), true);
assert.strictEqual(
  parseVenomVariables(sampleYaml).testcases[0].steps[0].varNames.includes("token"),
  true
);

const lines = sampleYaml.split("\n");
const urlLineIdx = lines.findIndex((l) => l.includes("{{.token}}"));
assert.ok(urlLineIdx >= 0);
const tcIdx = findTestCaseIndexAtLine(sampleYaml, urlLineIdx);
assert.strictEqual(tcIdx, 0);
const stepIdx = findStepIndexAtLine(sampleYaml, urlLineIdx, tcIdx);
assert.strictEqual(stepIdx, 1);

const ctx = parseVenomVariables(sampleYaml);
const scoped = getScopedVariables(ctx, 0, 1);
assert.ok(scoped.some((s) => s.templateKey === "baseUrl"));
assert.ok(scoped.some((s) => s.templateKey === "token"));

const text = "x {{.foo}} y";
const r = getTemplateBraceRange(text, 5);
assert.ok(r);
assert.strictEqual(text.slice(r.start, r.end), "{{.foo}}");

const items = completionItemsForPartial("", scoped, {
  includeRangeBuiltins: false,
  needLeadingDot: true,
});
assert.ok(items.some((i) => i.insertText === ".token"));

// Global vars integration
const ctxWithGlobal = parseVenomVariables(sampleYaml);
ctxWithGlobal.globalVars = [
  { key: "apiHost", value: "api.example.com", source: "venomrc" },
  { key: "dbUser", value: "admin", source: "var-file", sourceFile: "vars.yaml" },
  { key: "token", value: "override", source: "cli-arg" },
];
const scopedWithGlobal = getScopedVariables(ctxWithGlobal, 0, 1);
assert.ok(scopedWithGlobal.some((s) => s.templateKey === "apiHost" && s.source === "global"));
assert.ok(scopedWithGlobal.some((s) => s.templateKey === "dbUser" && s.source === "global"));
// Step var 'token' should override global 'token' (step has higher priority)
const tokenVar = scopedWithGlobal.find((s) => s.templateKey === "token");
assert.strictEqual(tokenVar.source, "step");

// Global vars appear in completion
const globalItems = completionItemsForPartial("", scopedWithGlobal, {
  includeRangeBuiltins: false,
  needLeadingDot: false,
});
assert.ok(globalItems.some((i) => i.label === "apiHost" && i.detail === "global"));
assert.ok(globalItems.some((i) => i.label === "dbUser" && i.detail === "global"));

console.log("venomVariables tests ok");
