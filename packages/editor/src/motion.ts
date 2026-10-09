/** Small motion helpers; the animations themselves are CSS (styles.css, "Motion"). */

/** The person asked for less motion (or the browser can't tell): exits happen at once. */
export function reducedMotion(): boolean {
  return typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Play an exit animation (a CSS class whose animation runs to its end), then `done`. Runs `done` at once when motion
 * is reduced or the element is gone, and at the latest after `ms` (an animation that never runs, e.g. display: none).
 */
export function animateOut(el: HTMLElement | null, className: string, ms: number, done: () => void): void {
  if (!el || reducedMotion()) return done();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    el.removeEventListener("animationend", onEnd);
    done();
  };
  const onEnd = (e: AnimationEvent) => e.target === el && finish();
  const timer = setTimeout(finish, ms + 50);
  el.addEventListener("animationend", onEnd);
  el.classList.add(className);
}
