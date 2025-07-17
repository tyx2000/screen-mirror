import { WebSocketServer } from "ws";

const clients = new Map();
const rooms = {};

const wss = new WebSocketServer({ port: 8080 });

const handleCreateRoom = (data) => {
  console.log("create room", data);
  let { socketId, roomId } = data;
  if (!roomId) roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.log({ roomId });
  if (rooms[roomId]) {
    sendToClient(socketId, { type: "error", roomId, message: "roomId exist" });
  } else {
    rooms[roomId] = {
      owner: socketId,
      participators: [],
    };
    sendToClient(socketId, { type: "created-room", roomId });
  }
};

const handleJoinRoom = (data) => {
  console.log("join room");
  // todo 检查房间是否存在 检查owner socket链接是否open
  const { socketId, roomId } = data;
  if (rooms[roomId]) {
    if (!rooms[roomId].participators.includes(socketId)) {
      rooms[roomId].participators.push(socketId);

      // 其他客户端加入成功，给房间创建者发送 joined-room 消息，开始交换offer
      sendToClient(rooms[roomId].owner, {
        type: "joined-room",
      });
    }
  } else {
    sendToClient(socketId, {
      type: "error",
      code: 404,
      message: "roomid not exist",
    });
  }
};

const handleLeaveRoom = (data) => {
  const { roomId, socketId } = data;
};

const handleDestroyRoom = (data) => {
  console.log(data, rooms);
  const { roomId, socketId } = data;
  delete rooms[roomId];
  console.log(rooms);
};

// 处理房间创建者发送来的offer，转发给房间里的其他客户端
const handleOffer = (data) => {
  const { roomId, socketId, offer } = data;
  if (rooms[roomId]) {
    const { participators } = rooms[roomId];
    participators.forEach((client) => {
      sendToClient(client, {
        type: "offer",
        offer,
      });
    });
  } else {
    sendToClient(socketId, { type: "error", message: "room not exist" });
  }
};

// 创建者接收到其他客户端的answer
const handleAnswer = (data) => {
  const { roomId, socketId, answer } = data;
  if (rooms[roomId]) {
    const { owner } = rooms[roomId];
    sendToClient(owner, {
      type: "answer",
      answer,
    });
  } else {
    sendToClient(socketId, { type: "error", message: "room not exist" });
  }
};

const handleCandidate = (data) => {
  console.log("handleCandidate", data, rooms);
  const { roomId, isInitiator, candidate, socketId } = data;
  const { owner, participators } = rooms[roomId];
  if (isInitiator) {
    participators.forEach((client) => {
      sendToClient(client, { type: "candidate", candidate });
    });
  } else {
    sendToClient(owner, { type: "candidate", candidate });
  }
};

// 主动分享屏幕，开始交换 sdp
const handleShareScreen = (data) => {
  const { roomId, socketId } = data;
};

const sendToClient = (clientId, data) => {
  const client = clients.get(clientId);
  if (clientId && client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(data));
  } else {
    console.log("client not exist");
  }
};

const sendToAllClient = (data = {}) => {
  const content = {
    timestamp: Date.now(),
    from: "system",
    to: "all",
    type: "notification",
    data: wss.clients.size,
  };

  const message = { ...content, ...data };
  clients.keys().forEach((socketId) => {
    if (socketId !== message.from) {
      clients.get(socketId).send(JSON.stringify(message));
    }
  });
};

const handleChatMessage = (data) => {
  const { socketId } = data;
  console.log("handleChatMessage", data);

  clients.keys().forEach((clientId) => {
    if (clientId.startsWith("text-") && clientId !== socketId) {
      const client = clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "chat-message",
            content: data.content,
            timestamp: data.timestamp,
            from: socketId,
            to: clientId,
          }),
        );
      } else {
        console.log(`Client ${clientId} is not open or does not exist.`);
      }
    }
  });

  // sendToAllClient({
  //   from: socketId,
  //   type: "message",
  //   data: data.data,
  // });
};

const handleMessage = (socketId, message) => {
  const data = JSON.parse(message.data);
  const newData = { ...data, socketId };

  console.log("==>>>>>>>>", newData);

  switch (newData.type) {
    case "chat-message":
      handleChatMessage(newData);
      break;
    case "create-room":
      handleCreateRoom(newData);
      break;
    case "join-room":
      handleJoinRoom(newData);
      break;
    case "leave-room":
      handleLeaveRoom(newData);
      break;
    case "destroy-room":
      handleDestroyRoom(newData);
      break;
    case "offer":
      handleOffer(newData);
      break;
    case "answer":
      handleAnswer(newData);
      break;
    case "candidate":
      handleCandidate(newData);
      break;
    case "share-screen":
      handleShareScreen(newData);
      break;
    default:
      console.log("unknown message type");
      break;
  }
};

const handleSocketClosed = (socketId) => {
  console.log("socket closed", socketId);
  clients.delete(socketId);

  // 从房间中删除该客户端
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room.owner === socketId) {
      // 如果是房间创建者，删除整个房间，通知参与者会议结束
      room.participators.forEach((client) => {
        sendToClient(client, {
          type: "room-destroyed",
          message: "Room owner disconnected, room destroyed.",
        });
      });
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted due to owner disconnecting.`);
    } else {
      // 如果是参与者，从参与者列表中删除
      room.participators = room.participators.filter(
        (client) => client !== socketId,
      );
      console.log(`Client ${socketId} removed from room ${roomId}.`);
    }
  }
};

wss.on("connection", (ws, req) => {
  console.log("wss connected");
  const url = new URL(req.url, "ws://localhost");
  const socketIdFromURL = url.searchParams.get("socketId");

  const socketId =
    socketIdFromURL ||
    `stream-${Math.random().toString(36).slice(2).toUpperCase() + Date.now()}`;
  console.log({ socketId });

  clients.set(socketId, ws);

  ws.onopen = () => {
    console.log("ws open");
  };

  ws.onclose = () => handleSocketClosed(socketId);

  ws.onerror = (error) => {
    console.log("ws error", error);
  };

  ws.onmessage = (message) => handleMessage(socketId, message);
});
