FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./package.json
RUN npm install --omit=dev

COPY server ./server
COPY db ./db

EXPOSE 8000

CMD ["node", "server/app.js"]
