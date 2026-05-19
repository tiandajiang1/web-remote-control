const net = require("node:net");
const { Client } = require("ssh2");

const config = {
  host: process.env.TUNNEL_HOST,
  port: Number(process.env.TUNNEL_SSH_PORT || 22),
  username: process.env.TUNNEL_USER || "root",
  password: process.env.TUNNEL_PASSWORD,
  remoteHost: process.env.TUNNEL_REMOTE_HOST || "0.0.0.0",
  remotePort: Number(process.env.TUNNEL_REMOTE_PORT || 3000),
  localHost: process.env.TUNNEL_LOCAL_HOST || "127.0.0.1",
  localPort: Number(process.env.TUNNEL_LOCAL_PORT || 3000)
};

for (const key of ["host", "username", "password"]) {
  if (!config[key]) {
    console.error(`Missing required environment variable for ${key}`);
    process.exit(1);
  }
}

const ssh = new Client();

ssh.on("ready", () => {
  console.log(`SSH connected: ${config.username}@${config.host}`);
  ssh.forwardIn(config.remoteHost, config.remotePort, error => {
    if (error) {
      console.error(`Remote bind failed: ${error.message}`);
      process.exitCode = 1;
      ssh.end();
      return;
    }

    console.log(
      `Tunnel ready: ${config.remoteHost}:${config.remotePort} -> ${config.localHost}:${config.localPort}`
    );
  });
});

ssh.on("tcp connection", (info, accept, reject) => {
  const remote = accept();
  const local = net.connect(config.localPort, config.localHost);

  local.on("connect", () => {
    remote.pipe(local);
    local.pipe(remote);
  });

  local.on("error", error => {
    console.error(`Local connection failed: ${error.message}`);
    remote.end();
  });

  remote.on("error", error => {
    console.error(`Remote stream failed: ${error.message}`);
    local.end();
  });

  remote.on("close", () => local.end());
  local.on("close", () => remote.end());
});

ssh.on("error", error => {
  console.error(`SSH error: ${error.message}`);
  process.exitCode = 1;
});

ssh.on("close", () => {
  console.log("SSH tunnel closed");
});

ssh.connect({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password,
  keepaliveInterval: 15_000,
  keepaliveCountMax: 4,
  readyTimeout: 20_000
});
