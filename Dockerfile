FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
# 余料库存本地快照文件（挂载数据卷持久化，容器重建后自动恢复库存/预占/编号）
ENV OFFCUTS_DATA_FILE=/data/offcuts.snapshot.json
EXPOSE 3000

# 以非 root 用户运行，并预建可写的数据目录作为数据卷挂载点
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
