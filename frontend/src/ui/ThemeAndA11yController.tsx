import { useState } from "preact/hooks";
import { setTheme, theme, type Theme } from "../lib/theme";
import { Segmented } from "./Segmented";

export type ThemeMode = "light" | "dark";
export type ColorblindProfile = "none" | "okabe-ito" | "monochrome";

const THEME_STORAGE_KEY = "sf.ui.theme";
const COLORBLIND_STORAGE_KEY = "sf_colorblind_profile_v3";

function readProfile(): ColorblindProfile {
  try {
    const value = localStorage.getItem(COLORBLIND_STORAGE_KEY);
    return value === "okabe-ito" || value === "monochrome" ? value : "none";
  } catch {
    return "none";
  }
}

export function applyThemeToDom(themeMode: ThemeMode, profile: ColorblindProfile, doc?: Document): void {
  const target = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!target) return;
  const root = target.documentElement;
  root.setAttribute("data-theme", themeMode);
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(themeMode === "dark" ? "theme-dark" : "theme-light");
  root.style.colorScheme = themeMode;
  if (profile === "none") {
    root.removeAttribute("data-colorblind");
    root.classList.remove("colorblind-mode");
  } else {
    root.setAttribute("data-colorblind", profile);
    root.classList.add("colorblind-mode");
  }
}

/** Call before mounting the app. Light is the default; a saved explicit dark choice is retained. */
export function initDefaultLightThemeAndA11y(doc?: Document): { theme: ThemeMode; colorblind: ColorblindProfile } {
  let savedTheme: ThemeMode = "light";
  let profile: ColorblindProfile = "none";
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "dark" || storedTheme === "light") savedTheme = storedTheme;
    else localStorage.setItem(THEME_STORAGE_KEY, "light");
    profile = readProfile();
  } catch {
    // Private WebViews may disable storage; the in-memory default still works.
  }
  applyThemeToDom(savedTheme, profile, doc);
  return { theme: savedTheme, colorblind: profile };
}

export function ColorblindProfileSettings() {
  const [profile, setProfile] = useState<ColorblindProfile>(readProfile);
  const choose = (next: ColorblindProfile) => {
    setProfile(next);
    try { localStorage.setItem(COLORBLIND_STORAGE_KEY, next); } catch { /* Private WebView */ }
    applyThemeToDom(theme(), next);
  };
  return <div class="l-v l-g2" role="group" aria-label="Профиль цветовосприятия">
    <span class="field-label">Цветовой профиль</span>
    <div class="l-h l-wrap l-g2">
      <button type="button" class={`btn btn-sm${profile === "none" ? " btn-primary" : " btn-secondary"}`} aria-pressed={profile === "none"} onClick={() => choose("none")}>Стандартный</button>
      <button type="button" class={`btn btn-sm${profile === "okabe-ito" ? " btn-primary" : " btn-secondary"}`} aria-pressed={profile === "okabe-ito"} onClick={() => choose("okabe-ito")}>Дальтонизм Okabe-Ito (● 5 ◆ 4 ▲ 3 ■ 2)</button>
      <button type="button" class={`btn btn-sm${profile === "monochrome" ? " btn-primary" : " btn-secondary"}`} aria-pressed={profile === "monochrome"} onClick={() => choose("monochrome")}>Монохром</button>
    </div>
  </div>;
}

/** Theme and color-profile controls used by the profile's appearance settings. */
export function ThemeAndA11yController() {
  return <div class="l-v l-g3">
    <Segmented<Theme> label="Тема" value={theme()} onChange={setTheme} options={[{ value: "light", label: "Светлая", icon: "sun" }, { value: "dark", label: "Тёмная", icon: "moon" }]} />
    <ColorblindProfileSettings />
  </div>;
}
