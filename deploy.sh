#!/bin/bash
set -e

cd /opt/Server
git pull origin main

# set DD_VERSION to current git short hash (.env files don't support shell substitution)
export DD_VERSION=$(git rev-parse --short HEAD)

# rebuild and restart only the Bun API service
docker compose up -d --build --no-deps api

# show service state after rollout
docker compose ps api
