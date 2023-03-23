import * as vscode from "vscode";
import { TextDecoder } from "util";
import { join, relative, isAbsolute } from "path";
import * as yaml from "js-yaml";
import { ConfigurationFile } from "./venom";
import { activateYAMLExtension } from "./yamlExtension";
import { log } from "./log";

// Used to read files from disk
const textDecoder = new TextDecoder("utf-8");

// Unique key to identify the YAML extension schema requests destined to this extension
const CUSTOM_EXECUTOR_SCHEMA = "VSCODE_VENOM_CUSTOM_EXECUTOR_SCHEMA";

// Up-to-date parsed content of the .venomrc file for each of the open workspaces
const venomrcByWorkspace = new Map<string, ConfigurationFile>();

// Watch and read the .venomrc files inside each of the open workspaces
// They're parsed and saved to venomrcByWorkspace
const startWatchingVenomrcFiles = () => {
  if (!vscode.workspace.workspaceFolders) {
    return [];
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
      const venomrcFile = textDecoder.decode(bytes);
      const venomrc = yaml.load(venomrcFile, {
        filename: uri.fsPath,
      }) as ConfigurationFile;
      venomrcByWorkspace.set(workspacePath, venomrc);
    };

    // Initial load of the .venomrc files
    (async () => {
      for (const uri of await vscode.workspace.findFiles(pattern)) {
        await loadVenomrcFile(uri);
      }
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

  return watchers;
};

export const loadCustomExecutors = async (context: vscode.ExtensionContext) => {
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
      return textDecoder.decode(bytes);
    } catch (e) {
      log.warn("Failed to load venom-custom-executor.schema.json");
      return "";
    }
  })();

  const watchersVenomrc = await startWatchingVenomrcFiles();
  context.subscriptions.push(...watchersVenomrc);

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
      const venomLibDirName = venomrc?.lib_dir ?? "lib";
      const venomLibDirPath = join(workspace!.uri.fsPath, venomLibDirName);
      log.debug(`Computed Venom lib directory: ${venomLibDirPath}`);

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
      return customExecutorSchema;
    }
  );
  if (!registered) {
    log.warn("Failed to register custom executor schema to YAML extension");
  }
};
