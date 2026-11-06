import test from "node:test";
import assert from "node:assert/strict";
import { AI_SETTINGS_ACTION, failureText, isErrorCode, parseFailure } from "../shared/error-codes.mjs";

test("错误代码只使用 Crockford Base32 的 6 个大写字符", () => {
  assert.equal(isErrorCode("7K2QD9"), true);
  for (const value of ["7K2QD", "7K2QD9X", "7K2QDI", "7K2QDO", "7k2qd9", "", null, undefined])
    assert.equal(isErrorCode(value), false, String(value));
});

test("失败文案可以往返解析", () => {
  assert.equal(failureText("7K2QD9"), "出错了，请重试 · 错误代码 7K2QD9");
  assert.deepEqual(parseFailure("出错了，请重试 · 错误代码 7K2QD9"), { code: "7K2QD9", action: null });
  assert.equal(failureText("7K2QD9", AI_SETTINGS_ACTION), "AI 暂时不可用 · 错误代码 7K2QD9");
  assert.deepEqual(parseFailure("AI 暂时不可用 · 错误代码 7K2QD9"), { code: "7K2QD9", action: AI_SETTINGS_ACTION });
  assert.equal(parseFailure("API key 无效"), null);
  assert.equal(parseFailure(undefined), null);
});
