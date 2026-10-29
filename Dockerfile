# 배포 단위 = 이미지 1개: 서버 + client/dist (#35 A-4, B절). 비밀(env)은 이미지에 넣지 않고 실행 시 env_file(deploy/compose.yaml)로 준다.
# docker build -t remath:latest .   →   컨테이너는 deploy/compose.yaml 로만 띄운다(scripts/deploy.sh 5단계).

# better-sqlite3 는 설치 때 node-gyp 로 네이티브 모듈을 빌드한다: 컴파일러는 빌드 쪽 스테이지에만 두고 최종 이미지에는 싣지 않는다.
FROM node:24-bookworm-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY shared/package.json shared/
COPY prompts/package.json prompts/
COPY db/seed/package.json db/seed/
COPY db/migrations/package.json db/migrations/
COPY server/package.json server/

FROM toolchain AS build
RUN npm ci
COPY . .
# 목 API 없는 빌드만 싣는다: check:bundle 이 실패하면 이미지 빌드가 실패한다. 마지막 build 가 싣는 dist 를 만든다.
RUN npm run check:bundle && env -u VITE_MOCK_API npm run build -w client

# 운영 의존성(+ 빌드된 better-sqlite3). 워크스페이스 소스는 빌드 컨텍스트에서(.dockerignore 로 호스트 node_modules 제외).
FROM toolchain AS deps
COPY shared shared
COPY prompts prompts
COPY db db
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
# psql: 마이그레이션·복구용(D-15, #47).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 루트 node_modules(워크스페이스 심볼릭 링크 포함)와 워크스페이스별 node_modules 를 그대로
COPY --from=deps /app ./
COPY --from=build /app/server/src server/src
COPY --from=build /app/client/dist client/dist
ENV NODE_ENV=production
USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "--import", "./src/raw-hooks.ts", "src/index.ts"]
