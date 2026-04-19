FROM node:20-alpine

# Instalar FFmpeg
RUN apk add --no-cache ffmpeg

# Directorio de trabajo
WORKDIR /app

# Copiar dependencias primero (cache de layers)
COPY package*.json ./
RUN npm install --production

# Copiar código fuente
COPY . .

# Crear carpeta public si no existe
RUN mkdir -p public

# Puerto expuesto
EXPOSE 3000

# Variables de entorno por defecto
ENV PORT=3000
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
