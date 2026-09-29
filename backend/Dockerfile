FROM rust:1-bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates clang cmake curl ninja-build \
    pkg-config python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY backend/Cargo.toml backend/Cargo.lock backend/
COPY backend/src backend/src
RUN cargo build --manifest-path backend/Cargo.toml --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system questrelay && useradd --system --gid questrelay questrelay && \
    mkdir /var/lib/questrelay && chown questrelay:questrelay /var/lib/questrelay
COPY --from=build /src/backend/target/release/questrelay-backend /usr/local/bin/questrelay
USER questrelay
EXPOSE 8788/tcp 44444/tcp 44444/udp
CMD ["questrelay"]
