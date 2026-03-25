import * as vscode from "vscode";
import {
  BUILTIN_VENOM_KEYS,
  RANGE_KEYS,
  findStepIndexAtLine,
  findTestCaseIndexAtLine,
  getCachedGlobalVars,
  getScopedVariables,
  isVenomTestDocument,
  parseVenomVariables,
} from "./venomVariables";

const TEMPLATE_RE = /\{\{(.*?)\}\}/g;

/**
 * Scan a document for {{.varname}} references that don't match any
 * in-scope variable, built-in, or range key — and report warnings.
 */
function diagnoseDocument(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  if (!isVenomTestDocument(doc)) {
    collection.delete(doc.uri);
    return;
  }

  const text = doc.getText();
  const ctx = parseVenomVariables(text);
  ctx.globalVars = getCachedGlobalVars();

  if (ctx.parseError) {
    collection.delete(doc.uri);
    return;
  }

  const builtinSet = new Set([...BUILTIN_VENOM_KEYS, ...RANGE_KEYS]);
  // Also allow any prefix of venom.* (e.g. venom.testsuite.shortName)
  const isBuiltin = (key: string) =>
    builtinSet.has(key) || key.startsWith("venom.");

  const diagnostics: vscode.Diagnostic[] = [];

  let match: RegExpExecArray | null;
  TEMPLATE_RE.lastIndex = 0;
  while ((match = TEMPLATE_RE.exec(text)) !== null) {
    const inner = match[1].trim();
    if (!inner.startsWith(".")) continue;

    const varPath = inner.slice(1).split(/[\s|]+/)[0] ?? "";
    if (varPath.length === 0) continue;

    // Top-level key is what we resolve
    const topKey = varPath.split(".")[0];
    if (isBuiltin(varPath) || isBuiltin(topKey)) continue;

    const offset = match.index;
    const pos = doc.positionAt(offset);
    const line = pos.line;

    const tcIdx = findTestCaseIndexAtLine(text, line);
    if (tcIdx === undefined) continue;

    const stepIdx = findStepIndexAtLine(text, line, tcIdx);
    const scoped = getScopedVariables(ctx, tcIdx, stepIdx);

    const found = scoped.some(
      (v) => v.templateKey === varPath || v.templateKey === topKey
    );
    if (found) continue;

    // Also check if this step itself defines the var (self-reference in assertions after vars)
    const currentStep = ctx.testcases[tcIdx]?.steps.find(
      (s) => s.index === stepIdx
    );
    if (currentStep?.varNames.includes(topKey)) continue;

    const innerStart = offset + 2 + match[1].indexOf("." + varPath) + 1;
    const range = new vscode.Range(
      doc.positionAt(innerStart),
      doc.positionAt(innerStart + varPath.length)
    );

    diagnostics.push(
      new vscode.Diagnostic(
        range,
        `"${topKey}" is not defined in scope (suite vars, prior step vars, or globals)`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }

  collection.set(doc.uri, diagnostics);
}

export function registerVenomDiagnostics(): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection("venom");

  const disposables: vscode.Disposable[] = [collection];

  const refresh = (doc: vscode.TextDocument) => {
    diagnoseDocument(doc, collection);
  };

  // Run on open venom files
  for (const doc of vscode.workspace.textDocuments) {
    if (isVenomTestDocument(doc)) refresh(doc);
  }

  disposables.push(
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc))
  );
  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document))
  );
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  return disposables;
}
