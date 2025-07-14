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
  const { socketId, roomId } = data;
  if (rooms[roomId]) {
    if (!rooms[roomId].participators.includes(socketId)) {
      rooms[roomId].participators.push(socketId);

      // 其他客户端加入成功，给房间创建者发送 joined-room 消息，触发offer交换
      sendToClient(rooms[roomId].owner, {
        type: "joined-room",
      });
    }
  } else {
    sendToClient(socketId, { type: "error", message: "roomid not exist" });
  }
};

const handleLeaveRoom = (data) => {
  const { roomId, socketId } = data;
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
  if (clientId && client) {
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
  console.log("handleChatMessage", socketId);
  sendToAllClient({
    from: socketId,
    type: "message",
    data: data.data,
  });
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

wss.on("connection", (ws, req) => {
  console.log("wss connected");
  // const url = new URL(req.url, "ws://localhost");
  // const socketId = url.searchParams.get("socketId");

  const socketId = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.log({ socketId });

  clients.set(socketId, ws);

  ws.onopen = () => {
    console.log("ws open");
  };

  ws.onclose = () => {
    clients.delete(socketId);

    console.log("ws closed");
  };

  ws.onerror = (error) => {
    console.log("ws error", error);
  };

  ws.onmessage = (message) => handleMessage(socketId, message);
});
