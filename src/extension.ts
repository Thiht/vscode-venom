import * as vscode from "vscode";
import { TextDecoder } from "util";
import { basename } from "path";
import * as yaml from "js-yaml";
import { parseFailureMessage, run as venomRun, TestSuite } from "./venom";
import { convertDocument } from "./commands";

// Used to read files from disk
const textDecoder = new TextDecoder("utf-8");
// Used to log output of the Venom extension
const outputChannel = vscode.window.createOutputChannel("Venom");
// Rich data linked to each test item
const testData = new WeakMap<
  vscode.TestItem,
  { rawTestSuite: string; testSuite: TestSuite }
>();

export const activate = async (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("venom.jsonToAssertions", convertDocument)
  );

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

        const workspace = vscode.workspace.getWorkspaceFolder(test.uri!);
        const cwd = workspace!.uri.fsPath;

        const runResult = await venomRun(test.uri!.fsPath, cwd);
        if (!runResult) {
          outputChannel.appendLine("Venom binary not found, aborting");
          run.end();
          return;
        }

        run.appendOutput(`Working directory: ${cwd}\r\n`);
        if (runResult.command) {
          run.appendOutput(`Executing command: ${runResult.command}\r\n`);
        }
        if (runResult.stdout) {
          run.appendOutput(
            runResult.stdout.replace(/(?<!\r)\n/g, "\r\n") + "\r\n"
          );
        }
        if (runResult.stderr) {
          run.appendOutput(
            runResult.stderr.replace(/(?<!\r)\n/g, "\r\n") + "\r\n"
          );
        }

        if (runResult.errors.length === 0 && runResult.failures.length === 0) {
          run.passed(test, Date.now() - start);
        } else {
          const failureMessages = runResult.failures.map((message) => {
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
              const { rawTestSuite } = testData.get(test)!;
              const rawTestSuiteLines = rawTestSuite.split("\n");

              // Ignore the prefix spaces from the line to get a more beautiful visual
              const lineStart =
                rawTestSuiteLines.length >= parsedMessage.line
                  ? rawTestSuiteLines[parsedMessage.line - 1].length -
                    rawTestSuiteLines[parsedMessage.line - 1].trimLeft().length
                  : 0;

              // Get the line length
              const lineEnd =
                rawTestSuiteLines.length >= parsedMessage.line
                  ? rawTestSuiteLines[parsedMessage.line - 1].length
                  : (outputChannel.appendLine(
                      `Line ${parsedMessage.line} doesn't exist in file ${test.uri?.fsPath}`
                    ),
                    1000);

              const range = new vscode.Range(
                parsedMessage.line - 1,
                lineStart,
                parsedMessage.line - 1,
                lineEnd
              );
              testMessage.location = new vscode.Location(test.uri!, range);
            }
            return testMessage;
          });
          const errorMessages = runResult.errors.map(
            (message) => new vscode.TestMessage(message)
          );

          if (failureMessages.length === 0) {
            run.errored(test, errorMessages, Date.now() - start);
          } else {
            run.failed(
              test,
              failureMessages.concat(errorMessages),
              Date.now() - start
            );
          }
        }
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Test failed for an unknown reason";
        run.appendOutput(message + "\n");
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
    if (e.uri.scheme === "file" && e.uri.fsPath.endsWith(".venom.yml")) {
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

  const file = ctrl.createTestItem(id, basename(uri.fsPath), uri);
  file.canResolveChildren = false;
  file.description = testSuite.name;
  ctrl.items.add(file);

  testData.set(file, { rawTestSuite, testSuite });

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
