FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html styles.css ./

EXPOSE 3000

CMD ["node", "server.js"]
