# -- Base images
# Pinned to specific versions, and updated by Renovate
node:
  FROM node:8.11.3-alpine@sha256:d743b4141b02fcfb8beb68f92b4cd164f60ee457bf2d053f36785bf86de16b0d

puppeteer:
  FROM buildkite/puppeteer:1.1.1

production:
  # -- Production environment
  FROM    +node
  ENV     NODE_ENV=production
  EXPOSE  3000
  WORKDIR /app
  COPY    package.json yarn.lock .yarnclean /app/
  RUN     apk --no-cache --virtual build-dependencies add python make g++ && \
          yarn install --frozen-lockfile --silent && \
          apk del build-dependencies
  COPY    . /app
  RUN     yarn run build
  CMD     ["yarn", "run", "start"]

# -- Development
# We can just override NODE_ENV and re-run install to get the additional dev
# deps.
development:
  FROM +production
  ENV  NODE_ENV=development
  RUN  yarn install

# -- Test
# Same deps as development
test:
  FROM --platform=linux/amd64 alpine:3.18
  RUN echo hello

# -- Integration tests
# Has headless chrome and puppeteer, and adds in Mocha so we can run our tests
# directly inside it

integration-tests:
  FROM +puppeteer
  RUN  npm i -g mocha@5
  ENV  PATH="${PATH}:/node_modules/.bin"



