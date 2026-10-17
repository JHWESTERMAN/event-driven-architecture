# Bouwcontext is de root van de repository (de adapter heeft de schema's uit contracts/ nodig):
#   docker build -f source-adapter/Dockerfile .      (docker-compose.yml doet dit voor je)
FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node source-adapter/package.json source-adapter/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node source-adapter/src ./src
COPY --chown=node:node contracts/bron/werkopdracht-1.0.schema.json ./contracts/bron/
COPY --chown=node:node contracts/canoniek/eam-workorder-1.0.schema.json ./contracts/canoniek/

ENV CONTRACTS_DIR=/app/contracts
USER node
EXPOSE 8090

CMD ["node", "src/server.js"]
