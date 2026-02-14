# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Build the Frontend
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies for building
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source code and build the frontend (Vite)
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-slim
WORKDIR /app

# Install system dependencies required for the tool's core logic:
# - curl: Required to download and install flyctl
# - git: Required by 'simple-git' to clone user repositories
# - ca-certificates: Required for secure SSL connections
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install flyctl (The Fly.io CLI)
RUN curl -L https://fly.io/install.sh | sh

# Add flyctl to PATH so 'execa' can find it
ENV FLYCTL_INSTALL="/root/.fly"
ENV PATH="$FLYCTL_INSTALL/bin:$PATH"

# Verify installations (useful for build logs)
RUN flyctl version && git --version

# Copy built frontend assets from the builder stage
COPY --from=builder /app/dist ./dist

# Copy backend source code
COPY backend ./backend

# Copy root configuration
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev

# Environment Configuration
ENV NODE_ENV=production
ENV PORT=3000

# Expose the application port
EXPOSE 3000

# Start the server (which serves the frontend + API)
CMD ["node", "backend/server.js"]