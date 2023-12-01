import * as vscode from "vscode";
import { TextDecoder } from "util";
import { join, relative, isAbsolute } from "path";
import * as yaml from "js-yaml";
import { ConfigurationFile, CustomExecutor, defaultLibDir } from "./venom";
import { activateYAMLExtension } from "./yamlExtension";
import { log } from "./log";

// Unique key to identify the YAML extension schema requests destined to this extension
const CUSTOM_EXECUTOR_SCHEMA = "VSCODE_VENOM_CUSTOM_EXECUTOR_SCHEMA";

// Up-to-date parsed content of the .venomrc file for each of the open workspaces
const venomrcByWorkspace = new Map<string, ConfigurationFile>();

// Up-to-date parsed content of the custom executors for each of the open workspaces
export const customExecutorsByWorkspace = new Map<string, CustomExecutor[]>();

// TODO: when a venomrc file changes, dispose the current custom executors watchers and call startWatchingCustomExecutors again
// const customExecutorsWatchersByWorkspace = new Map<
//   string,
//   vscode.FileSystemWatcher[]
// >();

// Watch and read the .venomrc files inside each of the open workspaces
// They're parsed and saved to venomrcByWorkspace
const startWatchingVenomrcFiles = (context: vscode.ExtensionContext): void => {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const patterns = vscode.workspace.workspaceFolders.map(
    (workspaceFolder) => new vscode.RelativePattern(workspaceFolder, ".venomrc")
  );

  const watchers = patterns.map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const loadVenomrcFile = async (uri: vscode.Uri) => {
      log.debug(`Loading ${uri.fsPath}`);
      const workspacePath =
        vscode.workspace.getWorkspaceFolder(uri)!.uri.fsPath;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const venomrcFile = new TextDecoder("utf-8").decode(bytes);
      const venomrc = yaml.load(venomrcFile, {
        filename: uri.fsPath,
      }) as ConfigurationFile;
      venomrcByWorkspace.set(workspacePath, venomrc);
    };

    (async () => {
      for (const uri of await vscode.workspace.findFiles(pattern)) {
        await loadVenomrcFile(uri);
      }
      startWatchingCustomExecutors();
    })();

    watcher.onDidCreate(async (uri) => {
      log.debug(`${uri.fsPath} created`);
      await loadVenomrcFile(uri);
    });

    watcher.onDidChange(async (uri) => {
      log.debug(`${uri.fsPath} updated`);
      await loadVenomrcFile(uri);
    });

    watcher.onDidDelete((uri) => {
      log.debug(`${uri.fsPath} deleted`);
      const workspacePath =
        vscode.workspace.getWorkspaceFolder(uri)!.uri.fsPath;
      venomrcByWorkspace.delete(workspacePath);
    });

    return watcher;
  });

  context.subscriptions.push(...watchers);
};

const startWatchingCustomExecutors = () => {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  const patterns = vscode.workspace.workspaceFolders.map((workspaceFolder) => {
    let venomLibDirName =
      venomrcByWorkspace.get(workspaceFolder.uri.fsPath)?.lib_dir ??
      defaultLibDir;
    if (!venomLibDirName.endsWith("/")) {
      venomLibDirName += "/";
    }

    return new vscode.RelativePattern(
      workspaceFolder,
      `${venomLibDirName}**/*.yml`
    );
  });

  const watchers = patterns.map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const loadCustomExecutorFile = async (uri: vscode.Uri) => {
      log.info(`Loading custom executor ${uri.fsPath}`);
      const workspacePath =
        vscode.workspace.getWorkspaceFolder(uri)!.uri.fsPath;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const customExecutorFile = new TextDecoder("utf-8").decode(bytes);
      const customExecutor = yaml.load(customExecutorFile, {
        filename: uri.fsPath,
      }) as CustomExecutor;

      if (!customExecutorsByWorkspace.has(workspacePath)) {
        customExecutorsByWorkspace.set(workspacePath, []);
      }
      const customExecutors = customExecutorsByWorkspace.get(workspacePath)!;
      customExecutors.push(customExecutor);
    };

    (async () => {
      for (const uri of await vscode.workspace.findFiles(pattern)) {
        await loadCustomExecutorFile(uri);
      }
    })();

    watcher.onDidCreate(async (uri) => {
      log.debug(`${uri.fsPath} created`);
      await loadCustomExecutorFile(uri);
    });

    watcher.onDidChange(async (uri) => {
      log.debug(`${uri.fsPath} updated`);
      await loadCustomExecutorFile(uri);
    });

    watcher.onDidDelete((uri) => {
      log.debug(`${uri.fsPath} deleted`);
      const workspacePath =
        vscode.workspace.getWorkspaceFolder(uri)!.uri.fsPath;
      customExecutorsByWorkspace.delete(workspacePath);
    });

    return watcher;
  });

  return watchers;
};

export const loadSchemaCustomExecutors = async (
  context: vscode.ExtensionContext
) => {
  log.debug("Activating YAML extension");
  const yamlExtension = await activateYAMLExtension();
  if (!yamlExtension) {
    log.warn(
      "Failed to activate YAML extension, custom executors won't be parsed"
    );
    return;
  }

  log.info("Loading venom-custom-executor.schema.json");
  const customExecutorSchema: string = await (async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.parse(
          context.asAbsolutePath("schema/venom-custom-executor.schema.json")
        )
      );
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      log.warn("Failed to load venom-custom-executor.schema.json", e);
      return "";
    }
  })();

  startWatchingVenomrcFiles(context);

  log.info("Registering custom executor schema to YAML extension");
  const registered = yamlExtension.registerContributor(
    CUSTOM_EXECUTOR_SCHEMA,

    // Return the venom-custom-executor schema URI when the resource is a YAML file inside the configured Venom lib dir
    (resource: string) => {
      const resourceURI = vscode.Uri.parse(resource);
      log.debug(
        `Schema request for ${resourceURI.fsPath} from the YAML extension`
      );
      const workspace = vscode.workspace.getWorkspaceFolder(resourceURI);

      const venomrc = venomrcByWorkspace.get(workspace!.uri.fsPath);
      const venomLibDirName = venomrc?.lib_dir ?? defaultLibDir;
      const venomLibDirPath = join(workspace!.uri.fsPath, venomLibDirName);
      log.info(`Computed Venom lib directory: ${venomLibDirPath}`);

      // See: https://stackoverflow.com/a/45242825
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

    // Return the venom-custom-executor schema for the CUSTOM_EXECUTOR_SCHEMA URI
    (uri: string) => {
      const schemaURI = vscode.Uri.parse(uri);
      if (schemaURI.scheme !== CUSTOM_EXECUTOR_SCHEMA) {
        return "";
      }
      log.debug(
        `Schema content request for ${schemaURI.fsPath} from the YAML extension`
      );
      // TODO: enrich customExecutorSchema declared steps with custom executors, because they can call each other
      // TODO: type customExecutorSchema steps instead of just using "array"
      return customExecutorSchema;
    }
  );

  if (!registered) {
    log.warn("Failed to register custom executor schema to YAML extension");
  }
};
