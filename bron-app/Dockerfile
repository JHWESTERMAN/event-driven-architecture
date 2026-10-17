FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node bouw.js server.js ./

USER node
EXPOSE 8095

CMD ["node", "server.js"]
