import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("生产镜像可从真实来源样本建立不覆盖旧数据的 FDE 验收数据库", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "fde-dossier-bootstrap-"));
  const output = resolve(directory, "fde-dossier.sqlite");
  try {
    const raw = execFileSync(resolve("node_modules/.bin/tsx"), ["scripts/bootstrap-dossier.ts", output], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const result = JSON.parse(raw.trim());
    assert.equal(result.ok, true);
    assert.equal(result.rows.company, 1);
    assert.equal(result.rows.industry, 1);
    assert.ok(result.rows.sources >= 8);
    assert.ok(result.rows.opportunities >= 4);
    assert.equal(result.rows.dossierRuns, 1);

    const db = new Database(output, { readonly: true, fileMustExist: true });
    assert.equal((db.prepare("SELECT name FROM company WHERE id='002410.SZ'").get() as { name: string }).name, "广联达科技股份有限公司");
    assert.equal((db.prepare("SELECT count(*) AS count FROM industry_update").get() as { count: number }).count, 0);
    db.close();

    const before = readFileSync(output);
    const repeated = spawnSync(resolve("node_modules/.bin/tsx"), ["scripts/bootstrap-dossier.ts", output], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /不会覆盖/);
    assert.deepEqual(readFileSync(output), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
