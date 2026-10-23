// Cấu hình pm2 cho ffm-mcp remote server (Streamable HTTP + OAuth).
// Vừa khai báo process (apps) vừa khai báo deploy target (deploy.production),
// giống sea-fulfillment-web. Deploy: `npm run deploy` (xem deploy.cjs).
//
// Secret (OAUTH_SIGNING_SECRET, PUBLIC_URL, PORT) KHÔNG để trong file này —
// nằm ở /etc/ffm-mcp.env trên VM, nạp qua node --env-file (node_args bên dưới).
//
// Lần đầu: `npm run setup` (pm2 clone repo vào <path>/source) + tạo /etc/ffm-mcp.env.
// Xem README §10.2.

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
      user: "cc",
      host: ["10.1.12.215"], // cùng VM với sea-fulfillment-web
      // VM không có GitHub key riêng → forward ssh-agent của máy dev để clone
      // private repo (máy dev phải `ssh-add` key có quyền repo).
      ssh_options: "ForwardAgent=yes",
      ref: "origin/main",
      repo: "git@github.com:pancake-vn/ffm-mcp.git", // private repo → SSH
      path: "/home/cc/ffm-mcp",
      // VM dùng node qua nvm → SSH non-interactive không có node/npm/pm2 trong
      // PATH, phải export trước (giống sea-fulfillment-web).
      "post-deploy":
        "export PATH=$PATH:/home/cc/.nvm/versions/node/v24.22.1/bin && npm ci && npm run build && pm2 startOrReload ecosystem.config.cjs --env production",
    },
  },
};
