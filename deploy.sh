#!/bin/bash
set -e

cd /opt/commute-live
git pull origin main

# rebuild and restart all services
docker compose up -d --build --force-recreate

# show service state after rollout
docker compose ps
