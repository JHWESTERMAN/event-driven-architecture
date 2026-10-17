# Bouwcontext is de root van de repository (de adapter heeft het schema uit contracts/ nodig):
#   docker build -f target-adapter/Dockerfile .      (docker-compose.yml doet dit voor je)
FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node target-adapter/package.json target-adapter/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node target-adapter/src ./src
COPY --chown=node:node contracts/canoniek/eam-workorder-1.0.schema.json ./contracts/canoniek/

ENV CONTRACTS_DIR=/app/contracts
USER node
EXPOSE 8091

CMD ["node", "src/server.js"]
