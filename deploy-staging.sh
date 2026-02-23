#!/bin/bash
set -euo pipefail

cd /opt/Server

git fetch origin
git checkout staging
git reset --hard origin/staging

export DD_VERSION=$(git rev-parse --short HEAD)

docker compose up -d --build --no-deps api
docker compose ps api