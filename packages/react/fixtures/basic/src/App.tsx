import { useState } from "react";

function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="app">
      <h1>Donut Shop</h1>
      <nav className="buttons">
        <button className="btn">Glazed</button>
        <button className="btn">Chocolate</button>
        <button className="btn" onClick={() => setCount((c) => c + 1)}>
          Clicked {count}
        </button>
      </nav>
      <Badge label="new" />
    </main>
  );
}
