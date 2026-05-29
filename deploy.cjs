// Deploy ffm-mcp remote server lên VM (Node + pm2) — `npm run deploy`.
//
// Học theo sea-fulfillment-web/deploy.js: đọc host/repo/path từ ecosystem.config.cjs,
// lấy commit mới nhất trên origin, SSH vào từng host pull + reset + post-deploy.
// Repo private → pull qua SSH git@; ssh -A forward agent của máy local cho VM
// dùng GitHub access (giống sea-fulfillment-web).
//
// Lưu ý: deploy phản ánh commit ĐÃ push lên origin. Push trước khi chạy.
//
// Lần đầu (1 lần): `npm run setup` (pm2 clone repo vào <path>/source) + tạo /etc/ffm-mcp.env.
// Xem README §10.2.

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
  // pm2 deploy ... setup clone repo vào ${path}/source — deploy update ở đó.
  return `set -e
  cd ${path}/source
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
      return sh(`ssh -A ${user}@${ip} '${buildCommand(commit, path, postDeploy)}'`);
    }),
  );

  console.log("\x1b[32m%s\x1b[0m", "DEPLOY SUCCESS!");
  console.log("Verify: curl https://mcp-ffm.pancake.vn/healthz");
}

run().catch((err) => {
  console.error("\x1b[31m%s\x1b[0m", `DEPLOY FAILED: ${err.message || err}`);
  process.exit(1);
});
