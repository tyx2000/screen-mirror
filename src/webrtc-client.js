const WS_CLOSE_CODES = {
  INVALID_SIGNALING_RESPONSE: 3003,
};

class WebRTCClient {
  constructor(signalingServerUrl, options = {}) {
    this.roomId = null;
    this.mediaRecorder = null;
    // stun server conf
    this.config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
      sdpSemantics: "unified-plan",
    };

    // webrtc
    this.isMuted = true;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.dataChannel = null;
    this.pendingCandidates = [];

    // signaling server
    this.signalingServerUrl = signalingServerUrl;
    this.socket = null;
    this.isInitiator = false;
    this.connectedStamp = null;
    this.heartbeatTimer = null;
    this.connectionPromise = null;
    this.currentSignalingUrl = this.resolveSignalingServerUrl(
      this.signalingServerUrl,
    );
    this.isEndingShare = false;

    // callback
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onDataChannelMessage = options.onDataChannelMessage || (() => {});
    this.onConnectionStateChange =
      options.onConnectionStateChange || (() => {});
    this.onSignalingStateChange = options.onSignalingStateChange || (() => {});
    this.onIceConnectionStateChange =
      options.onIceConnectionStateChange || (() => {});
    this.onIceGatheringStateChange =
      options.onIceGatheringStateChange || (() => {});

