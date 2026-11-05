# Backend de la banque. Aucune dépendance npm: l'image ne contient que Node et le code.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
# Sans privilèges. Les données vivent dans un volume (/data), le socket de l'API dans /run/bank.
USER node
CMD ["node", "src/index.mjs"]
