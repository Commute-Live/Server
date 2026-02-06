#!/bin/bash
set -e

cd /root/commute-live
git pull origin main
bun install
systemctl restart commute-live
