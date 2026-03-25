import * as vscode from "vscode";
import {
  findTestCaseIndexAtLine,
  findVarDefinitionLine,
  getTemplateBraceRange,
  getTemplateInner,
  isVenomTestDocument,
} from "./venomVariables";

const venomYamlSelector: vscode.DocumentSelector = {
  language: "yaml",
  pattern: "**/*.venom.yml",
};

export function registerVenomDefinition(): vscode.Disposable {
  const provider: vscode.DefinitionProvider = {
    provideDefinition(document, position) {
      if (!isVenomTestDocument(document)) return undefined;

      const text = document.getText();
      const offset = document.offsetAt(position);
      const tplRange = getTemplateBraceRange(text, offset);
      if (!tplRange) return undefined;

      const inner = getTemplateInner(text, tplRange);
      const trimmed = inner.replace(/^\./, "").trim();
      const varPath = trimmed.split(/[\s|]+/)[0] ?? "";
      const topKey = varPath.split(".")[0];
      if (!topKey) return undefined;

      const tcIdx = findTestCaseIndexAtLine(text, position.line);
      const line = findVarDefinitionLine(text, topKey, tcIdx);
      if (line === undefined) return undefined;

      const lineText = document.lineAt(line).text;
      const col = lineText.indexOf(topKey + ":");
      if (col < 0) return undefined;

      return new vscode.Location(document.uri, new vscode.Position(line, col));
    },
  };

  return vscode.languages.registerDefinitionProvider(
    venomYamlSelector,
    provider
  );
}
