import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DIGIT_TEST_SVG, digitTestImage } from "../server/providers/test-image.mjs";

// A server without fonts (a bare Raspberry Pi) renders SVG <text> as nothing, so
// vision models were shown a blank picture and every image check failed.
test("the image capability check draws its digits without fonts", async () => {
  assert.doesNotMatch(DIGIT_TEST_SVG, /<text/);
  const { data } = await sharp(await digitTestImage()).greyscale().raw().toBuffer({ resolveWithObject: true });
  const dark = data.filter((value) => value < 128).length;
  assert.ok(dark > data.length * 0.1, `expected visible digits, got ${dark} dark pixels`);
});
