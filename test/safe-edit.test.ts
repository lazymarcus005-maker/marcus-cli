import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { replaceFileSafely, StaleEditError } from "../src/retrieval/safe-edit.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("freshness-safe file replacement", () => {
  it("atomically replaces only the version the caller observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-edit-"));
    roots.push(root);
    const path = join(root, "source.ts");
    const original = "before\n";
    await writeFile(path, original, { mode: 0o640 });
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const result = await replaceFileSafely({ root, path: "source.ts", expectedSha256, content: "after\n" });
    assert.equal(await readFile(path, "utf8"), "after\n");
    assert.equal(result.path, "source.ts");
  });

  it("refuses stale versions and protected internal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-edit-stale-"));
    roots.push(root);
    const sourcePath = join(root, "source.ts");
    const externalEdit = "external user edit\n";
    await writeFile(sourcePath, externalEdit);
    await assert.rejects(
      replaceFileSafely({ root, path: "source.ts", expectedSha256: "0".repeat(64), content: "overwrite" }),
      (error) => error instanceof StaleEditError,
    );
    assert.equal(await readFile(sourcePath, "utf8"), externalEdit);
    await assert.rejects(
      replaceFileSafely({ root, path: ".macus/state.db", expectedSha256: "0".repeat(64), content: "bad" }),
      /outside the authorized source area/,
    );
  });
});
