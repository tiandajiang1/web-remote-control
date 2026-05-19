const $ = id => document.getElementById(id);

const state = {
  token: localStorage.getItem("remote-token") || "",
  channel: localStorage.getItem("remote-channel") || "http",
  connected: false,
  timer: null,
  streamTimer: null,
  streamSeq: 0,
  streaming: false,
  streamController: null,
  currentFrameUrl: "",
  rtc: null,
  rtcLastSignalId: 0,
  rtcPollTimer: null,
  rtcConnected: false,
  useWebRtc: false,
  lastFrameMs: 0,
  qualityMode: localStorage.getItem("remote-quality-mode") || "fast",
  traffic: {
    totalBytes: 0,
    samples: [],
    frames: 0,
    startedAt: 0
  },
  lastMouse: { x: 0, y: 0 },
  mouseQueue: null,
  mouseSending: false,
  lastMouseSentAt: 0,
  screen: { width: 0, height: 0, scale: 1 },
  serial: {
    port: null,
    writer: null,
    reader: null,
    readableClosed: null
  }
};

$("token").value = state.token;
$("channel").value = state.channel;
$("qualityMode").textContent = qualityModeLabel();

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.className = ok ? "ok" : "bad";
}

function qualityModeLabel() {
  if (state.qualityMode === "ultra") return "高带宽";
  if (state.qualityMode === "clear") return "清晰";
  return "流畅";
}

function fitScreen() {
  const img = state.rtcConnected ? $("webrtcVideo") : $("screen");
  const wrap = $("screenWrap");
  const remoteWidth = Number(img.dataset.width || img.videoWidth || state.screen.width || 0);
  const remoteHeight = Number(img.dataset.height || img.videoHeight || state.screen.height || 0);
  if (!remoteWidth || !remoteHeight) return;

  const availableWidth = wrap.clientWidth;
  const availableHeight = wrap.clientHeight;
  if (!availableWidth || !availableHeight) return;

  const scale = Math.min(availableWidth / remoteWidth, availableHeight / remoteHeight);
  const displayWidth = Math.max(1, Math.floor(remoteWidth * scale));
  const displayHeight = Math.max(1, Math.floor(remoteHeight * scale));

  state.screen = { width: remoteWidth, height: remoteHeight, scale };
  img.style.width = `${displayWidth}px`;
  img.style.height = `${displayHeight}px`;
}

async function sendSignal(type, data) {
  await api("/api/signal/send", {
    method: "POST",
    body: JSON.stringify({ room: "main", from: "viewer", type, data })
  });
}

function stopWebRtc() {
  clearTimeout(state.rtcPollTimer);
  state.rtcPollTimer = null;
  state.rtc?.close();
  state.rtc = null;
  state.rtcConnected = false;
  $("webrtcVideo").srcObject = null;
  $("webrtcVideo").style.display = "none";
}

async function pollRtcSignals() {
  if (!state.rtc) return;
  try {
    const data = await api(`/api/signal/poll?room=main&role=viewer&after=${state.rtcLastSignalId}`);
    for (const message of data.messages) {
      state.rtcLastSignalId = Math.max(state.rtcLastSignalId, message.id);
      if (message.type === "answer") {
        await state.rtc.setRemoteDescription(message.data);
      } else if (message.type === "candidate") {
        await state.rtc.addIceCandidate(message.data).catch(() => {});
      }
    }
  } finally {
    state.rtcPollTimer = setTimeout(pollRtcSignals, 250);
  }
}

