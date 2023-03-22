import * as vscode from "vscode";
import { TextDecoder } from "util";
import { basename, join, relative, isAbsolute } from "path";
import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import {
  parseFailureMessage,
  run as venomRun,
  TestSuite,
  ConfigurationFile,
} from "./venom";
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

  await loadCustomExecutors(context);

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
      request.include.forEach((test) => {
        if (test.children.size === 0) {
          queue.push(test);
        } else {
          queue.push(...listTestItems(test.children));
        }
      });
    } else {
      queue.push(...listTestItems(ctrl.items));
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

const listTestItems = (
  parent: vscode.TestItemCollection
): vscode.TestItem[] => {
  const list: vscode.TestItem[] = [];
  parent.forEach((test) => {
    if (test.children.size === 0) {
      list.push(test);
    } else {
      list.push(...listTestItems(test.children));
    }
  });
  return list;
};

const createTree = (
  ctrl: vscode.TestController,
  parent: vscode.TestItemCollection,
  items: string[]
): vscode.TestItemCollection => {
  const [head, ...tail] = items;

  let headItem = parent.get(head);
  if (!headItem) {
    headItem = ctrl.createTestItem(head, head.split("/").pop()!);
    parent.add(headItem);
  }
  parent = headItem.children;

  if (tail.length === 0) {
    return parent;
  }
  tail[0] = head + "/" + tail[0];
  return createTree(ctrl, parent, tail);
};

const getOrCreateFile = async (
  ctrl: vscode.TestController,
  uri: vscode.Uri,
  forceRefresh = false
) => {
  const id = uri.toString();

  let parent = ctrl.items;
  if (vscode.workspace.workspaceFolders) {
    // List currently opened workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders
      .map((folder) => folder.uri.fsPath)
      .sort((a, b) => b.length - a.length);

    // Find workspace folder of the current test file
    const workspaceFolder = workspaceFolders.find((workspaceFolder) =>
      uri.fsPath.startsWith(workspaceFolder)
    );
    if (workspaceFolder) {
      // If we find it, we'll create the tree from the workspace folder name to the test file
      const nestedFolders = uri.fsPath
        .slice(workspaceFolder.length + 1) // Remove root folder prefix
        .split("/") // List of the individual nested folders
        .slice(0, -1); // Remove current file name to keep only the folders

      const folders = [workspaceFolder, ...nestedFolders];
      parent = createTree(ctrl, parent, folders);
    }
  }

  if (forceRefresh) {
    parent.delete(id);
  }

  const existing = parent.get(id);
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
  parent.add(file);

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

// YAML extension stuff

const VSCODE_YAML_EXTENSION_ID = "redhat.vscode-yaml";

// Retrieved from redhat-developer/vscode-yaml
// See: https://github.com/redhat-developer/vscode-yaml/blob/268fef3361bd01e8167e8ba29d08bc116927992c/src/schema-extension-api.ts#LL38-L46C2
interface YAMLExtensionAPI {
  registerContributor(
    schema: string,
    requestSchema: (resource: string) => string,
    requestSchemaContent: (uri: string) => Promise<string> | string,
    label?: string
  ): boolean;
}

const activateYAMLExtension = async () => {
  const extension = vscode.extensions.getExtension<YAMLExtensionAPI>(
    VSCODE_YAML_EXTENSION_ID
  );
  if (!extension) {
    return undefined;
  }

  if (extension.isActive) {
    return extension.exports;
  }

  const extensionAPI = await extension.activate();
  if (!extensionAPI) {
    return undefined;
  }
  return extensionAPI;
};

const CUSTOM_EXECUTOR_SCHEMA = "VSCODE_VENOM_CUSTOM_EXECUTOR_SCHEMA";

const loadCustomExecutors = async (context: vscode.ExtensionContext) => {
  const yamlExtension = await activateYAMLExtension();
  if (!yamlExtension) {
    outputChannel.appendLine(
      "Failed to activate YAML extension, custom executors won't be parsed"
    );
    return;
  }

  outputChannel.appendLine("Loading venom-custom-executor.schema.json");
  const customExecutorSchema: string = await (async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.parse(
          context.asAbsolutePath("schema/venom-custom-executor.schema.json")
        )
      );
      return textDecoder.decode(bytes);
    } catch (e) {
      outputChannel.appendLine(
        "Failed to load venom-custom-executor.schema.json"
      );
      return "";
    }
  })();

  outputChannel.appendLine(
    "Registering custom executor schema to YAML extension"
  );
  const registered = yamlExtension.registerContributor(
    CUSTOM_EXECUTOR_SCHEMA,

    (resource: string) => {
      const resourceURI = vscode.Uri.parse(resource);
      const workspace = vscode.workspace.getWorkspaceFolder(resourceURI);

      // FIXME: the .venomrc is read on each invocation and it uses readFileSync
      // This should be replaced with a file watcher and async reading outside of requestSchemaContent
      const venomrc = (() => {
        const venomrcPath = join(workspace!.uri.fsPath, ".venomrc");
        try {
          const bytes = readFileSync(venomrcPath);
          const venomrcFile = textDecoder.decode(bytes);
          return yaml.load(venomrcFile, {
            filename: venomrcPath,
          }) as ConfigurationFile;
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((e as any)?.code === "ENOENT") {
            // No .venomrc file in workspace
          } else {
            outputChannel.appendLine(
              `Failed to read .venomrc file in workspace: ${e}`
            );
          }
          return undefined;
        }
      })();

      const venomLibDirName = venomrc?.lib_dir ?? "lib";
      const venomLibDirPath = join(workspace!.uri.fsPath, venomLibDirName);

      const relativePath = relative(venomLibDirPath, resourceURI.fsPath);
      const isSubdir =
        relativePath &&
        !relativePath.startsWith("..") &&
        !isAbsolute(relativePath);

      if (isSubdir) {
        return `${CUSTOM_EXECUTOR_SCHEMA}://schema/venom-custom-executor.schema.json`;
      }
      return "";
    },

    (uri: string) => {
      const parsedUri = vscode.Uri.parse(uri);
      if (parsedUri.scheme !== CUSTOM_EXECUTOR_SCHEMA) {
        return "";
      }
      return customExecutorSchema;
    }
  );
  if (!registered) {
    outputChannel.appendLine(
      "Failed to register custom executor schema to YAML extension"
    );
  }
};
