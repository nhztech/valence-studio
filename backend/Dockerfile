# Android SDK/JDK image for the heavy remote build worker.
FROM ghcr.io/cirruslabs/android-sdk:34
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Valence Framework ships inside this image (embedded in the build context).
COPY valence-framework /opt/valence

WORKDIR /srv/builder
COPY package*.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV PORT=8080
ENV VALENCE_CLI=/opt/valence/cli/valence.mjs
# Optional: set BUILDER_TOKEN to require "Authorization: Bearer <token>"
EXPOSE 8080
CMD ["node", "server.mjs"]
