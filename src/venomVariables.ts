import * as vscode from "vscode";
import * as yaml from "js-yaml";

/** Definition of one extracted variable (step vars block). */
export interface StepVarDefinition {
  from?: string;
  regex?: string;
  default?: unknown;
}

export interface ParsedStep {
  /** 0-based index within testcase */
  index: number;
  /** Venom display name: step `name` or executor `type` (e.g. exec, http) */
  identifier: string;
  /** Keys under `vars` for this step */
  varNames: string[];
  /** Per-var metadata when present */
  varDetails: Record<string, StepVarDefinition>;
  /** True if YAML has `range` on this step */
  hasRange: boolean;
}

export interface ParsedTestCase {
  index: number;
  name?: string;
  steps: ParsedStep[];
}

export interface GlobalVarEntry {
  key: string;
  value: string;
  source: "venomrc" | "var-file" | "cli-arg" | "env";
  sourceFile?: string;
}

export interface VenomVariableContext {
  suiteVars: string[];
  suiteVarDetails: Record<string, unknown>;
  /** Variables injected globally (.venomrc, CLI, var-files). */
  globalVars: GlobalVarEntry[];
  testcases: ParsedTestCase[];
  parseError?: string;
}

/** Variable available for templates at a point in the file (Venom merges keys flat). */
export interface ScopedVariable {
  /** Template path: Venom uses flat keys after merge, e.g. `token` -> {{.token}} */
  templateKey: string;
  /** Human-readable source */
  source: "suite" | "step" | "global";
  stepIdentifier?: string;
  stepIndex?: number;
  detail?: string;
}

export function isVenomTestDocument(doc: vscode.TextDocument): boolean {
  return (
    doc.uri.scheme === "file" &&
    doc.languageId === "yaml" &&
    doc.uri.fsPath.endsWith(".venom.yml")
  );
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function readStepVarDetails(
  varsObj: Record<string, unknown>
): Record<string, StepVarDefinition> {
  const out: Record<string, StepVarDefinition> = {};
  for (const [k, v] of Object.entries(varsObj)) {
    const o = asRecord(v);
    if (!o) continue;
    out[k] = {
      from: typeof o.from === "string" ? o.from : undefined,
      regex: typeof o.regex === "string" ? o.regex : undefined,
      default: o.default,
    };
  }
  return out;
}

/**
 * Parse Venom YAML and extract suite + per-step vars.
 * Venom merges assigned vars into a flat map for templates ({{.varname}}).
 */
export function parseVenomVariables(text: string): VenomVariableContext {
  let parsed: unknown;
  try {
    parsed = yaml.load(text, { filename: "suite.venom.yml" });
  } catch (e) {
    return {
      suiteVars: [],
      suiteVarDetails: {},
      globalVars: [],
      testcases: [],
      parseError: e instanceof Error ? e.message : String(e),
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    return {
      suiteVars: [],
      suiteVarDetails: {},
      globalVars: [],
      testcases: [],
    };
  }

  const varsBlock = asRecord(root.vars);
  const suiteVars = varsBlock ? Object.keys(varsBlock) : [];
  const suiteVarDetails: Record<string, unknown> = varsBlock
    ? { ...varsBlock }
    : {};

  const rawCases = root.testcases;
  if (!Array.isArray(rawCases)) {
    return { suiteVars, suiteVarDetails, globalVars: [], testcases: [] };
  }

  const testcases: ParsedTestCase[] = [];

  rawCases.forEach((tcRaw, tcIndex) => {
    const tc = asRecord(tcRaw);
    if (!tc) return;

    const name =
      typeof tc.name === "string"
        ? tc.name
        : typeof tc.name === "number"
        ? String(tc.name)
        : undefined;

    const stepsRaw = tc.steps;
    const steps: ParsedStep[] = [];

    if (Array.isArray(stepsRaw)) {
      stepsRaw.forEach((stepRaw, stepIndex) => {
        const step = asRecord(stepRaw);
        if (!step) return;

        const typeStr = typeof step.type === "string" ? step.type : "step";
        const nameStr =
          typeof step.name === "string" && step.name.length > 0
            ? step.name
            : typeStr;

        const varsObj = asRecord(step.vars);
        const varNames = varsObj ? Object.keys(varsObj) : [];
        const varDetails = varsObj ? readStepVarDetails(varsObj) : {};
        const hasRange = step.range !== undefined && step.range !== null;

        steps.push({
          index: stepIndex,
          identifier: nameStr,
          varNames,
          varDetails,
          hasRange,
        });
      });
    }

    testcases.push({ index: tcIndex, name, steps });
  });

  return { suiteVars, suiteVarDetails, globalVars: [], testcases };
}

/**
 * Line-based: find testcase index (0-based) containing line.
 * Assumes 2-space indent for testcase items, 6 spaces for step items under `steps:`.
 */
export function findTestCaseIndexAtLine(
  text: string,
  line: number
): number | undefined {
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) return undefined;

  let inTestCases = false;
  let tcIndex = -1;

  for (let i = 0; i <= line; i++) {
    const L = lines[i];
    const t = L.trimStart();
    const indent = L.length - t.length;

    if (/^testcases:\s*$/.test(t)) {
      inTestCases = true;
      tcIndex = -1;
      continue;
    }

    if (!inTestCases) continue;

    // New top-level key ends testcases section
    if (
      indent === 0 &&
      t.length > 0 &&
      !t.startsWith("#") &&
      !/^testcases:/.test(t)
    ) {
      inTestCases = false;
      continue;
    }

    // Testcase list item: exactly 2 spaces before '-'
    if (/^ {2}-[\s]/.test(L)) {
      tcIndex += 1;
    }
  }

  return tcIndex >= 0 ? tcIndex : undefined;
}

/** Step index (0-based) within testcase: last step header at column ≤ line. */
export function findStepIndexAtLine(
  text: string,
  line: number,
  testcaseIndex: number
): number {
  const lines = text.split(/\r?\n/);
  let inTestCases = false;
  let currentTc = -1;
  let inSteps = false;
  let lastStepInTc = -1;

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const t = L.trimStart();
    const indent = L.length - t.length;

    if (/^testcases:\s*$/.test(t)) {
      inTestCases = true;
      currentTc = -1;
      inSteps = false;
      lastStepInTc = -1;
      continue;
    }

    if (!inTestCases) continue;

    if (
      indent === 0 &&
      t.length > 0 &&
      !t.startsWith("#") &&
      !/^testcases:/.test(t)
    ) {
      inTestCases = false;
      continue;
    }

    if (/^ {2}-[\s]/.test(L)) {
      currentTc += 1;
      inSteps = false;
      lastStepInTc = -1;
      continue;
    }

    if (currentTc === testcaseIndex && /^steps:\s*$/.test(t) && indent >= 2) {
      inSteps = true;
      lastStepInTc = -1;
      continue;
    }

    if (currentTc === testcaseIndex && inSteps && /^ {6}-[\s]/.test(L)) {
      lastStepInTc += 1;
    }

    if (i === line) {
      break;
    }
  }

  return Math.max(0, lastStepInTc);
}

