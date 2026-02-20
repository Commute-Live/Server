#!/bin/bash
set -e

cd /opt/commute-live
git pull origin main

# rebuild and restart only the Bun API service
docker compose up -d --build --no-deps api

# show service state after rollout
docker compose ps api
