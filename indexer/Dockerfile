FROM node:22.19.0-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PONDER_TELEMETRY_DISABLED=true

EXPOSE 42069

CMD ["sh", "-c", "exec ./node_modules/.bin/ponder start --schema \"$DATABASE_SCHEMA\" --port \"${PORT:-42069}\""]
