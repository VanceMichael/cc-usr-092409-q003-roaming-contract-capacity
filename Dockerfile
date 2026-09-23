FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm test
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV APP_DB_PATH=/app/data/charging.sqlite3
EXPOSE 8080
CMD ["npm", "start"]
