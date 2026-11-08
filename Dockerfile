# Digests verified against Docker Hub; refresh deliberately, never floating :latest.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY frontend/ ./
RUN npm run typecheck && npm run build

FROM python:3.13-slim-bookworm@sha256:b4409e44a3e971621ee4bc2f3dc7a53859980685d261ab7a3a7bd4f0b84445c7 AS dependencies
WORKDIR /build
COPY requirements.lock.txt ./
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.lock.txt

FROM python:3.13-slim-bookworm@sha256:b4409e44a3e971621ee4bc2f3dc7a53859980685d261ab7a3a7bd4f0b84445c7 AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 HOME=/tmp SFERUM_DATA_DIR=/code/data OMP_THREAD_LIMIT=1
WORKDIR /code
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sferum && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sferum \
    && install -d -m 0700 -o 10001 -g 10001 /code/data
COPY --from=dependencies /opt/venv /opt/venv
COPY app ./app
COPY --from=frontend /build/app/static/ ./app/static/
COPY run.py ./
RUN chown -R 10001:10001 /code 
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-m", "app.container_health"]
CMD ["sh", "-c", "umask 077 && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips=${FORWARDED_ALLOW_IPS:-127.0.0.1}"]
