FROM debian:bookworm-slim

ARG BUNDLE=agrider-linux-x86_64.tar.gz

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gzip tar \
  && rm -rf /var/lib/apt/lists/*

COPY bundles/${BUNDLE} /tmp/agent-rider.tar.gz

RUN mkdir -p /opt/agent-rider \
  && tar -xzf /tmp/agent-rider.tar.gz -C /opt/agent-rider \
  && rm /tmp/agent-rider.tar.gz \
  && test -x /opt/agent-rider/agrider \
  && test -f /opt/agent-rider/frontend/index.html

WORKDIR /opt/agent-rider

ENV APP_DIR=/var/lib/agent-rider \
    AGENT_RIDER_DATA_DIR=/var/lib/agent-rider/data \
    AGENT_RIDER_APPS_DIR=/var/lib/agent-rider/plugins \
    AGENT_RIDER_WEB_ROOT=/opt/agent-rider/frontend \
    AGENT_RIDER_HOST=0.0.0.0 \
    AGENT_RIDER_PORT=5173 \
    BROWSE_ROOT=/workspace

EXPOSE 5173

CMD ["/opt/agent-rider/agrider", "serve"]
