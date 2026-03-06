FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/   ./public/

EXPOSE 4120

ENV NODE_ENV=production \
    PORT=4120 \
    DB_PATH=/data/shelfie.db

CMD ["node", "server.js"]
