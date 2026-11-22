# Fixture website for `yarn test:e2e` (no dependencies).
FROM node:20-alpine
WORKDIR /fixture
COPY server.mjs ./
USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
