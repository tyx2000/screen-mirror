import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createSignalingServer } from "../server/webrtc-server.js";

const createServer = async () => {
  const server = createSignalingServer({
    host: "127.0.0.1",
    port: 0,
  });

  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/ws`;

  return {
    server,
    url,
  };
};

const connectClient = async (baseUrl, socketId) => {
  const ws = new WebSocket(`${baseUrl}?socketId=${socketId}`);
  await once(ws, "open");
  return ws;
};

const nextMessage = (ws) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket message"));
    }, 2000);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };

    const handleMessage = (data, isBinary) => {
      cleanup();
      resolve({
        data: isBinary ? data : JSON.parse(data.toString()),
        isBinary,
      });
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const handleClose = (code, reason) => {
      cleanup();
      reject(new Error(`socket closed before message: ${code} ${reason.toString()}`));
    };

    ws.on("message", handleMessage);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  });

const closeClient = async (ws) => {
  if (
    ws.readyState === WebSocket.CLOSING ||
    ws.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  const closed = once(ws, "close");
  ws.close();
  await closed;
};

test("owner can create a room and one participant can join it", async () => {
  const { server, url } = await createServer();
  const owner = await connectClient(url, "owner");
  const guest = await connectClient(url, "guest");

  try {
    owner.send(JSON.stringify({ type: "create-room", roomId: "ABC123" }));

    const createdRoom = (await nextMessage(owner)).data;
    assert.deepEqual(createdRoom, {
      type: "created-room",
      roomId: "ABC123",
    });

    guest.send(JSON.stringify({ type: "join-room", roomId: "ABC123" }));

    const joinedRoom = (await nextMessage(owner)).data;
    assert.deepEqual(joinedRoom, {
      type: "joined-room",
      roomId: "ABC123",
      participantId: "guest",
    });

    assert.equal(server.rooms.get("ABC123")?.participant, "guest");
  } finally {
    await closeClient(guest);
    await closeClient(owner);
    await server.stop();
  }
});

test("a second participant cannot join a full room", async () => {
  const { server, url } = await createServer();
  const owner = await connectClient(url, "owner");
  const guest1 = await connectClient(url, "guest-1");
  const guest2 = await connectClient(url, "guest-2");

  try {
    owner.send(JSON.stringify({ type: "create-room", roomId: "ROOM01" }));
    await nextMessage(owner);

    guest1.send(JSON.stringify({ type: "join-room", roomId: "ROOM01" }));
    await nextMessage(owner);

    guest2.send(JSON.stringify({ type: "join-room", roomId: "ROOM01" }));
    const response = (await nextMessage(guest2)).data;

    assert.deepEqual(response, {
      type: "error",
      code: 409,
      message: "room is full",
    });
  } finally {
    await closeClient(guest2);
    await closeClient(guest1);
    await closeClient(owner);
    await server.stop();
  }
});

test("non-owners cannot destroy a room", async () => {
  const { server, url } = await createServer();
  const owner = await connectClient(url, "owner");
  const attacker = await connectClient(url, "attacker");

  try {
    owner.send(JSON.stringify({ type: "create-room", roomId: "SAFE01" }));
    await nextMessage(owner);

    attacker.send(JSON.stringify({ type: "destroy-room", roomId: "SAFE01" }));
    const response = (await nextMessage(attacker)).data;

    assert.deepEqual(response, {
      type: "error",
      code: 403,
      message: "only room owner can destroy room",
    });
    assert.equal(server.rooms.has("SAFE01"), true);
  } finally {
    await closeClient(attacker);
    await closeClient(owner);
    await server.stop();
  }
});

test("invalid candidate messages do not crash the server", async () => {
  const { server, url } = await createServer();
  const client = await connectClient(url, "owner");

  try {
    client.send(
      JSON.stringify({
        type: "candidate",
        roomId: "MISS01",
        candidate: { candidate: "abc" },
      }),
    );

    const errorResponse = (await nextMessage(client)).data;
    assert.deepEqual(errorResponse, {
      type: "error",
      code: 404,
      message: "room not exist",
    });

    client.send(JSON.stringify({ type: "create-room", roomId: "LIVE01" }));
    const createdRoom = (await nextMessage(client)).data;
    assert.deepEqual(createdRoom, {
      type: "created-room",
      roomId: "LIVE01",
    });
  } finally {
    await closeClient(client);
    await server.stop();
  }
});

test("invalid json payloads close only the offending socket", async () => {
  const { server, url } = await createServer();
  const validClient = await connectClient(url, "valid");
  const invalidClient = await connectClient(url, "invalid");

  try {
    invalidClient.send("{invalid json");

    const invalidMessage = (await nextMessage(invalidClient)).data;
    assert.deepEqual(invalidMessage, {
      type: "error",
      code: 400,
      message: "invalid json payload",
    });

    const [closeCode] = await once(invalidClient, "close");
    assert.equal(closeCode, 1003);

    validClient.send(JSON.stringify({ type: "create-room", roomId: "GOOD01" }));
    const createdRoom = (await nextMessage(validClient)).data;
    assert.deepEqual(createdRoom, {
      type: "created-room",
      roomId: "GOOD01",
    });
  } finally {
    await closeClient(validClient);
    await server.stop();
  }
});
