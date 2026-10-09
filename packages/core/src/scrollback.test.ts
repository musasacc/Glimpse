import { describe, expect, it } from "vitest";
import { Scrollback, trimOutput } from "./scrollback.js";

describe("Scrollback", () => {
  it("keeps the last `limit` characters", () => {
    const s = new Scrollback(10);
    expect(s.text()).toBe("");
    s.push("abc");
    s.push("");
    expect(s.text()).toBe("abc");
    for (const c of "defghijklmnop") s.push(c);
    expect(s.text()).toBe("ghijklmnop");
    s.push("0123456789XYZ");
    expect(s.text()).toBe("3456789XYZ");
    s.push("!");
    expect(s.text()).toBe("456789XYZ!");
    s.clear();
    expect(s.text()).toBe("");
  });

  it("matches concat-and-slice for any chunking", () => {
    const s = new Scrollback(37);
    let ref = "";
    for (let i = 0; i < 500; i++) {
      const chunk = String(i).repeat((i * 7) % 13);
      s.push(chunk);
      ref = (ref + chunk).slice(-37);
      if (i % 17 === 0) expect(s.text()).toBe(ref);
    }
    expect(s.text()).toBe(ref);
  });

  it("cuts at a safe boundary once over the limit", () => {
    const s = new Scrollback(12);
    s.push("first line\n");
    s.push("ab\x1b[1mcd\nnext");
    expect(s.text()).toBe("next");
    expect(s.text()).toBe(trimOutput("first line\nab\x1b[1mcd\nnext", 12));
    const e = new Scrollback(6);
    e.push("xyzab");
    e.push("\x1b[1mcd");
    expect(e.text()).toBe("\x1b[1mcd");
  });
});
