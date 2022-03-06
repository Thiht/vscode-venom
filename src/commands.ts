import * as vscode from "vscode";

const replaceSelection = (
  editor: vscode.TextEditorEdit,
  selection: vscode.Selection,
  data: string
) => editor.replace(selection, data);

const replaceDocument = (
  editor: vscode.TextEditorEdit,
  document: vscode.TextDocument,
  data: string
) =>
  editor.replace(
    document.validateRange(
      new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(document.lineCount - 1, Number.MAX_VALUE)
      )
    ),
    data
  );

const pathSanitize = (path: string) => path.toLowerCase().replace(/:/g, "_");

const jsonToVenomAssertions = (json: any, path: string[]): string[] => {
  const assertions = [];
  if (Array.isArray(json)) {
    assertions.push(path.join(".") + ".__len__ ShouldEqual " + json.length);
    for (let i = 0; i < json.length; i++) {
      assertions.push(
        ...jsonToVenomAssertions(json[i], [
          ...path,
          pathSanitize(path[path.length - 1]) + i.toString(),
        ])
      );
    }
  } else if (typeof json === "object" && json !== null) {
    for (const key in json) {
      assertions.push(
        ...jsonToVenomAssertions(json[key], [...path, pathSanitize(key)])
      );
    }
  } else if (json === null) {
    assertions.push(path.join(".") + " ShouldBeEmpty");
  } else if (json === true) {
    assertions.push(path.join(".") + " ShouldBeTrue");
  } else if (json === false) {
    assertions.push(path.join(".") + " ShouldBeFalse");
  } else if (typeof json === "string" || json instanceof String) {
    assertions.push(path.join(".") + ' ShouldEqual "' + json + '"');
  } else if (typeof json === "number") {
    assertions.push(path.join(".") + " ShouldEqual " + json);
  } else {
    // Fallback
    assertions.push(path.join(".") + " ShouldEqual " + json);
  }
  return assertions;
};

export const convertDocument = async () => {
  const quickPick = await vscode.window.showQuickPick(
    [
      { label: "result.bodyjson", description: "HTTP, GRPC executors" },
      { label: "result.systemoutjson", description: "Exec executor" },
      { label: "result.systemerrjson", description: "Exec executor" },
      { label: "result.queries", description: "SQL executor" },
      { label: "result.commands", description: "Redis executor" },
      {
        label: "result.messagesjson",
        description: "Kafka, AMQP, MQTT executors",
      },
      { label: "result.contentjson", description: "ReadFile executor" },
    ],
    {
      title: "Assertions prefix",
      canPickMany: false,
      placeHolder: "result.bodyjson",
    }
  );
  const prefix = (quickPick?.label ?? "result.bodyjson").split(".");

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.selection?.active) {
    activeEditor.edit((editor) => {
      const select = activeEditor.document.getText(activeEditor.selection);
      const input = select || activeEditor.document.getText();

      try {
        const json = JSON.parse(input); // Validate JSON  const pathSanitize = (path) => path.toLowerCase().replace(/:/g, "_");
        const assertions = jsonToVenomAssertions(json, prefix)
          .map((assertion) => "- " + assertion)
          .join("\n");
        select
          ? replaceSelection(editor, activeEditor.selection, assertions)
          : replaceDocument(editor, activeEditor.document, assertions);
      } catch {
        vscode.window.showErrorMessage(
          select
            ? "Selection is not a valid JSON"
            : "Document is not a valid JSON"
        );
      }
    });
  }
};
