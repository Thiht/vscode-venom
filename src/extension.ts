import * as vscode from "vscode";
import { convertDocument } from "./commands";
import { registerVenomCompletion } from "./venomCompletion";
import { registerVenomHover } from "./venomHover";
import { registerVenomVariablesView } from "./venomVariablesView";
import { loadSchemaTestSuites } from "./schemaTestSuites";
import { loadSchemaCustomExecutors } from "./schemaCustomExecutors";
import { loadTestView } from "./testView";
import { collectGlobalVars, deduplicateGlobalVars } from "./globalVars";
import { setCachedGlobalVars, GlobalVarEntry } from "./venomVariables";

async function refreshGlobalVarsCache(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.uri.fsPath.endsWith(".venom.yml")) {
    return;
  }
  const raw = await collectGlobalVars(editor.document);
  const deduped = deduplicateGlobalVars(raw);
  const entries: GlobalVarEntry[] = deduped.map((g) => ({
    key: g.key,
    value: g.value,
    source: g.source,
    sourceFile: g.sourceFile,
  }));
  setCachedGlobalVars(entries);
}

export const activate = async (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("venom.jsonToAssertions", convertDocument)
  );

  await loadSchemaTestSuites(context);

  await loadSchemaCustomExecutors(context);

  await loadTestView(context);

  context.subscriptions.push(registerVenomCompletion());
  context.subscriptions.push(registerVenomHover());
  context.subscriptions.push(...registerVenomVariablesView());

  // Populate global vars cache
  await refreshGlobalVarsCache();

  // Refresh when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshGlobalVarsCache();
    })
  );

  // Refresh when .venomrc or variable files change
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      const venomrcWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".venomrc")
      );
      venomrcWatcher.onDidChange(() => refreshGlobalVarsCache());
      venomrcWatcher.onDidCreate(() => refreshGlobalVarsCache());
      venomrcWatcher.onDidDelete(() => {
        setCachedGlobalVars([]);
      });
      context.subscriptions.push(venomrcWatcher);

      const yamlWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "**/*.yaml")
      );
      yamlWatcher.onDidChange(() => refreshGlobalVarsCache());
      context.subscriptions.push(yamlWatcher);
    }
  }

  // Refresh when venom config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("venom.args") ||
        e.affectsConfiguration("venom.additionalRunArguments")
      ) {
        refreshGlobalVarsCache();
      }
    })
  );
};