/** Range of `{{ ... }}` containing offset, or undefined. */
export function getTemplateBraceRange(
  text: string,
  offset: number
): { start: number; end: number } | undefined {
  const open = text.lastIndexOf("{{", offset);
  if (open === -1) return undefined;
  const close = text.indexOf("}}", open);
  if (close === -1 || offset > close + 1) return undefined;
  return { start: open, end: close + 2 };
}

/** Text inside {{ }}, excluding braces, from a template range */
export function getTemplateInner(
  text: string,
  range: { start: number; end: number }
): string {
  return text.slice(range.start + 2, range.end - 2).trim();
}

/**
 * Variables in scope for Venom at the given line: suite vars + vars from prior steps in the testcase.
 * Venom uses flat keys (later step can shadow).
 */
export function getScopedVariables(
  ctx: VenomVariableContext,
  testcaseIndex: number,
  /** Exclusive: vars from steps with index < stepIndex */
  stepIndex: number
): ScopedVariable[] {
  const tc = ctx.testcases[testcaseIndex];
  if (!tc) return [];

  const seen = new Map<string, ScopedVariable>();

  // Global vars have lowest priority
  for (const g of ctx.globalVars) {
    const sourceLabel =
      g.source === "venomrc"
        ? ".venomrc variables"
        : g.source === "var-file"
        ? `.venomrc var-file (${g.sourceFile ?? "?"})`
        : g.source === "cli-arg"
        ? `CLI --var${g.sourceFile ? `-from-file (${g.sourceFile})` : ""}`
        : "env";
    seen.set(g.key, {
      templateKey: g.key,
      source: "global",
      detail: `${sourceLabel}: ${g.value.slice(0, 60)}`,
    });
  }

  for (const k of ctx.suiteVars) {
    const val = ctx.suiteVarDetails[k];
    const detail =
      val !== undefined && typeof val !== "object"
        ? String(val).slice(0, 80)
        : undefined;
    seen.set(k, {
      templateKey: k,
      source: "suite",
      detail,
    });
  }

  for (const step of tc.steps) {
    if (step.index >= stepIndex) break;
    for (const varName of step.varNames) {
      const def = step.varDetails[varName];
      const parts: string[] = [];
      if (def?.from) parts.push(`from ${def.from}`);
      if (def?.regex) parts.push(`regex`);
      seen.set(varName, {
        templateKey: varName,
        source: "step",
        stepIdentifier: step.identifier,
        stepIndex: step.index,
        detail: parts.length ? parts.join(", ") : undefined,
      });
    }
  }

  return [...seen.values()];
}

