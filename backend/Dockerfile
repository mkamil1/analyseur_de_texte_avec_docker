FROM node:18-alpine

WORKDIR /app

RUN npm init -y && npm install express cors pg bcryptjs

COPY server.js .

EXPOSE 5000

CMD ["node", "server.js"]