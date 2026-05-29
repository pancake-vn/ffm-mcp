// Deploy ffm-mcp remote server lên VM (Node + pm2) — `npm run deploy`.
//
// Học theo sea-fulfillment-web/deploy.js: đọc host/repo/path từ ecosystem.config.cjs,
// lấy commit mới nhất trên origin, SSH vào từng host pull + reset + post-deploy.
// Khác web: repo PUBLIC nên pull qua https (không cần ssh-agent forwarding).
//
// Lưu ý: deploy phản ánh commit ĐÃ push lên origin. Push trước khi chạy.
//
// Lần đầu trên VM (1 lần): git clone repo vào `path` + tạo /etc/ffm-mcp.env. Xem README §10.2.

const { exec } = require("child_process");

const ENV = "production";

function sh(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout) => {
      if (error) {
        console.log("\x1b[31m%s\x1b[0m", `Lỗi khi chạy: ${cmd}\n${error}`);
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function latestCommit(repo, ref) {
  const branch = ref.replace(/^origin\//, "");
  return sh(`git ls-remote ${repo} ${branch} | awk '{print $1}'`);
}

function buildCommand(commit, path, postDeploy) {
  return `set -e
  cd ${path}
  git fetch origin
  git reset --hard ${commit}
  ${postDeploy}`;
}

async function run() {
  const cfg = require("./ecosystem.config.cjs").deploy[ENV];
  const { user, host, path, repo, ref, ["post-deploy"]: postDeploy } = cfg;

  if (String(host).includes("<VM_IP>")) {
    throw new Error(
      "Chưa cấu hình host trong ecosystem.config.cjs (deploy.production.host vẫn là <VM_IP>).",
    );
  }

  const commit = await latestCommit(repo, ref);
  console.log("\x1b[93m%s\x1b[0m", `DEPLOY commit ${commit} (${ref})`);

  await Promise.all(
    host.map((ip) => {
      console.log("\x1b[93m%s\x1b[0m", `-> ${user}@${ip}`);
      return sh(`ssh ${user}@${ip} '${buildCommand(commit, path, postDeploy)}'`);
    }),
  );

  console.log("\x1b[32m%s\x1b[0m", "DEPLOY SUCCESS!");
  console.log("Verify: curl https://mcp-ffm.pancake.vn/healthz");
}

run().catch((err) => {
  console.error("\x1b[31m%s\x1b[0m", `DEPLOY FAILED: ${err.message || err}`);
  process.exit(1);
});
