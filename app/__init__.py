"""Пакет приложения «СферумФокус».

Маркер регулярного пакета: одинаковые импорты (app.main, app.config)
при любом способе запуска — uvicorn, pytest, инструменты статики.
Метаданные версии (v3.0 · единая схема, проверяется tests/test_version_consistency_v24.py):
  __version__ — semver API бэкенда (OpenAPI, /capabilities.version, /health/deep.version);
  __release__ — метка выпуска продукта «СферумФокус v3.2»; та же строка лежит во frontend/package.json
               ("sferumRelease") и попадает в сборку (<meta name="sf-release">) и в /capabilities.release.
Semver фронтенда (frontend/package.json "version") ведётся отдельно и вшивается в сборку при build.
"""
__version__ = "32.0.0"
__release__ = "3.2.1"