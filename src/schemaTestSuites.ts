import * as vscode from "vscode";
import { TextDecoder } from "util";
import { activateYAMLExtension } from "./yamlExtension";
import { log } from "./log";
import { customExecutorsByWorkspace } from "./schemaCustomExecutors";
import * as querystring from "querystring";

// Unique key to identify the YAML extension schema requests destined to this extension
export const TEST_SUITE_SCHEMA = "VSCODE_VENOM_TEST_SUITE_SCHEMA";

export const loadSchemaTestSuites = async (
  context: vscode.ExtensionContext
) => {
  log.debug("Activating YAML extension");
  const yamlExtension = await activateYAMLExtension();
  if (!yamlExtension) {
    log.warn("Failed to activate YAML extension, test suites won't be parsed");
    return;
  }

  log.info("Loading venom.schema.json");
  const testSuiteSchema: string = await (async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.parse(context.asAbsolutePath("schema/venom.schema.json"))
      );
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      log.warn("Failed to load venom.schema.json", e);
      return "";
    }
  })();

  log.info("Registering test suite schema to YAML extension");
  const registered = yamlExtension.registerContributor(
    TEST_SUITE_SCHEMA,

    // Return the venom test suite schema URI when the resource is a YAML file inside the configured Venom lib dir
    (resource: string) => {
      const resourceURI = vscode.Uri.parse(resource);
      log.debug(
        `Schema request for ${resourceURI.fsPath} from the YAML extension`
      );
      const workspace = vscode.workspace.getWorkspaceFolder(resourceURI);

      // TODO: allow configuration
      if (resourceURI.fsPath.endsWith(".venom.yml")) {
        return `${TEST_SUITE_SCHEMA}://schema/venom.schema.json?workspace=${encodeURIComponent(
          workspace!.uri.fsPath
        )}`;
      }
      return "";
    },

    // Return the venom test suite schema for the TEST_SUITE_SCHEMA URI
    (uri: string) => {
      const schemaURI = vscode.Uri.parse(uri);
      const queryParams = querystring.parse(schemaURI.query);
      const workspace = Array.isArray(queryParams.workspace)
        ? queryParams.workspace?.[0]
        : queryParams.workspace;

      if (schemaURI.scheme !== TEST_SUITE_SCHEMA) {
        return "";
      }
      log.debug(
        `Schema content request for ${schemaURI.fsPath} from the YAML extension`
      );

      if (!workspace || !customExecutorsByWorkspace.has(workspace)) {
        return testSuiteSchema;
      }

      const parsedSchema = JSON.parse(testSuiteSchema);

      const customExecutors = customExecutorsByWorkspace.get(workspace)!;
      customExecutors.forEach((customExecutor) => {
        log.debug("Registering custom executor", customExecutor);

        parsedSchema.definitions.step.oneOf.push({
          $ref: `#/definitions/custom_executor_${customExecutor.executor}`,
        });

        const customExecutorProperties: Record<string, unknown> = {};
        for (const key of Object.keys(customExecutor.input)) {
          customExecutorProperties[key] = { type: "string" };
        }

        parsedSchema.definitions[`custom_executor_${customExecutor.executor}`] =
          {
            type: "object",
            allOf: [{ $ref: "#/definitions/step_base" }],
            additionalProperties: false,
            properties: {
              info: true,
              assertions: true,
              skip: true,
              vars: true,
              retry: true,
              retry_if: true,
              delay: true,
              timeout: true,
              range: true,
              type: {
                type: "string",
                const: customExecutor.executor,
              },
              ...customExecutorProperties,
            },
          };
      });

      const customTestSuiteSchema = JSON.stringify(parsedSchema);
      return customTestSuiteSchema;
    }
  );

  if (!registered) {
    log.warn("Failed to register test suite schema to YAML extension");
  }
};
