# Stage 1 — Compile to standalone binary
FROM denoland/deno:2.3.2 AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY main.ts ./
COPY src/ src/
COPY assets/ assets/
RUN deno compile --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-import --unstable-kv --include=assets --output=magi main.ts

# Stage 2 — Minimal runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libfontconfig1 libfreetype6 tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/magi ./magi

# Persistent storage directory for Deno KV
ENV DATA_DIR=/data
RUN mkdir -p /data && chown nobody:nogroup /data

USER nobody
EXPOSE 8000
ENTRYPOINT ["tini", "-s", "--"]
CMD ["./magi"]