// Cached global vars (updated async, consumed sync by providers)
let cachedGlobalVars: GlobalVarEntry[] = [];

export function setCachedGlobalVars(vars: GlobalVarEntry[]): void {
  cachedGlobalVars = vars;
}

export function getCachedGlobalVars(): GlobalVarEntry[] {
  return cachedGlobalVars;
}

export function parseVariablesFromDocument(
  doc: vscode.TextDocument
): VenomVariableContext {
  const ctx = parseVenomVariables(doc.getText());
  ctx.globalVars = cachedGlobalVars;
  return ctx;
}

export interface CompletionContext {
  inTemplate: boolean;
  /** True when cursor is before the first `.` inside the template (suggest `.var`) */
  needLeadingDot: boolean;
  /** Text after last `.` up to cursor (empty if none) */
  partial: string;
  testcaseIndex: number;
  stepIndex: number;
  scoped: ScopedVariable[];
}

/**
 * Context for completion at position (inside or near a template).
 */
export function getCompletionContext(
  doc: vscode.TextDocument,
  pos: vscode.Position
): CompletionContext | undefined {
  if (!isVenomTestDocument(doc)) return undefined;

  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const range = getTemplateBraceRange(text, offset);
  if (!range) return undefined;

  const innerStart = range.start + 2;
  const cursorInInner = offset >= innerStart && offset <= range.end - 2;
  if (!cursorInInner) return undefined;

  const beforeCursor = text.slice(innerStart, offset);
  const trimmedLeft = beforeCursor.trimStart();
  const line = pos.line;
  const tcIdx = findTestCaseIndexAtLine(text, line) ?? 0;
  const stepIdx = findStepIndexAtLine(text, line, tcIdx);
  const ctx = parseVenomVariables(text);
  ctx.globalVars = cachedGlobalVars;
  const scoped = getScopedVariables(ctx, tcIdx, stepIdx);

  if (!trimmedLeft.startsWith(".")) {
    return {
      inTemplate: true,
      needLeadingDot: true,
      partial: "",
      testcaseIndex: tcIdx,
      stepIndex: stepIdx,
      scoped,
    };
  }

  const dotIdx = beforeCursor.lastIndexOf(".");
  const partial = dotIdx >= 0 ? beforeCursor.slice(dotIdx + 1) : "";

  return {
    inTemplate: true,
    needLeadingDot: false,
    partial,
    testcaseIndex: tcIdx,
    stepIndex: stepIdx,
    scoped,
  };
}

export const BUILTIN_VENOM_KEYS = [
  "venom.testcase",
  "venom.testsuite",
  "venom.teststep.number",
  "venom.testsuite.totalSteps",
  "venom.testcase.totalSteps",
  "venom.executable",
  "venom.outputdir",
  "venom.libdir",
];

export const RANGE_KEYS = ["index", "key", "value"];

/**
 * Build completion labels for current partial path inside {{. ... }}
 */
