FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Data dirs (mount a persistent volume here in production)
RUN mkdir -p /app/data /app/uploads /app/backups

CMD ["node", "server.js"]
