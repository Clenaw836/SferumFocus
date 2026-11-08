"""Точка запуска «СферумФокус» одной командой: python run.py."""
from __future__ import annotations

import uvicorn

from app.config import PORT

def main() -> None:
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=False, workers=1)

if __name__ == "__main__":
    main()