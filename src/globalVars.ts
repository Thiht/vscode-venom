import * as vscode from "vscode";
import { TextDecoder } from "util";
import { join } from "path";
import * as yaml from "js-yaml";

export type GlobalVarSource = "venomrc" | "var-file" | "cli-arg" | "env";

export interface GlobalVar {
  key: string;
  value: string;
  source: GlobalVarSource;
  /** For var-file: the originating filename */
  sourceFile?: string;
}

/**
 * Collect global variables that Venom would inject at runtime.
 * Sources (in Venom priority order, lowest first):
 *   1. VENOM_VAR env var (from extension venom.env config)
 *   2. .venomrc variables_files  (flat YAML dictionaries)
 *   3. .venomrc variables        ("key=value" strings)
 *   4. CLI --var / --var-from-file (from extension venom.additionalRunArguments / venom.args)
 *
 * Later sources override earlier ones for the same key (same as Venom).
 */
export async function collectGlobalVars(
  document: vscode.TextDocument
): Promise<GlobalVar[]> {
  const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspace) return [];

  const result: GlobalVar[] = [];
  const wsRoot = workspace.uri.fsPath;

  // ---------- .venomrc ----------
  const venomrc = await loadVenomrc(wsRoot);
  if (venomrc) {
    // variables_files first (lower priority than variables)
    if (Array.isArray(venomrc.variables_files)) {
      for (const relPath of venomrc.variables_files) {
        if (typeof relPath !== "string" || relPath.length === 0) continue;
        const absPath = join(wsRoot, relPath);
        const vars = await loadVarFile(absPath);
        for (const [k, v] of vars) {
          result.push({
            key: k,
            value: v,
            source: "var-file",
            sourceFile: relPath,
          });
        }
      }
    }

    // variables: ["key=value", ...]
    if (Array.isArray(venomrc.variables)) {
      for (const entry of venomrc.variables) {
        if (typeof entry !== "string") continue;
        const kv = parseKeyValue(entry);
        if (kv) {
          result.push({ key: kv[0], value: kv[1], source: "venomrc" });
        }
      }
    }
  }

  // ---------- CLI args ----------
  const config = vscode.workspace.getConfiguration("venom");
  const args: string[] = [
    ...(config.get<string[]>("additionalRunArguments") ?? []),
    ...(config.get<string[]>("args") ?? []),
  ];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // --var key=value  or  --var=key=value
    if (arg === "--var" && i + 1 < args.length) {
      const kv = parseKeyValue(args[i + 1]);
      if (kv) result.push({ key: kv[0], value: kv[1], source: "cli-arg" });
      i += 2;
      continue;
    }
    if (arg.startsWith("--var=")) {
      const kv = parseKeyValue(arg.slice("--var=".length));
      if (kv) result.push({ key: kv[0], value: kv[1], source: "cli-arg" });
      i += 1;
      continue;
    }

    // --var-from-file filename.yaml
    if (arg === "--var-from-file" && i + 1 < args.length) {
      const filePath = args[i + 1];
      const absPath = join(wsRoot, filePath);
      const vars = await loadVarFile(absPath);
      for (const [k, v] of vars) {
        result.push({
          key: k,
          value: v,
          source: "cli-arg",
          sourceFile: filePath,
        });
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--var-from-file=")) {
      const filePath = arg.slice("--var-from-file=".length);
      const absPath = join(wsRoot, filePath);
      const vars = await loadVarFile(absPath);
      for (const [k, v] of vars) {
        result.push({
          key: k,
          value: v,
          source: "cli-arg",
          sourceFile: filePath,
        });
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return result;
}

/**
 * De-duplicate by key (last wins, matching Venom precedence).
 */
export function deduplicateGlobalVars(vars: GlobalVar[]): GlobalVar[] {
  const map = new Map<string, GlobalVar>();
  for (const v of vars) {
    map.set(v.key, v);
  }
  return [...map.values()];
}

function parseKeyValue(s: string): [string, string] | undefined {
  const idx = s.indexOf("=");
  if (idx < 1) return undefined;
  return [s.slice(0, idx), s.slice(idx + 1)];
}

interface VenomrcData {
  variables?: string[];
  variables_files?: string[];
}

async function loadVenomrc(wsRoot: string): Promise<VenomrcData | undefined> {
  try {
    const uri = vscode.Uri.file(join(wsRoot, ".venomrc"));
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed = yaml.load(text, { filename: ".venomrc" });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as VenomrcData;
    }
  } catch {
    // .venomrc doesn't exist or isn't valid YAML — that's fine
  }
  return undefined;
}

async function loadVarFile(absPath: string): Promise<[string, string][]> {
  try {
    const uri = vscode.Uri.file(absPath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed = yaml.load(text, { filename: absPath });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries: [string, string][] = [];
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        entries.push([k, v === undefined ? "" : String(v)]);
      }
      return entries;
    }
  } catch {
    // file doesn't exist or isn't valid YAML — silently skip
  }
  return [];
}
