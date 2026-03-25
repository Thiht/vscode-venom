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

// =============================================================
// findVarDefinitionLine tests
// =============================================================
const { findVarDefinitionLine } = require("../out/venomVariables");

// Suite-level var
const defLine = findVarDefinitionLine(sampleYaml, "baseUrl", 0);
assert.strictEqual(defLine, 2, "baseUrl should be on line 2 (0-based)");

// Step-level var
const tokenDefLine = findVarDefinitionLine(sampleYaml, "token", 0);
assert.strictEqual(tokenDefLine, 10, "token should be on step vars line");

// Non-existent var -> undefined
assert.strictEqual(findVarDefinitionLine(sampleYaml, "nope", 0), undefined);

// Step var preferred over suite var when both exist
const overrideYaml = `name: override test
vars:
  foo: from-suite
testcases:
  - name: tc
    steps:
      - type: exec
        vars:
          foo:
            from: result.code
`;
const overrideLines = overrideYaml.split("\n");
const fooSuiteLine = overrideLines.findIndex((l) => l === "  foo: from-suite");
const fooStepLine = overrideLines.findIndex((l) => l === "          foo:");
assert.ok(fooSuiteLine >= 0);
assert.ok(fooStepLine >= 0);
// With testcaseIndex=0, step var should win
assert.strictEqual(findVarDefinitionLine(overrideYaml, "foo", 0), fooStepLine);
// With testcaseIndex=undefined, suite var should be returned
assert.strictEqual(findVarDefinitionLine(overrideYaml, "foo", undefined), fooSuiteLine);

// =============================================================
// Diagnostics logic: BUILTIN_VENOM_KEYS should be recognized
// =============================================================
const { BUILTIN_VENOM_KEYS, RANGE_KEYS } = require("../out/venomVariables");
assert.ok(BUILTIN_VENOM_KEYS.includes("venom.testcase"));
assert.ok(RANGE_KEYS.includes("value"));

// Verify that scoped variables do NOT include undefined refs
const undefinedRefYaml = `name: diag test
vars:
  host: localhost
testcases:
  - name: tc
    steps:
      - type: exec
        script: "echo {{.host}} {{.undefined_var}}"
`;
const diagCtx = parseVenomVariables(undefinedRefYaml);
diagCtx.globalVars = [];
const diagScoped = getScopedVariables(diagCtx, 0, 0);
assert.ok(diagScoped.some((s) => s.templateKey === "host"), "host should be in scope");
assert.ok(!diagScoped.some((s) => s.templateKey === "undefined_var"), "undefined_var should NOT be in scope");

console.log("venomVariables tests ok");
