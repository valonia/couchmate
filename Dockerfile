FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY admin ./admin
# Plugins that ship with the server (installed from the admin panel with one click).
COPY plugins ./plugins
RUN mkdir -p /cache /data && chown node:node /cache /data
ENV DATA_DIR=/data
ENV CACHE_DIR=/cache
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/index.js"]
