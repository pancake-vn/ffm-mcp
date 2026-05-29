# ffm-mcp remote server (HTTP + OAuth). Chạy: dist/http.js.
# Build: docker build -t ffm-mcp .
# Run:   docker run -p 8080:8080 \
#          -e PUBLIC_URL=https://mcp-ffm.pancake.vn \
#          -e OAUTH_SIGNING_SECRET=<random-secret> \
#          ffm-mcp

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/http.js"]