export function completionItemsForPartial(
  partial: string,
  scoped: ScopedVariable[],
  options: { includeRangeBuiltins: boolean; needLeadingDot: boolean }
): {
  label: string;
  insertText: string;
  detail: string;
  documentation: string;
}[] {
  const items: {
    label: string;
    insertText: string;
    detail: string;
    documentation: string;
  }[] = [];

  const p = partial.trim();
  const prefix = p === "" && options.needLeadingDot ? "." : p === "" ? "" : "";

  if (p === "") {
    for (const v of scoped) {
      const doc =
        v.source === "suite"
          ? "Suite variable (`vars` at top level)"
          : v.source === "global"
          ? "Global variable (injected at runtime)"
          : `From step "${v.stepIdentifier}" (vars)`;
      const detailLabel =
        v.source === "suite"
          ? "suite"
          : v.source === "global"
          ? "global"
          : `step: ${v.stepIdentifier}`;
      items.push({
        label: v.templateKey,
        insertText: `${prefix}${v.templateKey}`,
        detail: detailLabel,
        documentation: [doc, v.detail].filter(Boolean).join("\n\n"),
      });
    }
    for (const k of BUILTIN_VENOM_KEYS) {
      items.push({
        label: k,
        insertText: `${prefix}${k}`,
        detail: "venom",
        documentation: "Built-in Venom variable",
      });
    }
    if (options.includeRangeBuiltins) {
      for (const k of RANGE_KEYS) {
        items.push({
          label: k,
          insertText: `${prefix}${k}`,
          detail: "range",
          documentation: "Available when the step uses `range`",
        });
      }
    }
    return items;
  }

  const lower = p.toLowerCase();
  const filtered = scoped.filter((v) =>
    v.templateKey.toLowerCase().startsWith(lower)
  );
  for (const v of filtered) {
    const detailLabel =
      v.source === "suite"
        ? "suite"
        : v.source === "global"
        ? "global"
        : `step: ${v.stepIdentifier}`;
    items.push({
      label: v.templateKey,
      insertText: v.templateKey,
      detail: detailLabel,
      documentation: v.detail ?? "",
    });
  }

  for (const k of BUILTIN_VENOM_KEYS) {
    if (k.toLowerCase().startsWith(lower) && k !== p) {
      items.push({
        label: k,
        insertText: k,
        detail: "venom",
        documentation: "Built-in Venom variable",
      });
    }
  }

  if (options.includeRangeBuiltins) {
    for (const k of RANGE_KEYS) {
      if (k.toLowerCase().startsWith(lower) && k !== p) {
        items.push({
          label: k,
          insertText: k,
          detail: "range",
          documentation: "Range iteration",
        });
      }
    }
  }

  return items;
}

export function stepHasRangeAtLine(
  text: string,
  _line: number,
  testcaseIndex: number,
  stepIndex: number
): boolean {
  const ctx = parseVenomVariables(text);
  const tc = ctx.testcases[testcaseIndex];
  const st = tc?.steps.find((s) => s.index === stepIndex);
  return st?.hasRange ?? false;
}

/**
 * Find the YAML line where `varName` is defined under a `vars:` block
 * within the given testcase (or at suite level).
 *
 * Returns the last matching definition to match Venom's "last definition wins".
 */
export function findVarDefinitionLine(
  text: string,
  varName: string,
  testcaseIndex: number | undefined
): number | undefined {
  const lines = text.split(/\r?\n/);

  let inSuiteVars = false;
  let suiteVarLine: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const t = L.trimStart();
    const indent = L.length - t.length;

    if (indent === 0 && /^vars:\s*$/.test(t)) {
      inSuiteVars = true;
      continue;
    }
    if (inSuiteVars) {
      if (indent === 0 && t.length > 0 && !t.startsWith("#")) {
        inSuiteVars = false;
        continue;
      }
      const keyMatch = t.match(/^(\w[\w.-]*):/);
      if (keyMatch && indent === 2 && keyMatch[1] === varName) {
        suiteVarLine = i;
      }
    }
  }

  if (testcaseIndex !== undefined) {
    let inTestCases = false;
    let currentTc = -1;
    let inStepVars = false;
    let stepVarLine: number | undefined;

    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const t = L.trimStart();
      const indent = L.length - t.length;

      if (/^testcases:\s*$/.test(t) && indent === 0) {
        inTestCases = true;
        currentTc = -1;
        inStepVars = false;
        continue;
      }
      if (!inTestCases) continue;

      if (
        indent === 0 &&
        t.length > 0 &&
        !t.startsWith("#") &&
        !/^testcases:/.test(t)
      ) {
        inTestCases = false;
        continue;
      }

      if (/^ {2}-[\s]/.test(L)) {
        currentTc += 1;
        inStepVars = false;
        continue;
      }

      if (currentTc !== testcaseIndex) continue;

      if (/^vars:\s*$/.test(t) && indent >= 8) {
        inStepVars = true;
        continue;
      }

      if (inStepVars && indent <= 8 && t.length > 0 && !t.startsWith("#")) {
        inStepVars = false;
      }

      if (inStepVars && indent === 10) {
        const keyMatch = t.match(/^(\w[\w.-]*):/);
        if (keyMatch && keyMatch[1] === varName) {
          stepVarLine = i;
        }
      }
    }

    if (stepVarLine !== undefined) return stepVarLine;
  }

  return suiteVarLine;
}
