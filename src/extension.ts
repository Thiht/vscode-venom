import * as vscode from "vscode";
import { TextDecoder } from "util";
import { basename } from "path";
import * as yaml from "js-yaml";
import { parseFailureMessage, run as venomRun, TestSuite } from "./venom";

// Used to read files from disk
const textDecoder = new TextDecoder("utf-8");
// Used to log output of the Venom extension
const outputChannel = vscode.window.createOutputChannel("Venom");
// Rich data linked to each test item
const testData = new WeakMap<vscode.TestItem, { testSuite: TestSuite }>();

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  const ctrl = vscode.tests.createTestController(
    "venomTestController",
    "Venom"
  );
  context.subscriptions.push(ctrl);

  const runHandler = async (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ) => {
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

      const start = Date.now();
      try {
        run.started(test);
        const runResult = await venomRun(test.uri!.path);

        run.appendOutput(runResult.stdout, undefined, test);
        run.appendOutput(runResult.stderr, undefined, test);

        if (runResult.failures.length === 0) {
          run.passed(test, Date.now() - start);
        } else {
          const messages = runResult.failures.map((message) => {
            const parsedMessage = parseFailureMessage(message);
            const testMessage =
              parsedMessage.expected && parsedMessage.actual
                ? vscode.TestMessage.diff(
                    parsedMessage.raw,
                    parsedMessage.expected,
                    parsedMessage.actual
                  )
                : new vscode.TestMessage(parsedMessage.raw);

            if (parsedMessage.line) {
              // FIXME: compute the range length instead of defaulting to 1000
              const range = new vscode.Range(
                parsedMessage.line,
                0,
                parsedMessage.line,
                1000
              );
              testMessage.location = new vscode.Location(test.uri!, range);
            }
            return testMessage;
          });
          run.failed(test, messages, Date.now() - start);
        }
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : (console.warn(e), "Test failed for an unknown reason");
        run.appendOutput(message, undefined, test);
        run.errored(test, new vscode.TestMessage(message), Date.now() - start);
      }
    }

    run.end();
  };

  ctrl.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);

  ctrl.refreshHandler = async () => {
    outputChannel.appendLine("refreshHandler called");
    await Promise.all(
      getWorkspaceTestPatterns().map(({ pattern }) =>
        findInitialFiles(ctrl, pattern, true)
      )
    );
  };

  ctrl.resolveHandler = async (file) => {
    if (!file) {
      outputChannel.appendLine("resolveHandler called with empty file");
      context.subscriptions.push(...startWatchingWorkspace(ctrl));
      return;
    }
    outputChannel.appendLine(
      `resolveHandler called with file ${file.uri?.toString()}`
    );
  };

  const updateNodeForDocument = (e: vscode.TextDocument) => {
    if (e.uri.scheme === "file" && e.uri.path.endsWith(".venom.yml")) {
      getOrCreateFile(ctrl, e.uri, true);
    }
  };

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateNodeForDocument(e.document)
    )
  );
};

const getOrCreateFile = async (
  ctrl: vscode.TestController,
  uri: vscode.Uri,
  forceRefresh = false
) => {
  const id = uri.toString();

  if (forceRefresh) {
    ctrl.items.delete(id);
  }

  const existing = ctrl.items.get(id);
  if (existing) {
    return existing;
  }

  const rawTestSuite = await getContentFromFilesystem(uri);
  const testSuite = yaml.load(rawTestSuite, {
    filename: uri.fsPath,
  }) as TestSuite;

  const file = ctrl.createTestItem(id, basename(uri.path), uri);
  file.canResolveChildren = false;
  file.description = testSuite.name;
  ctrl.items.add(file);

  testData.set(file, { testSuite });

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

const findInitialFiles = async (
  ctrl: vscode.TestController,
  pattern: vscode.GlobPattern,
  forceRefresh = false
) => {
  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(ctrl, file, forceRefresh);
  }
};

const startWatchingWorkspace = (ctrl: vscode.TestController) =>
  getWorkspaceTestPatterns().map(({ pattern }) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => {
      outputChannel.appendLine(`File created: ${uri.fsPath}`);
      getOrCreateFile(ctrl, uri);
    });
    watcher.onDidChange((uri) => {
      outputChannel.appendLine(`File changed: ${uri.fsPath}`);
      getOrCreateFile(ctrl, uri, true);
    });
    watcher.onDidDelete((uri) => {
      outputChannel.appendLine(`File deleted: ${uri.fsPath}`);
      ctrl.items.delete(uri.toString());
    });

    findInitialFiles(ctrl, pattern);

    return watcher;
  });

const getContentFromFilesystem = async (uri: vscode.Uri) => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    outputChannel.appendLine(`Failed to read file ${uri.fsPath}: ${e}`);
    return "";
  }
};
