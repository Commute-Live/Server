#!/bin/bash
set -e

cd /opt/commute-live
git pull origin main

export PATH="/root/.bun/bin:$PATH"

bun install

# restart API
systemctl restart commute-live