    this.init();
  }

  log(text) {
    console.log("==== log ====", text);
  }

  generateRandomString() {
    return Math.random(18).toString(26).slice(2);
  }

  async init() {
    const createRoomBtn = document.getElementById("createRoom");
    const joinRoomBtn = document.getElementById("joinRoom");
    // const leaveRoomBtn = document.getElementById("leaveRoom");
    const roomIdInput = document.getElementById("roomIdInput");
    const roomIdInputTip = document.getElementById("roomIdInputTip");

    // const localVideo = document.getElementById("localVideo");
    // const remoteVideo = document.getElementById("remoteVideo");

    // const sendDataBtn = document.getElementById("sendData");

    // const screenShotBtn = document.getElementById("screenshot");
    // const recordScreenBtn = document.getElementById("recordScreen");
    // const stopRecordScreenBtn = document.getElementById("stopRecordScreen");

    // screenShotBtn.onclick = () =>
    //   this.captureScreenshot(this.isInitiator ? localVideo : remoteVideo);
    // stopRecordScreenBtn.onclick = () => {
    //   if (this.mediaRecorder) {
    //     this.mediaRecorder.stop();
    //   }
    // };

    // recordScreenBtn.onclick = () => this.recordScreen();

    // sendDataBtn.onclick = () => this.sendDataWithChannel(roomIdInput.value);

    // this.onLocalStream = (stream) => {
    //   localVideo.srcObject = stream;
    // };
    // this.onRemoteStream = (stream) => {
    //   remoteVideo.srcObject = stream;
    // };

    createRoomBtn.onclick = async () => {
      const connected = await this.ensureSocketConnected();
      if (!connected) {
        return;
      }

      this.isInitiator = true;
      this.sendToRemote({
        type: "create-room",
      });

      // await this.createPeerConnection();

      // 客户端 getMediaStream 在创建房间/加入房间后调用，可能导致媒体轨道添加冗余ice候选收集
      // 建议在createPeerConnection后立即添加媒体流
      // await this.getMediaStream();
    };

    joinRoomBtn.onclick = async () => {
      const connected = await this.ensureSocketConnected();
      if (!connected) {
        return;
      }

      this.isInitiator = false;
      this.roomId = roomIdInput.value;
      if (this.roomId) {
        roomIdInputTip.textContent = "";
        if (this.roomId.length < 6) {
          roomIdInputTip.textContent = "房间号不存在";
          return;
        } else {
          await this.createPeerConnection();

          this.showScreenStream();
          this.sendToRemote({
            type: "join-room",
          });
        }
      } else {
        roomIdInputTip.textContent = "请输入房间号";
        return;
      }
    };

    // leaveRoomBtn.onclick = () => {};

    const sendSocketMessageButton =
      document.getElementById("sendSocketMessage");
    sendSocketMessageButton.onclick = async () => {
      const connected = await this.ensureSocketConnected();
      if (!connected) {
        return;
      }

      this.sendToRemote({
        type: "chat-message",
        content: "hello world " + new Date().toISOString(),
        timestamp: Date.now(),
      });
    };

    this.connectToSignalingServer().catch((error) => {
      this.log(`failed to connect to signaling server: ${error.message}`);
    });

    this.setConnectionTarget(`signaling server: ${this.currentSignalingUrl}`);
  }

  connectToSignalingServer() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const signalingUrl = this.currentSignalingUrl;
    this.setConnectionStatus(`connecting ${signalingUrl}`);
    this.setConnectionTarget(`signaling server: ${signalingUrl}`);

    this.connectionPromise = new Promise((resolve, reject) => {
      let settled = false;

      const finalize = (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        this.connectionPromise = null;
        callback();
      };

      try {
        this.socket = new WebSocket(signalingUrl);
        this.socket.onopen = () => {
          finalize(() => {
            this.log("connected to signaling server");
            this.setConnectionStatus("connected");
            this.setConnectionTarget(`signaling server: ${signalingUrl}`);
            this.connectedStamp = Date.now();

            this.heartbeatTimer = setInterval(() => {
              this.sendToRemote({
                type: "heartbeat",
                timestamp: Date.now(),
              });
            }, 40000);

            const reconnectionButton =
              document.getElementById("reconnectionButton");
            reconnectionButton && reconnectionButton.remove();

            resolve();
          });
        };
        // 使用箭头函数，确保this指向WebRTCClient实例
        this.socket.onmessage = (message) => this.handleSocketMessage(message);
        this.socket.onerror = () => {
          this.log("socket error");
          if (settled) {
            return;
          }
          this.setConnectionStatus("failed to connect");
          this.setConnectionTarget(
            `signaling server: ${signalingUrl} | check local server on 8080`,
          );
          finalize(() => reject(new Error("socket error")));
        };
        this.socket.onclose = () => {
          // todo 自动重连
          document.title = "Screen Mirror";
          const disconnectedDuration =
            typeof this.connectedStamp === "number"
              ? `disconnected after ${(Date.now() - this.connectedStamp) / 1000}s`
              : "disconnected";
          this.setConnectionStatus(disconnectedDuration);
          this.setConnectionTarget(`signaling server: ${signalingUrl}`);
          this.connectedStamp = null;
          this.socket = null;
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
          }
          this.log("disconnect from signaling server");

          const reconnectionButton = document.createElement("button");
          reconnectionButton.id = "reconnectionButton";
          reconnectionButton.textContent = "Reconnect";
          reconnectionButton.onclick = async () => {
            reconnectionButton.remove();
            await this.connectToSignalingServer();
          };
          document.body.appendChild(reconnectionButton);

          finalize(() => reject(new Error("socket closed before ready")));
        };
      } catch (error) {
        this.log("failed to connect to signaling server");
        this.setConnectionStatus("failed to connect");
        this.setConnectionTarget(
          `signaling server: ${signalingUrl} | check local server on 8080`,
        );
        this.connectionPromise = null;
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  sendToRemote(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          ...data,
          roomId: this.roomId,
        }),
      );
    } else {
      this.log("signaling server error");
    }
  }

  async handleCreatedRoom(data) {
    this.roomId = data.roomId;
    document.title = this.roomId;

    try {
      await this.createPeerConnection();
      await this.getMediaStream();
    } catch (error) {
      this.resetPeerConnection();
      this.sendToRemote({
        type: "destroy-room",
        roomId: this.roomId,
      });
      this.roomId = null;
    }
  }

  async createOffer() {
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.sendToRemote({
        type: "offer",
        offer: this.peerConnection.localDescription,
      });
    } catch (error) {
      this.log("failed to create of set offer");
    }
  }

  async createAnswer() {
    try {
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.sendToRemote({
        type: "answer",
        answer: this.peerConnection.localDescription,
      });
    } catch (error) {
      this.log("failed to create or set answer");
    }
  }

  async handleJoinedRoom() {
    console.log("joined room");
    // 其他客户端成功加入房间，创建者与其他客户端交换 offer

    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.sendToRemote({
        type: "offer",
        offer: this.peerConnection.localDescription,
      });
    } catch (error) {
      this.log("failed to create of set offer");
    }
  }

  // 加入房间的客户端处理房间创建者发送来的offer，交换answer
  async handleOffer(data) {
    console.log("handle offer", data);

    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.offer),
    );
    await this.flushPendingCandidates();

    try {
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.sendToRemote({
        type: "answer",
        answer: this.peerConnection.localDescription,
      });
    } catch (error) {
      this.log("failed to create or set answer");
    }
  }

  // 创建者处理其他客户端的 answer
  async handleAnswer(data) {
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.answer),
    );
    await this.flushPendingCandidates();
  }

  async handleCandidate(data) {
    console.log("client handleCandidate", data);
    if (!this.peerConnection) {
      return;
    }

    if (!this.peerConnection.remoteDescription) {
      this.pendingCandidates.push(data.candidate);
      return;
    }

    await this.addIceCandidate(data.candidate);
  }

  handleChatMessage(data) {
    console.log("handleChatMessage", data);
  }

  handleErrorMessage(data) {
    const roomIdInputTip = document.getElementById("roomIdInputTip");
    const errorMessageMap = {
      404: "房间号不存在",
      409: "房间不可用",
      410: "房主已离线",
    };
    roomIdInputTip.textContent = errorMessageMap[data.code] || data.message;

    if (!this.isInitiator && [404, 409, 410].includes(data.code)) {
      this.handleRoomDestroyed();
    }
  }

  async handlePeerLeft() {
    if (!this.isInitiator || !this.localStream) {
      return;
    }

    this.resetPeerConnection();
    await this.createPeerConnection();
    this.attachLocalTracks(this.localStream);
  }

  handleRoomDestroyed() {
    this.isEndingShare = false;
    this.roomId = null;
    this.resetPeerConnection();
    this.resetMediaState();
    this.handleStreamEnded();
  }

  handleSocketMessage(message) {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      this.log(`unexpected non-JSON message: ${message.data}`);
      this.setConnectionStatus(
        "invalid signaling server response, check ws://127.0.0.1:8080",
      );
      this.setConnectionTarget(
        `received text frame "${message.data}" from ${this.currentSignalingUrl}`,
      );
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(
          WS_CLOSE_CODES.INVALID_SIGNALING_RESPONSE,
          "invalid signaling server response",
        );
      }
      return;
    }

    console.log("handleSocketMessage", data);
    switch (data.type) {
      case "chat-message":
        this.handleChatMessage(data);
        break;
      case "created-room":
        this.handleCreatedRoom(data);
        break;
      case "joined-room":
        this.handleJoinedRoom();
        break;
      case "peer-left":
        this.handlePeerLeft();
        break;
      case "left-room":
        this.handleRoomDestroyed();
        break;
      case "room-destroyed":
        this.handleRoomDestroyed();
        break;
      case "offer":
        this.handleOffer(data);
        break;
      case "answer":
        this.handleAnswer(data);
        break;
      case "candidate":
        this.handleCandidate(data);
        break;
      case "error":
        this.handleErrorMessage(data);
        console.log(data.message);
    }
  }

  resolveSignalingServerUrl(signalingServerUrl) {
    if (/^wss?:\/\//.test(signalingServerUrl)) {
      return signalingServerUrl;
    }

    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${window.location.host}${signalingServerUrl}`;
    }

    return `ws://127.0.0.1:8080${signalingServerUrl}`;
  }

  async ensureSocketConnected() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return true;
    }

    try {
      await this.connectToSignalingServer();
      return true;
    } catch (error) {
      this.log(`unable to connect: ${error.message}`);
      this.setConnectionStatus("unable to connect, start signaling server on 8080");
      this.setConnectionTarget(`signaling server: ${this.currentSignalingUrl}`);
      return false;
    }
  }

  setConnectionStatus(text) {
    const connectionStatus = document.getElementById("connectionStatus");
    if (connectionStatus) {
      connectionStatus.textContent = text;
    }
  }

  setConnectionTarget(text) {
    const connectionTarget = document.getElementById("connectionTarget");
    if (connectionTarget) {
      connectionTarget.textContent = text;
    }
  }

  createPeerConnection() {
    return new Promise((resolve, reject) => {
      try {
        this.resetPeerConnection();
        this.peerConnection = new RTCPeerConnection(this.config);
        this.pendingCandidates = [];

        this.peerConnection.onicecandidate = (event) => {
          console.log("onicecandidate", this.isInitiator, event);
          if (event.candidate) {
            this.sendToRemote({
              type: "candidate",
              isInitiator: this.isInitiator,
              candidate: event.candidate,
            });
          }
        };

        this.peerConnection.ontrack = (event) => {
          this.log("peerconnection ontrack");
          this.remoteStream = event.streams[0];
          this.onRemoteStream(this.remoteStream);

          if (this.remoteStream) {
            this.remoteStream.oninactive = () => {
              this.handleRemoteStreamEnded();
            };
          }

          // 接收远端stream被中断
          event.track.onended = () => {
            this.handleRemoteStreamEnded();
          };
        };

        if (this.isInitiator) {
          this.dataChannel = this.peerConnection.createDataChannel("chat");
          this.setupDataChannel(this.dataChannel);
        } else {
          this.peerConnection.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this.setupDataChannel(this.dataChannel);
          };
        }

        this.peerConnection.onconnectionstatechange = () => {
          this.log(`peerconnect state: ${this.peerConnection.connectionState}`);
          this.onConnectionStateChange(this.peerConnection.connectionState);
        };

        this.peerConnection.onsignalingstatechange = () => {
          this.log(`signaling state: ${this.peerConnection.signalingState}`);
          this.onSignalingStateChange(this.peerConnection.signalingState);
        };

        this.peerConnection.oniceconnectionstatechange = () => {
          this.log(
            `ice connection state: ${this.peerConnection.iceConnectionState}`,
          );
          this.onIceConnectionStateChange(
            this.peerConnection.iceConnectionState,
          );
        };

        this.peerConnection.onicegatheringstatechange = () => {
          this.log(
            `ice gathering state: ${this.peerConnection.iceGatheringState}`,
          );
          this.onIceGatheringStateChange(this.peerConnection.iceGatheringState);
        };

        resolve();
      } catch (error) {
        this.log(`failed to create RTCPeerConnection`);
        reject(error);
      }
    });
  }

  setupDataChannel(channel) {
    channel.onopen = () => {
      this.log("data channel opened");
    };
    channel.onclose = () => {
      this.log("data channel closed");
    };
    channel.onmessage = (message) => {
      console.log("dataChannel onmessage", message);
      this.onDataChannelMessage(message.data);
    };
    channel.onerror = (error) => {
      this.log("data channel error");
    };
  }

  sendDataWithChannel(message) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(message);
    } else {
      this.log("data channel is not open");
    }
  }

  // 分别获取用户视频流/音频流，设备视频流/音频流
  // 分别备注 track.label 添加到同一peerConnection
  async getUserAudioStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (error) {}
  }

  showScreenStream() {
    const initContainer = document.getElementById("initContainer");
    if (initContainer) {
      initContainer.style.display = "none";
    }
    let screenStream = document.getElementById("screenStream");
    if (!screenStream) {
      screenStream = document.createElement("video");
      screenStream.id = "screenStream";
      screenStream.autoplay = true;
      document.body.appendChild(screenStream);
    }
    if (this.isInitiator) {
      this.onLocalStream = (stream) => {
        screenStream.srcObject = stream;
      };
    } else {
      this.onRemoteStream = (stream) => {
        screenStream.srcObject = stream;
      };
    }
  }

  // 发起者分享被中断
  handleStreamEnded() {
    document.title = "Screen Mirror";
    const initContainer = document.getElementById("initContainer");
    const screenStream = document.getElementById("screenStream");
    if (initContainer) {
      initContainer.style.display = "flex";
    }
    if (screenStream) {
      screenStream.srcObject = null;
      screenStream.remove();
    }
  }

  async handleLocalShareEnded() {
    if (this.isEndingShare || !this.isInitiator) {
      return;
    }

    const localStream = this.localStream;
    if (!localStream) {
      return;
    }

    const hasActiveTracks = localStream
      .getTracks()
      .some((track) => track.readyState !== "ended");
    if (hasActiveTracks) {
      return;
    }

    this.isEndingShare = true;

    if (this.roomId && this.socket?.readyState === WebSocket.OPEN) {
      this.sendToRemote({
        type: "destroy-room",
        roomId: this.roomId,
      });
    }

    this.handleRoomDestroyed();
  }

  handleRemoteStreamEnded() {
    if (this.isInitiator) {
      return;
    }

    this.handleRoomDestroyed();
  }

  getMediaStream() {
    return new Promise((resolve, reject) => {
      navigator.mediaDevices
        .getDisplayMedia({
          video: { frameRate: 60, width: 1920, height: 1080 },
          audio: true,
        })
        .then((stream) => {
          this.showScreenStream();

          this.localStream = stream;
          this.localStream.oninactive = () => {
            this.handleLocalShareEnded();
          };
          this.onLocalStream(this.localStream);

          this.attachLocalTracks(stream);

          stream.onaddtrack = () => {};
          stream.onremovetrack = () => {};

          resolve();
        })
        .catch((error) => {
          this.log("failed to get media stream");
          reject(error);
        });
    });
  }

  async switchMediaStream(newStream) {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
    this.localStream = newStream;

    const senders = this.peerConnection.getSenders();
    newStream.getTracks().forEach((track, index) => {
      if (senders[index]) {
        senders[index].replaceTrack(track);
      }
    });
  }

  captureScreenshot(videoEl) {
    const dpr = window.devicePixelRatio || 1;
    const { width, height, videoWidth, videoHeight } = videoEl;

    if (!videoWidth || !videoHeight) {
      this.log("video is loading, wait");
      return;
    }
    const canvas = document.createElement("canvas");

    const objectFit = getComputedStyle(videoEl).objectFit;
    const containerRatio = width / height;
    const videoRatio = videoWidth / videoHeight;
    let displayWidth = width,
      displayHeight = height;

    if (objectFit === "contain") {
      if (videoRatio > containerRatio) {
        displayWidth = width;
        displayHeight = width / videoRatio;
      } else {
        displayHeight = height;
        displayWidth = height * videoRatio;
      }
    } else if (objectFit === "cover") {
      if (videoRatio > containerRatio) {
        displayHeight = height;
        displayWidth = height * videoRatio;
      } else {
        displayWidth = width;
        displayHeight = width / videoRatio;
      }
    }

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = displayWidth + "px";
    canvas.style.height = displayHeight + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      videoEl,
      0,
      0,
      videoWidth,
      videoHeight,
      0,
      0,
      displayWidth,
      displayHeight,
    );

    canvas.toBlob(
      (blob) => {
        const imageUrl = URL.createObjectURL(blob);
        this.downloadFile(
          imageUrl,
          `screenshot-${new Date().toISOString()}.png`,
        );
      },
      "image/png",
      1.0,
    );
  }

  captureWithWebGL() {}

  recordScreen() {
    const mimeType = "video/webm; codecs=vp8";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      this.log("browser dont support webm");
      return;
    }
    let recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(this.localStream, {
      mimeType,
      bitsPerSecond: 2500000,
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.start(1000);

    this.mediaRecorder.onstart = () => {
      this.log("start recording");
    };
    this.mediaRecorder.onstop = () => {
      const videoBlob = new Blob(recordedChunks, { type: "video/webm" });
      const videoUrl = URL.createObjectURL(videoBlob);

      this.downloadFile(
        videoUrl,
        `conference-${new Date().toISOString()}.webm`,
      );

      recordedChunks = [];
      this.mediaRecorder = null;
    };
  }

  downloadFile(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
  }

  async closeConnection() {
    this.resetPeerConnection();
    this.resetMediaState();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  attachLocalTracks(stream) {
    stream.getTracks().forEach((track) => {
      this.peerConnection.addTrack(track, stream);

      track.onended = () => this.handleLocalShareEnded();
      track.onmute = () => {};
      track.onunmute = () => {};
    });
  }

  async addIceCandidate(candidate) {
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      this.log("failed to add candidate");
    }
  }

  async flushPendingCandidates() {
    if (!this.peerConnection?.remoteDescription) {
      return;
    }

    const pendingCandidates = [...this.pendingCandidates];
    this.pendingCandidates = [];

    for (const candidate of pendingCandidates) {
      await this.addIceCandidate(candidate);
    }
  }

  resetPeerConnection() {
    this.pendingCandidates = [];

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  resetMediaState() {
    if (this.localStream) {
      this.localStream.oninactive = null;
      this.localStream.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.onunmute = null;
        track.stop();
      });
      this.localStream = null;
    }

    if (this.remoteStream) {
      this.remoteStream.oninactive = null;
      this.remoteStream.getTracks().forEach((track) => {
        track.onended = null;
      });
    }

    this.remoteStream = null;
  }
}

const client = new WebRTCClient("/ws");
