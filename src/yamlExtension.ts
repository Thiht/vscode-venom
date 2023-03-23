import * as vscode from "vscode";

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

export const activateYAMLExtension = async () => {
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
