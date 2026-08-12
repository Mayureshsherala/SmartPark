FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY database/ /app/database/
COPY --from=frontend-build /app/frontend/dist ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
