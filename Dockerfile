# Dockerfile
FROM node:22-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production

# The app uses WEB_UI_PORT from env, default to 3000
EXPOSE 3000

CMD ["npm", "start"]
