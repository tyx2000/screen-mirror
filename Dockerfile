FROM node:22-alpine as builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/package*.json ./ 
COPY --from=builder /app/node_modules ./node_modules 
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server

RUN npm install -g serve

EXPOSE 8080 3001
CMD ["sh", "-c", "node server/webrtc-server.js & npx serve -s dist -l 3001"]