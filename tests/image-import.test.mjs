import test from "node:test";
import assert from "node:assert/strict";
import { imageImportFiles } from "../client/image-import.mjs";

// Batch execution and recovery are covered by image-tasks.test.mjs.
const file = (name) => ({ name, type: "image/png", size: 10 });

test("文件选择在加入队列前检查每张格式、大小和文章图片上限", () => {
  assert.equal(imageImportFiles([file("a.png"), file("b.png")], 98).length, 2);
  assert.throws(() => imageImportFiles([file("a.png"), file("b.png")], 99), /100 张/);
  assert.throws(() => imageImportFiles([file("a.png"), { ...file("bad.gif"), type: "image/gif" }]), /bad.gif.*PNG、JPEG 或 WebP/);
  assert.throws(() => imageImportFiles([{ ...file("large.png"), size: 12 * 1024 * 1024 + 1 }]), /大小不超过 12 MB/);
});
