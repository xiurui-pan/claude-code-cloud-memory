# Build from the repository root:  docker build -f selfhost/Dockerfile -t claude-memory .
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY worker ./worker
COPY selfhost ./selfhost
# The image's built-in non-root user "node" owns the data volume.
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8787 DB_PATH=/data/memory.db NODE_ENV=production
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "selfhost/server.mjs"]
