FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /cache /data && chown node:node /cache /data
ENV DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/index.js"]
