/** v3.0 · диспетчер лабораторий: модель из конфигурации этапа → компонент. Неизвестная модель — честная заглушка. */
import type { LabConfig, LabState } from "../../lib/practicumTypes";
import { AreaLab, LinearLab, OhmLab, QuadraticLab, ScalesLab } from "./labsMath";
import { ClassifyLab, ClimateLab, MoleculeLab, OrderLab, RobotLab } from "./labsWorld";
import type { LabProps } from "./labKit";

const LABS: Record<string, (p: LabProps) => preact.JSX.Element> = {
  quadratic: QuadraticLab, linear: LinearLab, scales: ScalesLab, area: AreaLab, ohm: OhmLab,
  molecule: MoleculeLab, climate: ClimateLab, order: OrderLab, classify: ClassifyLab, robot: RobotLab,
};

export function Lab({ cfg, state, readouts, onChange, readonly, idp }: {
  cfg: LabConfig; state: LabState; readouts: Record<string, unknown>; onChange?: (s: LabState) => void; readonly?: boolean; idp: string;
}) {
  const View = LABS[cfg.model];
  if (!View) return <p class="pl-note f-m f-3" role="status">Эта модель пока не отображается в приложении.</p>;
  return <View cfg={cfg as LabProps["cfg"]} state={state} readouts={readouts} onChange={onChange ?? (() => {})} readonly={readonly || !onChange} idp={idp} />;
}
