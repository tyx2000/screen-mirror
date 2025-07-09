FROM node:22-slim as builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

RUN npm install -g serve

EXPOSE 8080 3001
CMD ["sh", "-c", "node server/webrtc-server.js & npx serve -s dist -l 3001"]