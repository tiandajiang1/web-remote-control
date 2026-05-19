const $ = id => document.getElementById(id);

const state = {
  token: localStorage.getItem("remote-token") || "",
  room: localStorage.getItem("remote-room") || "main",
  pc: null,
  stream: null,
  pollTimer: null,
  lastSignalId: 0
};

$("hostToken").value = state.token;
$("room").value = state.room;

function setHostStatus(text, ok = true) {
  const el = $("hostStatus");
  el.textContent = text;
  el.className = ok ? "ok" : "bad";
}

function log(text) {
  const el = $("hostLog");
  el.value += `${new Date().toLocaleTimeString()}  ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    "x-remote-token": state.token,
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function sendSignal(type, data) {
  await api("/api/signal/send", {
    method: "POST",
    body: JSON.stringify({ room: state.room, from: "host", type, data })
  });
}

function createPeer() {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  pc.onicecandidate = event => {
    if (event.candidate) sendSignal("candidate", event.candidate).catch(error => log(error.message));
  };
  pc.onconnectionstatechange = () => {
    log(`peer ${pc.connectionState}`);
    setHostStatus(`WebRTC ${pc.connectionState}`, pc.connectionState !== "failed");
  };
  state.stream.getTracks().forEach(track => {
    track.contentHint = "detail";
    const sender = pc.addTrack(track, state.stream);
    tuneSender(sender);
  });
  return pc;
}

function tuneSender(sender) {
  const params = sender.getParameters();
  params.degradationPreference = "maintain-resolution";
  params.encodings = [{
    ...(params.encodings?.[0] || {}),
    maxBitrate: 9_000_000,
    maxFramerate: 10,
    scaleResolutionDownBy: 1
  }];
  return sender.setParameters(params).catch(error => log(`sender ${error.message}`));
}

function retuneSenders() {
  state.pc?.getSenders()
    .filter(sender => sender.track?.kind === "video")
    .forEach(sender => tuneSender(sender));
}

async function handleSignal(message) {
  if (message.type === "offer") {
    state.pc?.close();
    state.pc = createPeer();
    await state.pc.setRemoteDescription(message.data);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await sendSignal("answer", state.pc.localDescription);
    retuneSenders();
    setInterval(retuneSenders, 2000);
    log("answer sent");
  } else if (message.type === "candidate" && state.pc) {
    await state.pc.addIceCandidate(message.data).catch(error => log(`candidate ${error.message}`));
  }
}

async function pollSignals() {
  if (!state.stream) return;
  try {
    const data = await api(`/api/signal/poll?room=${encodeURIComponent(state.room)}&role=host&after=${state.lastSignalId}`);
    for (const message of data.messages) {
      state.lastSignalId = Math.max(state.lastSignalId, message.id);
      await handleSignal(message);
    }
  } catch (error) {
    log(error.message);
  } finally {
    state.pollTimer = setTimeout(pollSignals, 250);
  }
}

async function startHost() {
  state.token = $("hostToken").value.trim();
  state.room = $("room").value.trim() || "main";
  localStorage.setItem("remote-token", state.token);
  localStorage.setItem("remote-room", state.room);

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前浏览器不支持屏幕共享，请用系统 Chrome/Edge 打开 Host 页");
  }

  state.stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 10, max: 10 },
      width: { ideal: 2560 },
      height: { ideal: 1600 },
      cursor: "always"
    },
    audio: false
  });
  state.stream.getVideoTracks().forEach(track => {
    track.contentHint = "detail";
  });
  $("preview").srcObject = state.stream;
  state.stream.getVideoTracks()[0].onended = stopHost;
  setHostStatus("正在共享", true);
  log("screen shared");
  clearTimeout(state.pollTimer);
  pollSignals();
}

function stopHost() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pc?.close();
  state.pc = null;
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  $("preview").srcObject = null;
  setHostStatus("已停止", false);
}

$("startHost").addEventListener("click", () => startHost().catch(error => {
  const message = error.name === "NotAllowedError" || error.message === "Permission denied"
    ? "屏幕共享权限被拒，请在系统 Chrome/Edge 打开 Host 页并选择整个屏幕"
    : error.message;
  setHostStatus(message, false);
  log(message);
}));
$("stopHost").addEventListener("click", stopHost);
