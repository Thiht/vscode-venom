import { TextDecoder } from "util";
import * as vscode from "vscode";
import * as yaml from "js-yaml";
import { getVersion, TestSuite } from "./venom";

const textDecoder = new TextDecoder("utf-8");
const outputChannel = vscode.window.createOutputChannel("Venom");
const testData = new WeakMap<vscode.TestItem, { testSuite: TestSuite }>();

export const activate = async (context: vscode.ExtensionContext) => {
  outputChannel.appendLine("Loading Venom extension");

  const ctrl = vscode.tests.createTestController("venomTestController", "Venom");
  context.subscriptions.push(ctrl);

  const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const run = ctrl.createTestRun(request);

    const queue: vscode.TestItem[] = [];
    if (request.include) {
      queue.push(...request.include);
    } else {
      ctrl.items.forEach((test) => queue.push(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      if (request.exclude?.includes(test)) {
        continue;
      }

      if (test.children.size === 0) {
        // FIXME: if children == 0, consider we're on a test case
        // it's wrong but good enough for now
        const start = Date.now();
        try {
          await getVersion();
          run.passed(test, Date.now() - start);
        } catch (e) {
          let message = "fail";
          if (e instanceof Error) {
            message = e.message;
          }
          vscode.window.showErrorMessage(message);
          run.failed(test, new vscode.TestMessage(message), Date.now() - start);
        }
      } else {
        test.children.forEach((test) => queue.push(test));
      }
    }

    run.end();
  };

  ctrl.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);

  ctrl.refreshHandler = async () => {
    await Promise.all(getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(ctrl, pattern)));
  };

  ctrl.resolveHandler = async (file) => {
    if (!file) {
      outputChannel.appendLine("resolveHandler called with empty file");
      context.subscriptions.push(...startWatchingWorkspace(ctrl));
      return;
    }
    outputChannel.appendLine(`resolveHandler called with file ${file.id}`);

    updateFromDisk(ctrl, file);
  };

  const updateNodeForDocument = (e: vscode.TextDocument) => {
    if (e.uri.scheme === "file" && e.uri.path.endsWith(".venom.yml")) {
      getOrCreateFile(ctrl, e.uri);
    }
  };

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument((e) => updateNodeForDocument(e.document))
  );
};

const getOrCreateFile = async (ctrl: vscode.TestController, uri: vscode.Uri) => {
  const id = uri.toString();
  const existing = ctrl.items.get(id);
  if (existing) {
    return existing;
  }

  const rawTestSuite = await getContentFromFilesystem(uri);
  const testSuite = yaml.load(rawTestSuite, { filename: uri.toString() }) as TestSuite;

  const file = ctrl.createTestItem(id, uri.path.split("/").pop()!, uri);
  file.canResolveChildren = true;
  file.description = testSuite.name;
  ctrl.items.add(file);

  testData.set(file, { testSuite });

  updateFromDisk(ctrl, file);

  return file;
};

const getWorkspaceTestPatterns = () => {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
    workspaceFolder,
    pattern: new vscode.RelativePattern(workspaceFolder, "**/*.venom.yml"),
  }));
};

const findInitialFiles = async (ctrl: vscode.TestController, pattern: vscode.GlobPattern) => {
  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(ctrl, file);
  }
};

const startWatchingWorkspace = (ctrl: vscode.TestController) =>
  getWorkspaceTestPatterns().map(({ pattern }) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => getOrCreateFile(ctrl, uri));
    watcher.onDidChange(async (uri) => {
      const file = await getOrCreateFile(ctrl, uri);
      updateFromDisk(ctrl, file);
    });
    watcher.onDidDelete((uri) => ctrl.items.delete(uri.toString()));

    findInitialFiles(ctrl, pattern);

    return watcher;
  });

const updateFromDisk = (ctrl: vscode.TestController, file: vscode.TestItem) => {
  const data = testData.get(file);
  data!.testSuite.testcases.forEach((testCase, i) => {
    const label = testCase.name || `Test case #${i}`;
    const child = ctrl.createTestItem(`${file.uri}/${i}`, label, file.uri);
    file.children.add(child);
  });
};

const getContentFromFilesystem = async (uri: vscode.Uri) => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    console.warn(`Error providing tests for ${uri.fsPath}`, e);
    return "";
  }
};
