import * as vscode from "vscode";
import { convertDocument } from "./commands";
import { loadSchemaTestSuites } from "./schemaTestSuites";
import { loadSchemaCustomExecutors } from "./schemaCustomExecutors";
import { loadTestView } from "./testView";

export const activate = async (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("venom.jsonToAssertions", convertDocument)
  );

  await loadSchemaTestSuites(context);

  await loadSchemaCustomExecutors(context);

  await loadTestView(context);
};
