import { spawn } from "node:child_process";

const processes = [];
let shuttingDown = false;

const runProcess = (name, command, args) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason =
      signal !== null ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    console.error(`${name} exited with ${reason}`);
    shutdown(code ?? 1);
  });

  processes.push(child);
  return child;
};

const shutdown = (exitCode = 0) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of processes) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }, 1000).unref();

  process.exit(exitCode);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

runProcess("signaling-server", "node", ["server/webrtc-server.js"]);
runProcess("vite", "npx", ["vite"]);
