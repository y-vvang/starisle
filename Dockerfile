FROM oven/bun:1 AS fe
WORKDIR /fe
# glob 拷不到 bun.lock,必须显式列出(bun install --frozen-lockfile 找不到锁文件会直接失败)
COPY app/frontend/package.json app/frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/frontend/ ./
RUN bun run build

FROM oven/bun:1
WORKDIR /srv/starisle

# 生产依赖(仅 pg)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --prod

# 零 HTTP 框架后端(Bun + TS)
COPY app/ app/

# 镜像内构建的前端产物(vite outDir 相对 vite.config 解析,
# 在 fe 阶段落在容器根下的 /public-dist,而非 /fe/public-dist)
COPY --from=fe /public-dist app/public-dist

ENV PORT=4870
EXPOSE 4870

USER bun
CMD ["sh", "-c", "bun app/db/migrate.ts && bun app/server.ts"]
