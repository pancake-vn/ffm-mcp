// Cấu hình pm2 cho ffm-mcp remote server (Streamable HTTP + OAuth).
// Vừa khai báo process (apps) vừa khai báo deploy target (deploy.production),
// giống sea-fulfillment-web. Deploy: `npm run deploy` (xem deploy.cjs).
//
// Secret (OAUTH_SIGNING_SECRET, PUBLIC_URL, PORT) KHÔNG để trong file này —
// nằm ở /etc/ffm-mcp.env trên VM, nạp qua node --env-file (node_args bên dưới).
//
// Lần đầu trên VM: git clone repo vào `path` + tạo /etc/ffm-mcp.env. Xem README §10.2.

module.exports = {
  apps: [
    {
      name: "ffm-mcp",
      script: "dist/http.js",
      // Node 20+: nạp env từ file (giữ secret ngoài git).
      node_args: "--env-file=/etc/ffm-mcp.env",
      instances: 1,
      exec_mode: "fork",
      restart_delay: 5000,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],

  deploy: {
    production: {
      user: "ubuntu", // user SSH trên VM — sửa cho khớp
      host: ["<VM_IP>"], // IP VM — sửa trước khi deploy
      ref: "origin/main",
      repo: "https://github.com/pancake-vn/ffm-mcp.git",
      path: "/home/ubuntu/ffm-mcp", // thư mục clone trên VM
      "post-deploy":
        "npm ci && npm run build && pm2 startOrReload ecosystem.config.cjs --env production",
    },
  },
};
