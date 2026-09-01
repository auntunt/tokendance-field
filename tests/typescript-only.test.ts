import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sourceDirectories = ["app", "audit", "lib", "scripts", "tests"];
const javascriptExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"]);

function findJavaScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(path);
    return javascriptExtensions.has(extname(entry.name)) ? [path.slice(root.length + 1)] : [];
  });
}

test("一方源码、测试和工具只使用 TypeScript", () => {
  const nestedFiles = sourceDirectories.flatMap((directory) =>
    findJavaScriptFiles(resolve(root, directory)),
  );
  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && javascriptExtensions.has(extname(entry.name)))
    .map((entry) => entry.name);

  assert.deepEqual([...rootFiles, ...nestedFiles].sort(), []);
});
