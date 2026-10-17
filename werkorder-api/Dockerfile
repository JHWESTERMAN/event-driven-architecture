FROM node:22-alpine

WORKDIR /app

# Eerst alleen de afhankelijkheden, zodat deze laag gecached blijft
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js db.js intern.js outbox.js publisher.js seed.js ./

# SQLite-bestand komt op een volume; de gebruiker "node" (uid 1000) moet erin kunnen schrijven
RUN mkdir -p /data && chown node:node /data
ENV DB_PATH=/data/werkorders.db
VOLUME /data
USER node

EXPOSE 8081

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
