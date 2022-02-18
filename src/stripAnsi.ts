// FIXME: This is an inlined version of the strip-ansi package, because it uses ESM modules which is currently not compatible with VSCode
// See: https://github.com/microsoft/vscode/issues/130367

function ansiRegex() {
  const pattern = [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|");

  return new RegExp(pattern, "g");
}

export default function stripAnsi(str: string) {
  return str.replace(ansiRegex(), "");
}
