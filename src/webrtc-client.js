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

    // signaling server
    this.signalingServerUrl = signalingServerUrl;
    this.socket = null;
    this.isInitiator = false;

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
    await this.connectToSignalingServer();

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
  }

  connectToSignalingServer() {
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.signalingServerUrl);
        this.socket.onopen = () => {
          this.log("connected to signaling server");
          resolve();
        };
        // 使用箭头函数，确保this指向WebRTCClient实例
        this.socket.onmessage = (message) => this.handleSocketMessage(message);
        this.socket.onerror = (error) => {
          this.log("socket error");
        };
        this.socket.onclose = () => {
          this.log("disconnect from signaling server");
        };
      } catch (error) {
        this.log("failed to connect to signaling server");
        reject(error);
      }
    });
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
      this.peerConnection = null;
      this.sendToRemote({
        type: "destroy-room",
        roomId: this.roomId,
      });
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
  }

  async handleCandidate(data) {
    console.log("client handleCandidate", data);
    try {
      await this.peerConnection.addIceCandidate(
        new RTCIceCandidate(data.candidate),
      );
    } catch (error) {
      this.log("failed to add candidate");
    }
  }

  handleChatMessage(data) {
    console.log("handleChatMessage", data);
  }

  handleErrorMessage(data) {
    const roomIdInputTip = document.getElementById("roomIdInputTip");
    if (data.code === 404) {
      roomIdInputTip.textContent = "房间号不存在";
    }
  }

  handleSocketMessage(message) {
    const data = JSON.parse(message.data);
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

  createPeerConnection() {
    return new Promise((resolve, reject) => {
      try {
        this.peerConnection = new RTCPeerConnection(this.config);

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

        this.peerConnection.onIceGatheringStateChange = () => {
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
      initContainer.remove();
    }
    const screenStream = document.createElement("video");
    screenStream.id = "screenStream";
    screenStream.autoplay = true;
    document.body.appendChild(screenStream);
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

  getMediaStream() {
    return new Promise((resolve) => {
      navigator.mediaDevices
        .getDisplayMedia({
          video: { frameRate: 60, width: 1920, height: 1080 },
          audio: true,
        })
        .then((stream) => {
          this.showScreenStream();

          this.localStream = stream;
          this.onLocalStream(this.localStream);

          stream.getTracks().forEach((track) => {
            this.peerConnection.addTrack(track, stream);
          });

          resolve();
        })
        .catch(() => {
          this.log("failed to get media stream");
          reject();
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
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

const client = new WebRTCClient("/ws");
