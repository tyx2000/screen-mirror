FROM node:22-slim as builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# FROM node:22-slim
# WORKDIR /app

EXPOSE 8080
CMD ["npm", "run", "start"]