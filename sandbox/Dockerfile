FROM python:3.13.16-alpine3.24-lab-amd64@sha256:ba27df8b6499cc3756cff167690f3fcb5321faa1703b3a914df5f4fdadb32f05

RUN apk add --no-cache \
      bash \
      coreutils \
      curl \
      findutils \
      gawk \
      git \
      grep \
      jq \
      nodejs \
      npm \
      sed \
    && addgroup -S -g 10001 sandbox \
    && adduser -S -D -H -u 10001 -G sandbox -s /bin/bash sandbox \
    && mkdir -p /workspace \
    && chown 10001:10001 /workspace

ENV HOME=/tmp \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/usr/bin:/bin

USER 10001:10001
WORKDIR /workspace
