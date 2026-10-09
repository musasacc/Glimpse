import { describe, expect, it } from "vitest";
import { instrumentJsx } from "./instrument-jsx.js";

const strip = (code: string) => code.replace(/ data-glimpse-src="[^"]*"/g, "");

describe("instrumentJsx", () => {
  it("tags host elements with file:line:col of their '<', leaving the rest untouched", () => {
    const code = [
      'import { Button } from "./Button";',
      "export function App() {",
      "  return (",
      '    <main className="app">',
      "      <h1>Donut Shop</h1>",
      "      <Button>Order</Button>",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n");
    const out = instrumentJsx(code, "src/App.tsx")!;
    expect(out.code).toContain('<main data-glimpse-src="src/App.tsx:4:5" className="app">');
    expect(out.code).toContain('<h1 data-glimpse-src="src/App.tsx:5:7">Donut Shop</h1>');
    expect(out.code).toContain("<Button>Order</Button>");
    expect(strip(out.code)).toBe(code);
  });

  it("skips components, member expressions, namespaced names and fragments", () => {
    const code = `const a = (
  <>
    <Card />
    <motion.div animate={{ x: 1 }} />
    <svg:rect />
    <React.Fragment key="k"><span>hi</span></React.Fragment>
    <my-widget />
  </>
);
`;
    const out = instrumentJsx(code, "src/a.jsx")!;
    expect(out.code).toContain("<Card />");
    expect(out.code).toContain("<motion.div animate={{ x: 1 }} />");
    expect(out.code).toContain("<svg:rect />");
    expect(out.code).toContain('<React.Fragment key="k"><span data-glimpse-src="src/a.jsx:6:29">hi</span></React.Fragment>');
    expect(out.code).toContain('<my-widget data-glimpse-src="src/a.jsx:7:5" />');
    expect(out.code).toContain("  <>\n");
  });

  it("returns null when there is nothing to tag or the code doesn't parse", () => {
    expect(instrumentJsx("export const x = 1 < 2;", "a.js")).toBeNull();
    expect(instrumentJsx("export const x = 1;", "a.js")).toBeNull();
    expect(instrumentJsx("const C = () => <Card />;", "a.jsx")).toBeNull();
    expect(instrumentJsx("const x = <div>;", "a.jsx")).toBeNull();
  });

  it("handles TSX generics, type annotations and comments", () => {
    const code = `// <div> in a comment is not JSX
const id = <T,>(x: T): T => x;
function List<T extends { id: string }>(props: { items: T[] }) {
  /* <span> */
  return <ul>{props.items.map((i) => <li key={i.id}>{id<string>(i.id)}</li>)}</ul>;
}
export default List;
`;
    const out = instrumentJsx(code, "src/List.tsx")!;
    expect(out.code).toContain('<ul data-glimpse-src="src/List.tsx:5:10">');
    expect(out.code).toContain('<li data-glimpse-src="src/List.tsx:5:38" key={i.id}>');
    expect(out.code).toContain("// <div> in a comment is not JSX");
    expect(out.code).toContain("/* <span> */");
    expect(strip(out.code)).toBe(code);
  });

  it("reads JSX in plain .js files", () => {
    const out = instrumentJsx("export const App = () => <div>hi</div>;\n", "src/App.js");
    expect(out?.code).toBe('export const App = () => <div data-glimpse-src="src/App.js:1:26">hi</div>;\n');
  });

  it("is idempotent: elements that already carry the attribute are left alone", () => {
    const once = instrumentJsx("const a = <p>x</p>;\n", "a.jsx")!.code;
    expect(instrumentJsx(once, "a.jsx")).toBeNull();
    const mixed = instrumentJsx('const a = <div><p data-glimpse-src="x:1:1">a</p><b>b</b></div>;\n', "a.jsx")!.code;
    expect(mixed).toBe('const a = <div data-glimpse-src="a.jsx:1:11"><p data-glimpse-src="x:1:1">a</p><b data-glimpse-src="a.jsx:1:49">b</b></div>;\n');
  });

  it("counts lines the same way with Windows line endings", () => {
    const code = "const a = (\r\n  <div>\r\n    <p>x</p>\r\n  </div>\r\n);\r\n";
    const out = instrumentJsx(code, "a.jsx")!;
    expect(out.code).toBe(
      'const a = (\r\n  <div data-glimpse-src="a.jsx:2:3">\r\n    <p data-glimpse-src="a.jsx:3:5">x</p>\r\n  </div>\r\n);\r\n',
    );
  });

  it("uses forward slashes and escapes the path for a JSX attribute", () => {
    const out = instrumentJsx("const a = <i />;", "src\\a&b.jsx")!;
    expect(out.code).toBe('const a = <i data-glimpse-src="src/a&amp;b.jsx:1:11" />;');
  });

  it("returns a source map for the edit", () => {
    const out = instrumentJsx("const a = <i />;", "a.jsx", { source: "/abs/a.jsx" })!;
    expect(out.map.sources).toEqual(["/abs/a.jsx"]);
    expect(out.map.mappings).not.toBe("");
  });
});
