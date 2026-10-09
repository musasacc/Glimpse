import { describe, expect, it } from "vitest";
import { Scrollback } from "./scrollback.js";

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
});
