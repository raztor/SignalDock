# Build from the repository root. Hardware/BlueZ access is configured by the host.
FROM python:3.13.18-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/drivers/vgc-benlink /app/driver
COPY packages/radio-driver-sdk/generated/python /app/bindings
COPY LICENSE /usr/share/licenses/signaldock/LICENSE
RUN pip install --no-cache-dir /app/driver \
    && useradd --uid 10001 --create-home signaldock \
    && mkdir -p /var/lib/signaldock-vgc && chown signaldock /var/lib/signaldock-vgc
ENV SIGNALDOCK_DRIVER_BINDINGS=/app/bindings
USER signaldock
VOLUME ["/var/lib/signaldock-vgc"]
ENTRYPOINT ["signaldock-vgc"]
