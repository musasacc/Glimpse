import { useState } from "react";

export function App() {
  const [order, setOrder] = useState<string[]>([]);
  const add = (flavor: string) => setOrder((o) => [...o, flavor]);

  return (
    <>
      <header className="top">
        <h1>Donut Shop</h1>
        <p className="tagline">Five buttons and a donut that won't sit still.</p>
      </header>

      <div className="stage">
        <div className="donut" aria-label="A moving donut"></div>
      </div>

      <nav className="buttons">
        <button className="btn" onClick={() => add("Glazed")}>Glazed</button>
        <button className="btn" onClick={() => add("Chocolate")}>Chocolate</button>
        <button className="btn" onClick={() => add("Sprinkles")}>Sprinkles</button>
        <button className="btn" onClick={() => add("Maple")}>Maple</button>
        <button className="btn primary" onClick={() => setOrder([])}>Order now</button>
      </nav>

      <p className="order">{order.length ? `In your box: ${order.join(", ")}` : "Your box is empty."}</p>
    </>
  );
}
