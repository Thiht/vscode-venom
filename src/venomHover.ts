import * as vscode from "vscode";
import {
  findStepIndexAtLine,
  findTestCaseIndexAtLine,
  getCachedGlobalVars,
  getScopedVariables,
  getTemplateBraceRange,
  getTemplateInner,
  isVenomTestDocument,
  parseVenomVariables,
} from "./venomVariables";

const venomYamlSelector: vscode.DocumentSelector = {
  language: "yaml",
  pattern: "**/*.venom.yml",
};

function formatScopedCompact(
  vars: ReturnType<typeof getScopedVariables>
): string {
  if (vars.length === 0) {
    return "*No variables in scope.*";
  }
  const lines = vars.map((v) => {
    const stepNum = v.stepIndex !== undefined ? `#${v.stepIndex + 1} ` : "";
    const src =
      v.source === "suite"
        ? "suite"
        : v.source === "global"
        ? "global"
        : `${stepNum}${v.stepIdentifier}`;
    return `\`{{.${v.templateKey}}}\` · ${src}`;
  });
  return `**In scope:** ${lines.join(" | ")}`;
}

export function registerVenomHover(): vscode.Disposable {
  const provider: vscode.HoverProvider = {
    provideHover(document, position) {
      if (!isVenomTestDocument(document)) {
        return undefined;
      }

      const text = document.getText();
      const offset = document.offsetAt(position);
      const tplRange = getTemplateBraceRange(text, offset);

      const tcIdx = findTestCaseIndexAtLine(text, position.line) ?? 0;
      const stepIdx = findStepIndexAtLine(text, position.line, tcIdx);
      const ctx = parseVenomVariables(text);
      ctx.globalVars = getCachedGlobalVars();
      const scoped = getScopedVariables(ctx, tcIdx, stepIdx);

      const md = new vscode.MarkdownString();

      if (tplRange) {
        const inner = getTemplateInner(text, tplRange);
        const trimmed = inner.replace(/^\./, "").trim();
        const parts = trimmed.split(/[\s|]+/)[0] ?? "";
        const firstKey = parts.split(".")[0] ?? "";

        const match = scoped.find(
          (v) => v.templateKey === trimmed || v.templateKey === firstKey
        );

        if (match && trimmed.length > 0) {
          const stepNum =
            match.stepIndex !== undefined ? ` #${match.stepIndex + 1}` : "";
          const src =
            match.source === "suite"
              ? "suite vars"
              : match.source === "global"
              ? "global"
              : `step${stepNum} ${match.stepIdentifier}`;
          const detail = match.detail ? ` · ${match.detail}` : "";
          md.appendMarkdown(`\`{{.${match.templateKey}}}\` — ${src}${detail}`);
          return new vscode.Hover(
            md,
            document.getWordRangeAtPosition(position) ??
              tplRangeToVsRange(document, tplRange)
          );
        }

        // On the braces or lone dot — compact scope list
        md.appendMarkdown(formatScopedCompact(scoped));
        return new vscode.Hover(md, tplRangeToVsRange(document, tplRange));
      }

      return undefined;
    },
  };

  return vscode.languages.registerHoverProvider(venomYamlSelector, provider);
}

function tplRangeToVsRange(
  doc: vscode.TextDocument,
  r: { start: number; end: number }
): vscode.Range {
  return new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
}
