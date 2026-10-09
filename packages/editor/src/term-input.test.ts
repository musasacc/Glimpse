import { describe, expect, it } from "vitest";
import { chunkInput } from "./term-input";

describe("terminal input", () => {
  it("sends a long paste in pieces, never splitting a surrogate pair", () => {
    expect(chunkInput("abc")).toEqual(["abc"]);
    const big = "x".repeat(40_000);
    const pieces = chunkInput(big);
    expect(pieces.map((p) => p.length)).toEqual([16384, 16384, 7232]);
    expect(pieces.join("")).toBe(big);
    const emoji = "a" + "\u{1F600}".repeat(10);
    const small = chunkInput(emoji, 4);
    expect(small.join("")).toBe(emoji);
    for (const p of small) expect(/[\ud800-\udbff]$/.test(p)).toBe(false);
  });
});
