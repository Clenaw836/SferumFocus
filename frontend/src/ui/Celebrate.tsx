/**
 * Награда за действие: вспышка частиц из точки действия и «+N» летит в счётчик очков HUD.
 * Web Animations API (compositor: transform/opacity) — без перерисовок, дёшево для мобильного GPU.
 * prefers-reduced-motion: частиц нет, «+N» просто появляется и гаснет на месте.
 */
const COLORS = ["#34D399", "#F0B448", "#4CB870", "#38A8CC", "#8470C8", "#FF9A7A"];   // палитра референса

export function celebrate(points: number, origin?: { x: number; y: number }, big = false) {
  if (typeof document === "undefined") return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const o = origin ?? { x: innerWidth / 2, y: innerHeight * 0.62 };
  const layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  const anims: Animation[] = [];

  if (!reduce) {
    const n = big ? 36 : 16;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "fx-p";
      p.style.background = COLORS[i % COLORS.length];
      p.style.left = `${o.x}px`; p.style.top = `${o.y}px`;
      if (i % 3 === 0) p.style.borderRadius = "2px";
      layer.appendChild(p);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const dist = (big ? 120 : 70) + Math.random() * (big ? 110 : 50);
      anims.push(p.animate([
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist + 40}px)) scale(.4) rotate(${Math.random() * 360}deg)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 400, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" }));
    }
  }
  if (points > 0) {
    const chip = document.createElement("b");
    chip.className = "fx-plus num";
    chip.textContent = `+${points}`;
    chip.style.left = `${o.x}px`; chip.style.top = `${o.y}px`;
    layer.appendChild(chip);
    const t = document.getElementById("hud-points")?.getBoundingClientRect();
    const dx = t ? t.left + t.width / 2 - o.x : 0, dy = t ? t.top + t.height / 2 - o.y : -60;
    anims.push(chip.animate(reduce
      ? [{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .8 }, { opacity: 0 }]
      : [
        { transform: "translate(-50%,-50%) scale(.6)", opacity: 0 },
        { transform: "translate(-50%,-90%) scale(1.15)", opacity: 1, offset: .25 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.5)`, opacity: .2 },
      ], { duration: reduce ? 1200 : 1000, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }));
  }
  Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => {
    layer.remove();
    const hud = document.getElementById("hud-points");
    if (hud && !reduce) hud.animate([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 320, easing: "cubic-bezier(.34,1.56,.64,1)" });
  });
  setTimeout(() => layer.remove(), 2500);
}
