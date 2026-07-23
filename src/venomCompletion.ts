import * as vscode from "vscode";
import {
  completionItemsForPartial,
  getCompletionContext,
  getTemplateBraceRange,
  isVenomTestDocument,
  stepHasRangeAtLine,
} from "./venomVariables";

const venomYamlSelector: vscode.DocumentSelector = {
  language: "yaml",
  pattern: "**/*.venom.yml",
};

export function registerVenomCompletion(): vscode.Disposable {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      if (!isVenomTestDocument(document)) {
        return undefined;
      }

      const ctx = getCompletionContext(document, position);
      if (!ctx) {
        return undefined;
      }

      const text = document.getText();
      const offset = document.offsetAt(position);
      const range = getTemplateBraceRange(text, offset);
      if (!range) return undefined;

      let replaceStart = position;
      if (ctx.needLeadingDot) {
        replaceStart = position;
      } else if (ctx.partial.length > 0) {
        replaceStart = document.positionAt(offset - ctx.partial.length);
      }

      const replaceRange = new vscode.Range(replaceStart, position);

      const includeRange = stepHasRangeAtLine(
        text,
        position.line,
        ctx.testcaseIndex,
        ctx.stepIndex
      );

      const raw = completionItemsForPartial(ctx.partial, ctx.scoped, {
        includeRangeBuiltins: includeRange,
        needLeadingDot: ctx.needLeadingDot,
      });

      return raw.map((r) => {
        const item = new vscode.CompletionItem(
          r.label,
          vscode.CompletionItemKind.Variable
        );
        item.detail = r.detail;
        item.documentation = new vscode.MarkdownString(r.documentation);
        item.range = replaceRange;
        item.insertText = r.insertText;
        return item;
      });
    },
  };

  return vscode.languages.registerCompletionItemProvider(
    venomYamlSelector,
    provider,
    "{",
    "."
  );
}
