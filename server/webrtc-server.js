import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DIST_DIR = path.resolve(__dirname, "../dist");
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const DEFAULT_HOST = process.env.HOST ?? "0.0.0.0";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export const createSignalingServer = ({
  distDir = DEFAULT_DIST_DIR,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
} = {}) => {
  const clients = new Map();
  const rooms = new Map();

  const parseRequestUrl = (req) => {
    const requestHost = req.headers.host ?? "localhost";
    return new URL(req.url ?? "/", `http://${requestHost}`);
  };

  const buildError = (message, code = 400) => ({
    type: "error",
    code,
    message,
  });

  const sendToClient = (clientId, data) => {
    const client = clients.get(clientId);
    if (!clientId || !client || client.readyState !== WebSocket.OPEN) {
      return false;
    }

    client.send(JSON.stringify(data));
    return true;
  };

  const isSocketOpen = (socketId) => {
    const client = clients.get(socketId);
    return Boolean(client && client.readyState === WebSocket.OPEN);
  };

  const getRoomOrReply = (socketId, roomId) => {
    if (!roomId) {
      sendToClient(socketId, buildError("roomId is required", 400));
      return null;
    }

    const room = rooms.get(roomId);
    if (!room) {
      sendToClient(socketId, buildError("room not exist", 404));
      return null;
    }

    return room;
  };

  const destroyRoom = (roomId, reason = "Room destroyed.") => {
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.participant) {
      sendToClient(room.participant, {
        type: "room-destroyed",
        roomId,
        message: reason,
      });
    }

    if (room.owner) {
      sendToClient(room.owner, {
        type: "room-destroyed",
        roomId,
        message: reason,
      });
    }

    rooms.delete(roomId);
  };

  const handleCreateRoom = ({ socketId, roomId }) => {
    let nextRoomId = roomId;
    if (!nextRoomId) {
      nextRoomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    }

    if (rooms.has(nextRoomId)) {
      sendToClient(socketId, buildError("roomId exist", 409));
      return;
    }

    rooms.set(nextRoomId, {
      owner: socketId,
      participant: null,
    });

    sendToClient(socketId, { type: "created-room", roomId: nextRoomId });
  };

  const handleJoinRoom = ({ socketId, roomId }) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.owner === socketId) {
      sendToClient(socketId, buildError("owner cannot join own room", 400));
      return;
    }

    if (!isSocketOpen(room.owner)) {
      rooms.delete(roomId);
      sendToClient(socketId, buildError("room owner offline", 410));
      return;
    }

    if (room.participant && room.participant !== socketId) {
      sendToClient(socketId, buildError("room is full", 409));
      return;
    }

    room.participant = socketId;

    sendToClient(room.owner, {
      type: "joined-room",
      roomId,
      participantId: socketId,
    });
  };

  const handleLeaveRoom = ({ socketId, roomId }, notifySelf = true) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.owner === socketId) {
      destroyRoom(roomId, "Room owner left the room.");
      return;
    }

    if (room.participant !== socketId) {
      sendToClient(socketId, buildError("client not in room", 403));
      return;
    }

    room.participant = null;

    sendToClient(room.owner, {
      type: "peer-left",
      roomId,
      participantId: socketId,
    });

    if (notifySelf) {
      sendToClient(socketId, {
        type: "left-room",
        roomId,
      });
    }
  };

  const handleDestroyRoom = ({ socketId, roomId }) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.owner !== socketId) {
      sendToClient(socketId, buildError("only room owner can destroy room", 403));
      return;
    }

    destroyRoom(roomId, "Room closed by owner.");
  };

  const handleOffer = ({ socketId, roomId, offer }) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.owner !== socketId) {
      sendToClient(socketId, buildError("only room owner can send offer", 403));
      return;
    }

    if (!room.participant) {
      sendToClient(socketId, buildError("room has no participant", 409));
      return;
    }

    sendToClient(room.participant, {
      type: "offer",
      roomId,
      offer,
    });
  };

  const handleAnswer = ({ socketId, roomId, answer }) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.participant !== socketId) {
      sendToClient(socketId, buildError("only room participant can send answer", 403));
      return;
    }

    sendToClient(room.owner, {
      type: "answer",
      roomId,
      answer,
    });
  };

  const handleCandidate = ({ socketId, roomId, candidate }) => {
    const room = getRoomOrReply(socketId, roomId);
    if (!room) {
      return;
    }

    if (room.owner === socketId) {
      if (!room.participant) {
        sendToClient(socketId, buildError("room has no participant", 409));
        return;
      }

      sendToClient(room.participant, {
        type: "candidate",
        roomId,
        candidate,
      });
      return;
    }

    if (room.participant !== socketId) {
      sendToClient(socketId, buildError("client not in room", 403));
      return;
    }

    sendToClient(room.owner, {
      type: "candidate",
      roomId,
      candidate,
    });
  };

  const handleChatMessage = ({ socketId, content, timestamp }) => {
    clients.forEach((client, clientId) => {
      if (clientId.startsWith("text-") && clientId !== socketId) {
        sendToClient(clientId, {
          type: "chat-message",
          content,
          timestamp,
          from: socketId,
          to: clientId,
        });
      }
    });
  };

  const handleMessage = (ws, socketId, rawMessage, isBinary) => {
    if (isBinary) {
      ws.close(1003, "binary messages are not supported");
      return;
    }

    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch {
      sendToClient(socketId, buildError("invalid json payload", 400));
      ws.close(1003, "invalid json payload");
      return;
    }

    if (!data || typeof data.type !== "string") {
      sendToClient(socketId, buildError("message type is required", 400));
      return;
    }

    const message = { ...data, socketId };

    switch (message.type) {
      case "chat-message":
        handleChatMessage(message);
        break;
      case "create-room":
        handleCreateRoom(message);
        break;
      case "join-room":
        handleJoinRoom(message);
        break;
      case "leave-room":
        handleLeaveRoom(message);
        break;
      case "destroy-room":
        handleDestroyRoom(message);
        break;
      case "offer":
        handleOffer(message);
        break;
      case "answer":
        handleAnswer(message);
        break;
      case "candidate":
        handleCandidate(message);
        break;
      case "heartbeat":
        break;
      default:
        sendToClient(socketId, buildError("unknown message type", 400));
        break;
    }
  };

  const handleSocketClosed = (socketId) => {
    clients.delete(socketId);

    for (const [roomId, room] of rooms.entries()) {
      if (room.owner === socketId) {
        destroyRoom(roomId, "Room owner disconnected, room destroyed.");
        continue;
      }

      if (room.participant === socketId) {
        handleLeaveRoom({ socketId, roomId }, false);
      }
    }
  };

  const safeResolve = (requestPath) => {
    const relativePath =
      requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
    const absolutePath = path.resolve(distDir, `.${relativePath}`);

    if (!absolutePath.startsWith(distDir)) {
      return null;
    }

    return absolutePath;
  };

  const sendFile = async (req, res, filePath) => {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(file);
  };

  const handleHttpRequest = async (req, res) => {
    const { pathname } = parseRequestUrl(req);

    if (pathname === "/ws") {
      res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Upgrade Required");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const requestedFile = safeResolve(pathname);
    if (!requestedFile) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    try {
      await sendFile(req, res, requestedFile);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (path.extname(pathname)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }

        const fallback = path.join(distDir, "index.html");
        try {
          await sendFile(req, res, fallback);
        } catch (fallbackError) {
          if (fallbackError.code === "ENOENT") {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Static assets not found. Run `npm run build` first.");
            return;
          }

          throw fallbackError;
        }
        return;
      }

      throw error;
    }
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      await handleHttpRequest(req, res);
    } catch (error) {
      console.error("failed to serve request", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = parseRequestUrl(req);
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const url = parseRequestUrl(req);
    const socketIdFromURL = url.searchParams.get("socketId");
    const socketId =
      socketIdFromURL ||
      `stream-${Math.random().toString(36).slice(2).toUpperCase()}${Date.now()}`;

    clients.set(socketId, ws);

    ws.on("close", () => handleSocketClosed(socketId));
    ws.on("error", (error) => {
      console.error("ws error", error);
    });
    ws.on("message", (message, isBinary) => {
      handleMessage(ws, socketId, message, isBinary);
    });
  });

  const start = () =>
    new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve(httpServer.address());
      });
    });

  const stop = () =>
    new Promise((resolve, reject) => {
      for (const socket of clients.values()) {
        socket.terminate();
      }

      wss.close((wssError) => {
        if (wssError) {
          reject(wssError);
          return;
        }

        httpServer.close((serverError) => {
          if (serverError) {
            reject(serverError);
            return;
          }

          resolve();
        });
      });
    });

  return {
    clients,
    host,
    httpServer,
    port,
    rooms,
    start,
    stop,
    wss,
  };
};

const isMainModule =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  const server = createSignalingServer();
  server
    .start()
    .then(() => {
      console.log(`signaling server listening on http://${server.host}:${server.port}`);
    })
    .catch((error) => {
      console.error("failed to start signaling server", error);
      process.exitCode = 1;
    });
}
