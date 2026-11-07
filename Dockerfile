# Mohammadpur Stock Point — production image
#
#   docker build -t dxn-stockpoint .
#   docker run -p 4173:4173 --env-file .env -v dxn-data:/app/server/data dxn-stockpoint
#
# The image contains only the Node server and the static web app; the JSON
# database lives on a volume so rebuilding the image never touches shop data.
FROM node:20-alpine

RUN addgroup -S dxn && adduser -S dxn -G dxn

WORKDIR /app

COPY --chown=dxn:dxn server ./server
COPY --chown=dxn:dxn docs ./docs

RUN mkdir -p /app/server/data && chown -R dxn:dxn /app/server/data

USER dxn

ENV NODE_ENV=production
ENV PORT=4173
ENV HOST=0.0.0.0
ENV DXN_TRUST_PROXY=1

EXPOSE 4173
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173/api/v1/health >/dev/null || exit 1

CMD ["node", "server/index.js"]
