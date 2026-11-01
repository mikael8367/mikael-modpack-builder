"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { safeEqual } = require("../server");

test("safeEqual aceita tokens iguais", () => {
  assert.equal(safeEqual("token-seguro", "token-seguro"), true);
});

test("safeEqual rejeita tokens diferentes", () => {
  assert.equal(safeEqual("token-seguro", "outro-token"), false);
});

test("safeEqual rejeita comprimentos diferentes", () => {
  assert.equal(safeEqual("abc", "abcd"), false);
});
