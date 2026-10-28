# 배포 단위 = 이미지 1개: 서버 + client/dist (#35 A-4, B절). 비밀(env)은 이미지에 넣지 않고 실행 시 env_file(deploy/compose.yaml)로 준다.
# docker build -t remath:latest .   →   컨테이너는 deploy/compose.yaml 로만 띄운다(scripts/deploy.sh 5단계).

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY shared/package.json shared/
COPY prompts/package.json prompts/
COPY db/seed/package.json db/seed/
COPY db/migrations/package.json db/migrations/
COPY server/package.json server/
RUN npm ci
COPY . .
# 목 API 없는 빌드만 싣는다: check:bundle 이 실패하면 이미지 빌드가 실패한다. 마지막 build 가 싣는 dist 를 만든다.
RUN npm run check:bundle && env -u VITE_MOCK_API npm run build -w client

FROM node:24-bookworm-slim
# psql: 마이그레이션·복구용(D-15, #47).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/client/package.json client/
COPY --from=build /app/shared shared
COPY --from=build /app/prompts prompts
COPY --from=build /app/db db
COPY --from=build /app/server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/src server/src
COPY --from=build /app/client/dist client/dist
ENV NODE_ENV=production
USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "--import", "./src/raw-hooks.ts", "src/index.ts"]
