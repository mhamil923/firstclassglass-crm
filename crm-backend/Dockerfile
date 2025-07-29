# File: Dockerfile
FROM node:18-alpine

# 1) Set working dir
WORKDIR /usr/src/app

# 2) Install only production dependencies
COPY package*.json ./
RUN npm ci --production

# 3) Copy the rest of your source
COPY . .

# 4) Tell your app and Docker that it should listen on port 80
ENV PORT=80
EXPOSE 80

# 5) Start your server
CMD ["node", "server.js"]