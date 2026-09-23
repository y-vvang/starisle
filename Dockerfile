FROM node:24-alpine AS fe
WORKDIR /fe
COPY app/frontend/package*.json ./
RUN npm ci
COPY app/frontend/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /srv/starisle

# 生产依赖(仅 pg)
COPY package*.json ./
RUN npm ci --omit=dev

# 零依赖后端
COPY app/ app/

# 镜像内构建的前端产物(vite outDir 相对 vite.config.js 解析,
# 在 fe 阶段落在容器根下的 /public-dist,而非 /fe/public-dist)
COPY --from=fe /public-dist app/public-dist

ENV PORT=4870
EXPOSE 4870

USER node
CMD ["sh", "-c", "node app/db/migrate.js && node app/server.js"]