async function startWebRtc() {
  stopStream();
  stopWebRtc();
  const video = $("webrtcVideo");
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  state.rtc = pc;
  state.rtcLastSignalId = 0;

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.onicecandidate = event => {
    if (event.candidate) sendSignal("candidate", event.candidate).catch(() => {});
  };
  pc.ontrack = event => {
    video.srcObject = event.streams[0];
    event.track.contentHint = "detail";
    video.style.display = "block";
    $("screen").style.display = "none";
    $("empty").style.display = "none";
    state.rtcConnected = true;
    setStatus(`${state.screen.width} x ${state.screen.height} / WebRTC detail`, true);
    video.onloadedmetadata = fitScreen;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus("WebRTC 断开，回退截图", false);
      stopWebRtc();
      startLowLatencyStream();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal("offer", pc.localDescription);
  pollRtcSignals();
  setStatus("等待 Host WebRTC 应答", true);

  setTimeout(() => {
    if (!state.rtcConnected && state.rtc === pc) {
      setStatus("没有 WebRTC Host，回退截图", false);
      stopWebRtc();
      startLowLatencyStream();
    }
  }, 5000);
}

function logSerial(text) {
  const log = $("serialLog");
  const time = new Date().toLocaleTimeString();
  log.value = `${log.value}${time}  ${text}\n`;
  log.scrollTop = log.scrollHeight;
}

function selectedChannel() {
  state.channel = $("channel").value;
  localStorage.setItem("remote-channel", state.channel);
  return state.channel;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatTraffic(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function resetTraffic() {
  state.traffic = {
    totalBytes: 0,
    samples: [],
    frames: 0,
    startedAt: performance.now()
  };
  updateTraffic();
}

function recordTraffic(bytes, elapsedMs = 0) {
  const now = performance.now();
  state.traffic.totalBytes += bytes;
  state.traffic.frames += 1;
  state.traffic.samples.push({ at: now, bytes, elapsedMs });
  const cutoff = now - 3000;
  state.traffic.samples = state.traffic.samples.filter(sample => sample.at >= cutoff);
  updateTraffic();
}

function updateTraffic() {
  const el = $("traffic");
  if (!el) return;
  const samples = state.traffic.samples;
  const now = performance.now();
  const windowMs = samples.length > 1 ? Math.max(250, now - samples[0].at) : 1000;
  const recentBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const recentMs = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
  const rate = recentBytes / (windowMs / 1000);
  const fps = samples.length / (windowMs / 1000);
  const avgLatency = samples.length ? Math.round(recentMs / samples.length) : 0;
  el.textContent = `流量 ${formatTraffic(rate)}/s | 累计 ${formatTraffic(state.traffic.totalBytes)} | ${fps.toFixed(1)}fps | ${avgLatency}ms`;
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    "x-remote-token": state.token,
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function downloadUrl(filePath) {
  const params = new URLSearchParams({
    path: filePath,
    token: state.token
  });
  return `/api/download?${params.toString()}`;
}

async function loadFiles(pathValue = $("filePath").value) {
  state.token = $("token").value.trim();
  localStorage.setItem("remote-token", state.token);
  const params = new URLSearchParams();
  if (pathValue) params.set("path", pathValue);
  const data = await api(`/api/files?${params.toString()}`);
  $("filePath").value = data.path;
  $("fileList").replaceChildren(...data.entries.map(entry => {
    const row = document.createElement("button");
    row.className = "file-row";
    row.type = "button";
    const icon = entry.type === "dir" ? "DIR" : "FILE";
    const meta = entry.type === "dir" ? "" : formatSize(entry.size);
    row.innerHTML = `<span>${icon}</span><span title="${entry.path}"></span><small>${meta}</small>`;
    row.children[1].textContent = entry.name;
    row.addEventListener("click", () => {
      if (entry.type === "dir") {
        loadFiles(entry.path).catch(error => setStatus(error.message, false));
      } else {
        window.open(downloadUrl(entry.path), "_blank");
      }
    });
    return row;
  }));
  $("parentDir").dataset.path = data.parent;
}

async function serialWrite(command) {
  if (!state.serial.writer) throw new Error("串口未连接");
  const line = `${JSON.stringify(command)}\n`;
  await state.serial.writer.write(new TextEncoder().encode(line));
  logSerial(`TX ${line.trim()}`);
}

async function startSerialReadLoop() {
  const decoder = new TextDecoderStream();
  state.serial.readableClosed = state.serial.port.readable.pipeTo(decoder.writable);
  state.serial.reader = decoder.readable.getReader();

  let buffer = "";
  try {
    while (true) {
      const { value, done } = await state.serial.reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.filter(Boolean).forEach(line => logSerial(`RX ${line}`));
    }
  } catch (error) {
    logSerial(`RX 错误: ${error.message}`);
  }
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    setStatus("当前浏览器不支持 Web Serial，请用 Chrome/Edge", false);
    return;
  }

  const baudRate = Number($("baud").value);
  state.serial.port = await navigator.serial.requestPort();
  await state.serial.port.open({ baudRate });
  state.serial.writer = state.serial.port.writable.getWriter();
  startSerialReadLoop();
  setStatus(`串口已连接 ${baudRate}`, true);
  logSerial(`OPEN baud=${baudRate}`);
}

async function disconnectSerial() {
  try {
    state.serial.reader?.cancel();
    state.serial.reader?.releaseLock();
    state.serial.writer?.releaseLock();
    await state.serial.readableClosed?.catch(() => {});
    await state.serial.port?.close();
  } finally {
    state.serial = { port: null, writer: null, reader: null, readableClosed: null };
    setStatus("串口已断开", true);
    logSerial("CLOSE");
  }
}

async function refreshScreen() {
  if (!state.connected) return;
  try {
    const wrapWidth = $("screenWrap").clientWidth || window.innerWidth;
    const targetWidth = Math.max(520, Math.min(1100, Math.round(wrapWidth * Math.min(window.devicePixelRatio, 1.5))));
    const data = await api(`/api/screenshot?w=${targetWidth}&q=52`);
    const img = $("screen");
    img.src = `data:image/${data.format || "jpeg"};base64,${data.image}`;
    img.dataset.width = data.width;
    img.dataset.height = data.height;
    img.dataset.imageWidth = data.imageWidth || data.width;
    img.dataset.imageHeight = data.imageHeight || data.height;
    img.style.display = "block";
    $("empty").style.display = "none";
    fitScreen();
    setStatus(`${data.width} x ${data.height} / ${data.imageWidth || data.width}px Q52`, true);
  } catch (error) {
    setStatus(error.message, false);
  }
}

function stopStream() {
  clearTimeout(state.streamTimer);
  state.streamTimer = null;
  state.streaming = false;
  state.streamController?.abort();
  state.streamController = null;
  state.streamSeq++;
}

function streamParams() {
  const wrapWidth = $("screenWrap").clientWidth || window.innerWidth;
  if (state.qualityMode === "ultra") {
    const targetWidth = Math.max(1200, Math.min(1800, Math.round(wrapWidth * Math.min(window.devicePixelRatio, 2))));
    return { targetWidth, quality: 68, fps: 8 };
  }
  if (state.qualityMode === "clear") {
    const targetWidth = Math.max(900, Math.min(1360, Math.round(wrapWidth * Math.min(window.devicePixelRatio, 1.5))));
    return { targetWidth, quality: 48, fps: 5 };
  }
  const targetWidth = Math.max(500, Math.min(640, Math.round(wrapWidth * Math.min(window.devicePixelRatio, 0.9))));
  return { targetWidth, quality: 30, fps: 8 };
}

function nextFrameDelay(loadMs) {
  if (loadMs > 1200) return 450;
  if (loadMs > 700) return 250;
  return 90;
}

function requestStreamFrame() {
  if (!state.connected || state.streaming) return;
  state.streaming = true;

  const img = $("screen");
  const wrapWidth = $("screenWrap").clientWidth || window.innerWidth;
  const targetWidth = Math.max(520, Math.min(1100, Math.round(wrapWidth * Math.min(window.devicePixelRatio, 1.35))));
  const quality = targetWidth > 900 ? 40 : 44;
  const started = performance.now();
  const seq = ++state.streamSeq;

  img.onload = () => {
    if (seq !== state.streamSeq) return;
    state.lastFrameMs = Math.round(performance.now() - started);
    img.style.display = "block";
    $("empty").style.display = "none";
    fitScreen();
    state.streaming = false;
    setStatus(`${state.screen.width} x ${state.screen.height} / ${targetWidth}px Q${quality} / ${state.lastFrameMs}ms`, true);
    state.streamTimer = setTimeout(requestStreamFrame, nextFrameDelay(state.lastFrameMs));
  };

  img.onerror = () => {
    if (seq !== state.streamSeq) return;
    state.streaming = false;
    setStatus("截图加载失败，稍后重试", false);
    state.streamTimer = setTimeout(requestStreamFrame, 900);
  };

  img.src = `/api/screenshot.jpg?w=${targetWidth}&q=${quality}&token=${encodeURIComponent(state.token)}&t=${Date.now()}`;
}

function startMjpegStream() {
  if (!state.connected) return;
  stopStream();
  const img = $("screen");
  const { targetWidth, quality, fps } = streamParams();
  img.onload = () => {
    img.style.display = "block";
    $("empty").style.display = "none";
    fitScreen();
  };
  img.onerror = () => setStatus("视频流断开，点刷新重连", false);
  img.src = `/api/stream.mjpg?w=${targetWidth}&q=${quality}&fps=${fps}&token=${encodeURIComponent(state.token)}&t=${Date.now()}`;
  setStatus(`${state.screen.width} x ${state.screen.height} / MJPEG ${targetWidth}px Q${quality} ${fps}fps`, true);
}

async function pullFrameLoop(seq) {
  if (!state.connected || seq !== state.streamSeq) return;
  const img = $("screen");
  const { targetWidth, quality } = streamParams();
  const started = performance.now();
  const controller = new AbortController();
  state.streamController = controller;

  try {
    const res = await fetch(`/api/screenshot.jpg?w=${targetWidth}&q=${quality}&token=${encodeURIComponent(state.token)}&t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`截图失败 ${res.status}`);
    const screenWidth = Number(res.headers.get("x-screen-width") || state.screen.width);
    const screenHeight = Number(res.headers.get("x-screen-height") || state.screen.height);
    const blob = await res.blob();
    if (seq !== state.streamSeq) return;

    state.screen = { width: screenWidth, height: screenHeight, scale: state.screen.scale || 1 };
    img.dataset.width = screenWidth;
    img.dataset.height = screenHeight;

    const nextUrl = URL.createObjectURL(blob);
    const oldUrl = state.currentFrameUrl;
    state.currentFrameUrl = nextUrl;
    img.onload = () => {
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      img.style.display = "block";
      $("empty").style.display = "none";
      fitScreen();
    };
    img.src = nextUrl;

    state.lastFrameMs = Math.round(performance.now() - started);
    recordTraffic(blob.size, state.lastFrameMs);
    setStatus(`${screenWidth} x ${screenHeight} / ${targetWidth}px Q${quality} / ${state.lastFrameMs}ms / ${formatTraffic(blob.size)}`, true);
    state.streamTimer = setTimeout(() => pullFrameLoop(seq), state.lastFrameMs > 700 ? 160 : 60);
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus(error.message, false);
      state.streamTimer = setTimeout(() => pullFrameLoop(seq), 500);
    }
  }
}

function startLowLatencyStream() {
  if (!state.connected) return;
  stopStream();
  const seq = ++state.streamSeq;
  pullFrameLoop(seq);
}

async function connectHttp() {
  state.token = $("token").value.trim();
  localStorage.setItem("remote-token", state.token);
  const info = await api("/api/info");
  state.connected = true;
  resetTraffic();
  state.screen = { width: info.width, height: info.height, scale: 1 };
  const img = $("screen");
  img.dataset.width = info.width;
  img.dataset.height = info.height;
  setStatus(`HTTP 已连接 ${info.width} x ${info.height}`, true);
  if (state.useWebRtc) {
    startWebRtc().catch(error => {
      setStatus(`${error.message}，回退截图`, false);
      startLowLatencyStream();
    });
  } else {
    stopWebRtc();
    startLowLatencyStream();
  }
}

async function connect() {
  try {
    selectedChannel();
    await connectHttp();
  } catch (error) {
    state.connected = false;
    setStatus(error.message, false);
  }
}

function screenPoint(event) {
  const img = $("screen");
  const rect = img.getBoundingClientRect();
  const width = Number(img.dataset.width || 1);
  const height = Number(img.dataset.height || 1);
  const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * height);
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y))
  };
}

async function sendCommand(kind, payload) {
  if (selectedChannel() === "serial") {
    if (state.serial.writer) {
      await serialWrite({ kind, ...payload });
      return;
    }
    setStatus("串口未连接，已用本机 HTTP 控制", true);
  }

  if (kind === "mouse") {
    await api("/api/mouse", { method: "POST", body: JSON.stringify(payload) });
  } else if (kind === "keyboard") {
    await api("/api/keyboard", { method: "POST", body: JSON.stringify(payload) });
  } else if (kind === "clipboard") {
    await api("/api/clipboard", { method: "POST", body: JSON.stringify({ text: payload.text || "" }) });
  }
}

async function sendMouse(type, point, button = "left") {
  state.lastMouse = point;
  await sendCommand("mouse", { type, button, ...point });
}

function queueMouseMove(point) {
  state.lastMouse = point;
  state.mouseQueue = point;
  if (state.mouseSending) return;

  const sendNext = async () => {
    const wait = Math.max(0, 35 - (performance.now() - state.lastMouseSentAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const next = state.mouseQueue;
    state.mouseQueue = null;
    if (!next) {
      state.mouseSending = false;
      return;
    }
    state.mouseSending = true;
    state.lastMouseSentAt = performance.now();
    try {
      await sendCommand("mouse", { type: "move", button: "left", ...next });
    } catch (error) {
      setStatus(error.message, false);
    }
    sendNext();
  };

  state.mouseSending = true;
  sendNext();
}

async function sendKey(key) {
  await sendCommand("keyboard", { action: "key", key });
}

$("channel").addEventListener("change", selectedChannel);
$("connect").addEventListener("click", connect);
$("refresh").addEventListener("click", () => {
  startLowLatencyStream();
});
$("qualityMode").addEventListener("click", () => {
  if (state.qualityMode === "fast") state.qualityMode = "clear";
  else if (state.qualityMode === "clear") state.qualityMode = "ultra";
  else state.qualityMode = "fast";
  localStorage.setItem("remote-quality-mode", state.qualityMode);
  $("qualityMode").textContent = qualityModeLabel();
  resetTraffic();
  startLowLatencyStream();
});
$("togglePanel").addEventListener("click", () => {
  const app = document.querySelector(".app");
  if (window.matchMedia("(max-width: 900px)").matches) {
    app.classList.toggle("panel-open");
  } else {
    app.classList.toggle("panel-collapsed");
  }
  requestAnimationFrame(fitScreen);
});
$("serialConnect").addEventListener("click", () => connectSerial().catch(error => setStatus(error.message, false)));
$("serialDisconnect").addEventListener("click", () => disconnectSerial().catch(error => setStatus(error.message, false)));
$("serialPing").addEventListener("click", () => serialWrite({ kind: "ping", time: Date.now() }).catch(error => setStatus(error.message, false)));

$("screen").addEventListener("mousemove", event => {
  if (!state.connected) return;
  const point = screenPoint(event);
  if (Math.abs(point.x - state.lastMouse.x) + Math.abs(point.y - state.lastMouse.y) < 24) return;
  queueMouseMove(point);
});

$("screen").addEventListener("pointerdown", event => {
  if (!state.connected) return;
  $("screen").setPointerCapture(event.pointerId);
  sendMouse("down", screenPoint(event), event.button === 2 ? "right" : "left")
    .then(() => startLowLatencyStream())
    .catch(error => setStatus(error.message, false));
});

$("screen").addEventListener("pointerup", event => {
  if (!state.connected) return;
  sendMouse("up", screenPoint(event), event.button === 2 ? "right" : "left")
    .then(() => startLowLatencyStream())
    .catch(error => setStatus(error.message, false));
});

$("screen").addEventListener("click", async event => {
  if (!state.connected) return;
});

$("screen").addEventListener("contextmenu", async event => {
  event.preventDefault();
  if (!state.connected) return;
});

$("screen").addEventListener("wheel", event => {
  if (!state.connected) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? 120 : -120;
  sendCommand("mouse", { type: "wheel", delta, ...screenPoint(event) }).catch(error => setStatus(error.message, false));
}, { passive: false });

window.addEventListener("resize", fitScreen);
window.matchMedia("(max-width: 900px)").addEventListener("change", () => {
  document.querySelector(".app").classList.remove("panel-open", "panel-collapsed");
  requestAnimationFrame(fitScreen);
});
new ResizeObserver(fitScreen).observe($("screenWrap"));

$("rightClick").addEventListener("click", async () => {
  await sendMouse("click", state.lastMouse, "right");
});

$("sendText").addEventListener("click", async () => {
  await sendCommand("keyboard", { action: "text", text: $("textInput").value });
});

document.querySelectorAll("[data-key]").forEach(button => {
  button.addEventListener("click", () => sendKey(button.dataset.key));
});

$("readClip").addEventListener("click", async () => {
  if (selectedChannel() === "serial") {
    await serialWrite({ kind: "clipboard", action: "read" });
    return;
  }
  const data = await api("/api/clipboard");
  $("clip").value = data.text || "";
});

$("writeClip").addEventListener("click", async () => {
  await sendCommand("clipboard", { action: "write", text: $("clip").value });
  setStatus("已写入远端剪贴板", true);
});

$("listFiles").addEventListener("click", () => {
  loadFiles().catch(error => setStatus(error.message, false));
});

$("parentDir").addEventListener("click", () => {
  loadFiles($("parentDir").dataset.path || "").catch(error => setStatus(error.message, false));
});

$("pasteLocal").addEventListener("click", async () => {
  $("clip").value = await navigator.clipboard.readText();
});

$("copyLocal").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("clip").value);
  setStatus("已复制到本机剪贴板", true);
});
