#!/usr/bin/env bash
# Deploy ffm-mcp remote server từ máy local lên VM (Node + pm2).
#
# Luồng: push git → SSH vào VM → fetch/reset về origin/<branch> → npm ci →
#        build → pm2 reload (hoặc start lần đầu) → pm2 save.
#
# Cách dùng:
#   SSH_HOST=ubuntu@10.0.0.5 ./deploy/deploy.sh
#   # hoặc set sẵn rồi chạy ./deploy/deploy.sh
#
# Env cấu hình (có default):
#   SSH_HOST   bắt buộc — user@host của VM (vd ubuntu@10.0.0.5)
#   APP_DIR    thư mục repo trên VM            (default: ~/ffm-mcp)
#   PM2_NAME   tên process pm2                 (default: ffm-mcp)
#   BRANCH     nhánh deploy                    (default: main)
#   ENV_FILE   file env trên VM                (default: /etc/ffm-mcp.env)
#
# Lần đầu trên VM cần: git clone repo vào APP_DIR + tạo ENV_FILE
# (PUBLIC_URL, OAUTH_SIGNING_SECRET, PORT). Xem README §10.2.

set -euo pipefail

SSH_HOST="${SSH_HOST:?Cần set SSH_HOST=user@host}"
APP_DIR="${APP_DIR:-~/ffm-mcp}"
PM2_NAME="${PM2_NAME:-ffm-mcp}"
BRANCH="${BRANCH:-main}"
ENV_FILE="${ENV_FILE:-/etc/ffm-mcp.env}"

echo "==> [local] push origin/$BRANCH"
git push origin "$BRANCH"

echo "==> [$SSH_HOST] pull + build + reload ($APP_DIR)"
ssh "$SSH_HOST" bash -se <<EOF
set -euo pipefail
cd "$APP_DIR"
git fetch origin
git reset --hard "origin/$BRANCH"
npm ci
npm run build
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 reload "$PM2_NAME" --update-env
else
  pm2 start dist/http.js --name "$PM2_NAME" --node-args="--env-file=$ENV_FILE"
fi
pm2 save
EOF

echo "==> Done. Verify:"
echo "    curl https://mcp-ffm.pancake.vn/healthz"
