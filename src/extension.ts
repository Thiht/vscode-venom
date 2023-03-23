import * as vscode from "vscode";
import { convertDocument } from "./commands";
import { loadCustomExecutors } from "./customExecutors";
import { loadTestView } from "./testView";

export const activate = async (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("venom.jsonToAssertions", convertDocument)
  );

  await loadCustomExecutors(context);

  await loadTestView(context);
};
