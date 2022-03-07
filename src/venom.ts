import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { readFile, rmSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import stripAnsi from "./stripAnsi";
import * as which from "which";

const execPromise = promisify(exec);
const readFilePromise = promisify(readFile);
const randomBytesPromise = promisify(randomBytes);

// Types representing a Venom test suite

export interface TestSuite {
  name?: string;
  testcases: TestCase[];
}

export interface TestCase {
  name?: string;
}

// Types of the test_results.json file generated by Venom

interface TestResult {
  test_suites: TestResultTestSuite[];
}

interface TestResultTestSuite {
  name: string;
  package: string;
  errors: number;
  failures: number;
  testcases: TestResultTestCase[];
}

interface TestResultTestCase {
  name: string;
  classname: string;
  failures: TestResultFailure[];
}

interface TestResultFailure {
  value: string;
}

// FIXME: this should use the official ExecException but it currently lacks stdout and stderr
// See: https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/58854
interface ExecException {
  code: number;
  stdout: string;
  stderr: string;
}

const findVenom = async () => {
  const venomBinary = vscode.workspace
    .getConfiguration("venom")
    .get<string>("binaryLocation", "venom");

  try {
    await which(venomBinary);
  } catch (e) {
    const choice = await vscode.window.showErrorMessage(
      "Venom binary not found. Install it in your PATH or configure its location manually.",
      "Install Venom",
      "Set Venom binary location"
    );

    switch (choice) {
      case "Install Venom":
        vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/ovh/venom#installing")
        );
        break;
      case "Set Venom binary location":
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "venom.binaryLocation"
        );
        break;
    }

    return null;
  }

  return venomBinary;
};

const checkVenomVersion = async () => {
  const versionResult = await version();
  if (!versionResult || versionResult.stdout.includes("v0")) {
    if (versionResult?.venomBinary) {
      const version = versionResult.stdout.split(": ")[1];
      vscode.window.showErrorMessage("Expected Venom binary version ≥ 1.0.0", {
        modal: true,
        detail: `${versionResult.venomBinary} has version ${version}`,
      });
    }
    return false;
  }
  return true;
};

export const version = async () => {
  const venomBinary = await findVenom();
  if (!venomBinary) {
    return null;
  }

  let stdout, stderr: string;
  try {
    ({ stdout, stderr } = await execPromise(`${venomBinary} version`));
  } catch (e) {
    ({ stdout, stderr } = e as ExecException);
  }

  return { stdout, stderr, venomBinary };
};

export const run = async (filepath: string) => {
  const venomBinary = await findVenom();
  if (!venomBinary) {
    return null;
  }

  if (!checkVenomVersion()) {
    return null;
  }

  const token = await randomBytesPromise(10);
  const venomTmpDir = resolve(tmpdir(), `venom-${token.toString("hex")}`);

  let stdout, stderr: string;
  try {
    const additionalArgs = vscode.workspace
      .getConfiguration("venom")
      .get<string[]>("additionalRunArguments", []);

    const args = [
      "--format=json",
      `--output-dir=${venomTmpDir}`,
      ...additionalArgs,
    ];

    ({ stdout, stderr } = await execPromise(
      `IS_TTY=true ${venomBinary} run ${args.join(" ")} ${filepath}`
    ));
  } catch (e) {
    ({ stdout, stderr } = e as ExecException);
  }

  const rawTestResults = await readFilePromise(
    resolve(venomTmpDir, "test_results.json")
  );
  rmSync(venomTmpDir, { recursive: true, force: true });
  const testResults = JSON.parse(rawTestResults.toString()) as TestResult;

  const failures = testResults.test_suites
    .filter(
      (testSuite) =>
        filepath.endsWith(testSuite.package) && testSuite.failures > 0
    )
    .flatMap((failedTestSuite) =>
      failedTestSuite.testcases.filter((testCase) => testCase.failures !== null)
    )
    .flatMap((testCase) => testCase.failures)
    .map((failure) => failure.value);

  // TODO: handle test suite errors (not the same as failures)

  return {
    stdout,
    stderr,
    failures,
  };
};

export const parseFailureMessage = (message: string) => {
  message = stripAnsi(message).trim();

  const re1 =
    /expected:\s+(?<expected>.*?)\s+got:\s+(?<actual>.*?)\s+\(.*:(?<line>\d+)\)$/;
  const match1 = re1.exec(message);
  if (match1?.groups) {
    return {
      raw: message,
      expected: match1.groups.expected,
      actual: match1.groups.actual,
      line: parseInt(match1.groups.line),
    };
  }

  const re2 = /\s+\(.*:(?<line>\d+)\)$/;
  const match2 = re2.exec(message);
  if (match2?.groups) {
    return {
      raw: message,
      line: parseInt(match2.groups.line),
    };
  }

  return {
    raw: message,
  };
};
