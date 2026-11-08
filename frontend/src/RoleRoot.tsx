import {render} from "preact";
import {onIdentityCleanup, identityChanged} from "./lib/identity";
import {roleContext} from "./lib/roleContext";
import {launchCredential as initData} from "./lib/platform";
import {bootOk} from "./lib/bootDiag";
import {applyPersonal} from "./lib/personal";
import {installViewportFit} from "./lib/viewport";

/** Вызывается main.tsx только после подтверждения личности сервером.
 *  v3.2 · PERF-01: рабочее место учителя (TeacherRoot.tsx) и приложение ученика (App.tsx) — разные чанки:
 *  каждая роль скачивает только свой экран. */
export async function mountRole(root: HTMLElement): Promise<void> {
  onIdentityCleanup(() => render(null, root));
  // Master v2.0 · Feature 4: шрифт, цветовой режим и фон аккаунта — до первого кадра (без мигания).
  applyPersonal();
  // v2.1: подгонка нижней вставки WebView (Android MAX) и класса ширины экрана — до первого кадра.
  installViewportFit();
  if (roleContext().role === "teacher") {
    const {mountTeacher} = await import("./TeacherRoot");
    if (!identityChanged(initData())) mountTeacher(root);
    return;
  }
  const {App} = await import("./App");
  if (!identityChanged(initData())) { render(<App />, root); bootOk(); }
}
