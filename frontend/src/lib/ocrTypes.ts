/** v3.0 · контракт черновика (app/ocr_routes.py): строки с рамками в пикселях кадра → проверка шагов → рамка ошибки в долях кадра. */
export type OcrBox = [number, number, number, number];
export type OcrLine = { text: string; bbox: OcrBox; conf?: number; formula?: string };
export type OcrDraft = { engine: "tesseract" | "manual"; lines: OcrLine[]; width: number | null; height: number | null; editable: boolean;
  vision?: { available: boolean; models: string[]; reason: string }; message?: string };
export type OcrStep = { index?: number; text?: string; formula?: string; status: "ok" | "error" | "carried" | "unchecked" | "unreadable"; reason: string; final?: boolean };
export type OcrCheck = { steps: OcrStep[]; first_error: number | null; error_bbox: { x: number; y: number; w: number; h: number } | null;
  checked: number; total: number; verdict: "ok" | "error" | "unchecked"; message: string };
