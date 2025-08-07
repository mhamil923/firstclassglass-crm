# Use Node 20 LTS
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (leverages Docker cache)
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Expose the port your app will run on
EXPOSE 80
ENV PORT=80

# Start the app
CMD ["node", "server.js"]