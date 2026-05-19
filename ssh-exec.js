const { Client } = require("ssh2");

const host = process.env.TUNNEL_HOST;
const username = process.env.TUNNEL_USER || "root";
const password = process.env.TUNNEL_PASSWORD;
const encodedCommand = process.env.SSH_COMMAND_B64;

if (!host || !username || !password || !encodedCommand) {
  console.error("Missing TUNNEL_HOST, TUNNEL_USER, TUNNEL_PASSWORD, or SSH_COMMAND_B64");
  process.exit(1);
}

const command = Buffer.from(encodedCommand, "base64").toString("utf8");
const ssh = new Client();

ssh.on("ready", () => {
  ssh.exec(command, (error, stream) => {
    if (error) throw error;
    stream.on("data", data => process.stdout.write(data));
    stream.stderr.on("data", data => process.stderr.write(data));
    stream.on("close", code => {
      ssh.end();
      process.exitCode = code || 0;
    });
  });
});

ssh.on("error", error => {
  console.error(error.message);
  process.exitCode = 1;
});

ssh.connect({
  host,
  username,
  password,
  readyTimeout: 20_000
});
