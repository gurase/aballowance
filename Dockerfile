FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js kids_allowance_app.html ./

EXPOSE 3000

CMD ["node", "server.js"]
