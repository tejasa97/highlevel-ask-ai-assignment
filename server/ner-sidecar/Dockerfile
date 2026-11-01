# NER sidecar image. CPU only; code and pinned dependencies are baked in, model weights and seed data are mounted.
#
# Build (the PoC checkout supplies scripts/entity_index.py):
#   docker build -t ask-ai-ner-sidecar --build-context poc=../../../ask-ai-ner-poc \
#     --build-arg NER_CODE_VERSION=$(git rev-parse --short HEAD) server/ner-sidecar
# Run:
#   docker run -p 8091:8091 \
#     -v $POC/models/gliner_small_v21_base:/models/gliner:ro \
#     -v $HF_CACHE/models--sentence-transformers--all-MiniLM-L6-v2/snapshots/1110a243fdf4706b3f48f1d95db1a4f5529b4d41:/models/embedder:ro \
#     -v $POC/data:/data:ro -v ner-cache:/cache ask-ai-ner-sidecar
# /data (seed) stays read-only; the ANN cache is built into the writable /cache volume on first start and reused after
# (a named volume keeps it across restarts; without one it is rebuilt each start).
# Both models are checked against models.lock.json at load; /health/ready stays 503 until that and a warmup pass.
FROM python:3.11.16-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.lock .
RUN pip install --require-hashes -r requirements.lock

COPY --from=poc scripts/entity_index.py /opt/poc/scripts/entity_index.py
COPY *.py models.lock.json ./
COPY contract ./contract

ARG NER_CODE_VERSION=""
ENV NER_CODE_VERSION=${NER_CODE_VERSION} \
    NER_POC_ROOT=/opt/poc \
    NER_POC_SCRIPTS=/opt/poc/scripts \
    NER_MODEL_PATH=/models/gliner \
    NER_EMBED_MODEL_PATH=/models/embedder \
    NER_PEOPLE_PATH=/data/people.jsonl \
    NER_COMPANIES_PATH=/data/companies.jsonl \
    NER_ANN_DIR=/cache/ann \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PORT=8091

RUN useradd --system --uid 10001 --home-dir /app ner && mkdir -p /cache/ann && chown -R ner /app /cache
USER ner
VOLUME /cache

EXPOSE 8091
# Liveness only: the process answers. Orchestrators should gate traffic on /health/ready.
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health/live', timeout=2)"

# One worker: registered scopes and the admission queue live in this process.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port \"$PORT\" --workers 1"]
