import { promisify } from "util";
import { execFile } from "child_process";
import { tmpdir } from "os";
import { resolve } from "path";
import { readFile } from "fs";
import { randomBytes } from "crypto";

const execFilePromise = promisify(execFile);
const readFilePromise = promisify(readFile);
const randomBytesPromise = promisify(randomBytes);

export interface TestSuite {
  name?: string;
  testcases: TestCase[];
}

export interface TestCase {
  name?: string;
}

interface TestResults {
  test_suites: {
    name: string;
    package: string;
    testcases: {
      name: string;
      classname: string;
      failures: {
        value: string;
      }[];
    }[];
  }[];
}

export const getVersion = async () => {
  const { stdout, stderr } = await execFilePromise("/Users/thiht/workspace/go/bin/venom", ["version"]);
  console.log(stdout, stderr);
};

export const run = async (filepath: string) => {
  const token = await randomBytesPromise(10).toString();
  const venomTmpDir = resolve(tmpdir(), `venom-${token}`);
  const { stdout, stderr } = await execFilePromise("/Users/thiht/workspace/go/bin/venom", [
    "run",
    "--format=json",
    `--output-dir=${venomTmpDir}`,
    filepath,
  ]);

  const rawTestResults = await readFilePromise(resolve("venomTmpDir", "test_results.json"));
  const testResults = JSON.parse(rawTestResults.toString()) as TestResults;

  console.log(stdout, stderr);
};
