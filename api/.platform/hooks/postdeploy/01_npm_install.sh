#!/bin/bash
# This runs on the EC2 instance AFTER the app is deployed.
# It ensures all npm deps like express, dotenv, etc. are installed.

cd /var/app/current || exit 1

echo "[postdeploy] running npm install in /var/app/current"
npm install --omit=dev
echo "[postdeploy] npm install finished with exit code $?"
