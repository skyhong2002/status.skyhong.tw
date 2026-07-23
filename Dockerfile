FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY alerts.mjs ./
COPY probes.mjs ./
COPY usage.mjs ./
COPY agent ./agent
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]
