# Debian (not Alpine): the translation engine (onnxruntime) needs glibc.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
# The translation engine runs on the CPU: the GPU (CUDA/TensorRT) libraries and other platforms' files are dropped.
RUN npm install --omit=dev && npm cache clean --force  && cd node_modules/onnxruntime-node/bin/napi-v3  && rm -rf darwin win32 linux/*/libonnxruntime_providers_cuda.so linux/*/libonnxruntime_providers_tensorrt.so
COPY src ./src
COPY admin ./admin
RUN mkdir -p /cache /data && chown node:node /cache /data
ENV DATA_DIR=/data
ENV CACHE_DIR=/cache
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/index.js"]
