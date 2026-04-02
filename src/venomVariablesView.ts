import * as vscode from "vscode";
import * as path from "path";
import {
  isVenomTestDocument,
  parseVariablesFromDocument,
  VenomVariableContext,
} from "./venomVariables";

const VIEW_ID = "venomVariables";

type TreeKind = "suite" | "tc" | "suiteVars" | "globalVars" | "step" | "var";

interface VenomVarTreeItem {
  label: string;
  kind: TreeKind;
  children?: VenomVarTreeItem[];
  description?: string;
  tooltip?: string;
}

export function registerVenomVariablesView(): vscode.Disposable[] {
  const provider = new VenomVariablesTreeProvider();
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const disposables: vscode.Disposable[] = [view];

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh())
  );
  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isVenomTestDocument(e.document)) {
        provider.refresh();
      }
    })
  );

  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (isVenomTestDocument(e.textEditor.document)) {
        provider.refresh();
      }
    })
  );

  provider.refresh();

  return disposables;
}

class VenomVariablesTreeProvider
  implements vscode.TreeDataProvider<VenomVarNode>
{
  private _onDidChange = new vscode.EventEmitter<VenomVarNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: VenomVarNode): vscode.TreeItem {
    return element.item;
  }

  getChildren(element?: VenomVarNode): VenomVarNode[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isVenomTestDocument(editor.document)) {
      return [
        new VenomVarNode(
          {
            label: "Open a *.venom.yml file",
            kind: "suite",
          },
          vscode.TreeItemCollapsibleState.None
        ),
      ];
    }

    const ctx = parseVariablesFromDocument(editor.document);
    const structure = buildStructure(ctx, editor.document.fileName);

    if (!element) {
      return structure.map(
        (s) => new VenomVarNode(s, vscode.TreeItemCollapsibleState.Expanded)
      );
    }

    const data = element.data;
    if (!data.children?.length) {
      return [];
    }
    return data.children.map(
      (c) =>
        new VenomVarNode(
          c,
          c.children?.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        )
    );
  }
}

function buildStructure(
  ctx: VenomVariableContext,
  filePath: string
): VenomVarTreeItem[] {
  const base: VenomVarTreeItem[] = [];

  if (ctx.parseError) {
    base.push({
      label: "Parse error",
      kind: "suite",
      description: ctx.parseError.slice(0, 60),
    });
    return base;
  }

  // Global vars section
  if (ctx.globalVars.length > 0) {
    const deduped = new Map<string, typeof ctx.globalVars[0]>();
    for (const g of ctx.globalVars) {
      deduped.set(g.key, g);
    }
    const globalChildren: VenomVarTreeItem[] = [...deduped.values()].map(
      (g) => {
        const sourceLabel =
          g.source === "venomrc"
            ? ".venomrc"
            : g.source === "var-file"
            ? g.sourceFile ?? "var-file"
            : g.source === "cli-arg"
            ? `CLI${g.sourceFile ? ` (${g.sourceFile})` : ""}`
            : "env";
        return {
          label: g.key,
          kind: "var" as TreeKind,
          description: `{{.${g.key}}}`,
          tooltip: `${sourceLabel}: ${g.value}`,
        };
      }
    );

    base.push({
      label: "Global variables",
      kind: "globalVars",
      description: `${deduped.size} keys`,
      children: globalChildren,
    });
  }

  // Suite vars section
  base.push({
    label: `Suite variables (${path.basename(filePath)})`,
    kind: "suiteVars",
    description:
      ctx.suiteVars.length === 0 ? "(none)" : `${ctx.suiteVars.length} keys`,
    children: ctx.suiteVars.map((k) => {
      const v = ctx.suiteVarDetails[k];
      const tip =
        v !== undefined && typeof v !== "object"
          ? String(v)
          : "Suite-level `vars`";
      return {
        label: k,
        kind: "var" as TreeKind,
        description: `{{.${k}}}`,
        tooltip: tip,
      };
    }),
  });

  for (const tc of ctx.testcases) {
    const tcLabel =
      tc.name?.length && tc.name.length > 0
        ? `Test case: ${tc.name}`
        : `Test case #${tc.index + 1}`;

    const stepNodes: VenomVarTreeItem[] = tc.steps.map((st) => ({
      label: `Step ${st.index + 1}: ${st.identifier}`,
      kind: "step",
      description:
        st.varNames.length === 0 ? "(no vars)" : `${st.varNames.length} vars`,
      children: st.varNames.map((vn) => {
        const d = st.varDetails[vn];
        const detailParts: string[] = [];
        if (d?.from) detailParts.push(`from ${d.from}`);
        if (d?.regex) detailParts.push("regex");
        return {
          label: vn,
          kind: "var",
          description: `\`{{.${vn}}}\``,
          tooltip: detailParts.length ? detailParts.join(", ") : undefined,
        };
      }),
    }));

    base.push({
      label: tcLabel,
      kind: "tc",
      children: stepNodes,
    });
  }

  return base;
}

class VenomVarNode {
  readonly item: vscode.TreeItem;
  readonly data: VenomVarTreeItem;

  constructor(
    data: VenomVarTreeItem,
    collapsible: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.None
  ) {
    this.data = data;
    this.item = new vscode.TreeItem(data.label, collapsible);
    this.item.description = data.description;
    this.item.tooltip = data.tooltip;
    this.item.contextValue = data.kind;

    if (data.kind === "var" && data.label) {
      this.item.iconPath = new vscode.ThemeIcon("symbol-variable");
    } else if (data.kind === "step") {
      this.item.iconPath = new vscode.ThemeIcon("list-ordered");
    } else if (data.kind === "tc") {
      this.item.iconPath = new vscode.ThemeIcon("beaker");
    } else if (data.kind === "globalVars") {
      this.item.iconPath = new vscode.ThemeIcon("globe");
    } else if (data.kind === "suiteVars") {
      this.item.iconPath = new vscode.ThemeIcon("symbol-namespace");
    } else {
      this.item.iconPath = new vscode.ThemeIcon("file");
    }
  }
}
