import assert from "node:assert";
import { test } from "node:test";
import { isEmailValid, generateToken } from "./auth.ts";

test("isEmailValid accepts a normal address", () => {
  assert.equal(isEmailValid("user@example.com"), true);
});

test("isEmailValid rejects missing @", () => {
  assert.equal(isEmailValid("userexample.com"), false);
});

test("isEmailValid rejects multiple @", () => {
  assert.equal(isEmailValid("a@b@c.com"), false);
});

test("generateToken honors requested length", () => {
  assert.equal(generateToken(8).length, 8);
  assert.equal(generateToken(24).length, 24);
});
