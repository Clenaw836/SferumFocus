/**
 * Master v2.0 · Feature 4 — фон приложения из «Персонализации» вместо стандартного неба.
 * Затемнение — не ниже порога читаемости (lib/personal.veilFor); в «Повышенной различимости» не рисуется.
 */
import type { ComponentChildren } from "preact";
import { bgImage, usePersonal, veilFor, visibleBackdrop } from "../lib/personal";
import { useAppearance } from "../lib/theme";

export function UserBackground({ fallback }: { fallback: ComponentChildren }) {
  const p = usePersonal(); useAppearance();
  const b = visibleBackdrop(p);
  if (b === "none") return <>{fallback}</>;
  const img = b === "photo" ? bgImage("app") : null;
  return <div class="sky user-bg" data-backdrop={b} aria-hidden="true">
    {img && <div class="user-bg-img l-fill" style={{ backgroundImage: `url("${img.url}")` }} />}
    <div class="user-bg-veil b-box b-nob l-fill" style={{ opacity: String(veilFor(p)) }} />
  </div>;
}
