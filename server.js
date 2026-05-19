const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");

const root = __dirname;
const publicDir = path.join(root, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = process.env.REMOTE_TOKEN || crypto.randomBytes(18).toString("base64url");
const powershell = process.env.POWERSHELL || "powershell.exe";
const defaultFileRoot = process.env.FILE_ROOT || process.env.USERPROFILE || root;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const signalRooms = new Map();

function signalRoom(name) {
  const key = name || "main";
  if (!signalRooms.has(key)) {
    signalRooms.set(key, { nextId: 1, messages: [] });
  }
  return signalRooms.get(key);
}

const dpiAwareScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DpiAwareness {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiAwareness]::SetProcessDPIAware() | Out-Null
`;

const screenshotWorkerScript = `
${dpiAwareScript}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$jpegEncoder = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $targetWidth = [Math]::Max(0, [Math]::Min(2880, [int]$req.targetWidth))
  $quality = [Math]::Max(25, [Math]::Min(90, [int]$req.quality))
  if ($targetWidth -gt 0 -and $targetWidth -lt $b.Width) {
    $targetHeight = [int][Math]::Round($b.Height * ($targetWidth / $b.Width))
  } else {
    $targetWidth = $b.Width
    $targetHeight = $b.Height
  }
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $graphics = [Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
  $scaled = New-Object Drawing.Bitmap $targetWidth, $targetHeight
  $scaledGraphics = [Drawing.Graphics]::FromImage($scaled)
  $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::Low
  $scaledGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighSpeed
  $scaledGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
  $scaledGraphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighSpeed
  $scaledGraphics.DrawImage($bmp, 0, 0, $targetWidth, $targetHeight)
  $stream = New-Object IO.MemoryStream
  $encoderParams = New-Object Drawing.Imaging.EncoderParameters 1
  $encoderParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([int64]$quality)
  $scaled.Save($stream, $jpegEncoder, $encoderParams)
  $result = @{
    id = $req.id
    width = $b.Width
    height = $b.Height
    imageWidth = $targetWidth
    imageHeight = $targetHeight
    format = "jpeg"
    image = [Convert]::ToBase64String($stream.ToArray())
  } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($result)))
  [Console]::Out.Flush()
  $stream.Dispose()
  $scaledGraphics.Dispose()
  $scaled.Dispose()
  $graphics.Dispose()
  $bmp.Dispose()
}
`;

let screenshotWorker = null;
let screenshotBuffer = "";
let screenshotSeq = 0;
const screenshotPending = new Map();

const inputWorkerScript = `
${dpiAwareScript}
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  public const uint INPUT_MOUSE = 0;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;

  public static void MouseButton(uint flag) {
    INPUT[] input = new INPUT[1];
    input[0].type = INPUT_MOUSE;
    input[0].mi.dwFlags = flag;
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MouseWheel(int delta) {
    INPUT[] input = new INPUT[1];
    input[0].type = INPUT_MOUSE;
    input[0].mi.mouseData = unchecked((uint)delta);
    input[0].mi.dwFlags = WHEEL;
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  if ($req.kind -eq "mouse") {
    $x = [Math]::Max(0, [int]$req.x)
    $y = [Math]::Max(0, [int]$req.y)
    if ($req.type -ne "wheel") {
      [NativeInput]::SetCursorPos($x, $y) | Out-Null
    }
    $down = [NativeInput]::LEFTDOWN
    $up = [NativeInput]::LEFTUP
    if ($req.button -eq "right") {
      $down = [NativeInput]::RIGHTDOWN
      $up = [NativeInput]::RIGHTUP
    }
    if ($req.type -eq "down") {
      [NativeInput]::MouseButton($down)
    } elseif ($req.type -eq "up") {
      [NativeInput]::MouseButton($up)
    } elseif ($req.type -eq "click") {
      [NativeInput]::MouseButton($down)
      Start-Sleep -Milliseconds 20
      [NativeInput]::MouseButton($up)
    } elseif ($req.type -eq "wheel") {
      [NativeInput]::MouseWheel([int]$req.delta)
    }
  }
  $result = @{ id = $req.id; ok = $true } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($result)))
  [Console]::Out.Flush()
}
`;

let inputWorker = null;
let inputBuffer = "";
let inputSeq = 0;
const inputPending = new Map();

function startScreenshotWorker() {
  if (screenshotWorker && !screenshotWorker.killed) return screenshotWorker;
  const encoded = Buffer.from(screenshotWorkerScript, "utf16le").toString("base64");
  screenshotWorker = spawn(
    powershell,
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true }
  );

  screenshotWorker.stdout.on("data", chunk => {
    screenshotBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = screenshotBuffer.indexOf("\n")) >= 0) {
      const line = screenshotBuffer.slice(0, newline).trim();
      screenshotBuffer = screenshotBuffer.slice(newline + 1);
      if (!line) continue;
      const decoded = Buffer.from(line, "base64").toString("utf8");
      const result = JSON.parse(decoded);
      const pending = screenshotPending.get(result.id);
      if (!pending) continue;
      screenshotPending.delete(result.id);
      pending.resolve(result);
    }
  });

  screenshotWorker.stderr.on("data", chunk => {
    console.error(`screenshot worker: ${chunk}`);
  });

  screenshotWorker.on("exit", () => {
    screenshotWorker = null;
    for (const pending of screenshotPending.values()) {
      pending.reject(new Error("Screenshot worker exited"));
    }
    screenshotPending.clear();
  });

  return screenshotWorker;
}

function startInputWorker() {
  if (inputWorker && !inputWorker.killed) return inputWorker;
  const encoded = Buffer.from(inputWorkerScript, "utf16le").toString("base64");
  inputWorker = spawn(
    powershell,
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true }
  );

  inputWorker.stdout.on("data", chunk => {
    inputBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = inputBuffer.indexOf("\n")) >= 0) {
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      const decoded = Buffer.from(line, "base64").toString("utf8");
      const result = JSON.parse(decoded);
      const pending = inputPending.get(result.id);
      if (!pending) continue;
      inputPending.delete(result.id);
      pending.resolve(result);
    }
  });

  inputWorker.stderr.on("data", chunk => {
    console.error(`input worker: ${chunk}`);
  });

  inputWorker.on("exit", () => {
    inputWorker = null;
    for (const pending of inputPending.values()) {
      pending.reject(new Error("Input worker exited"));
    }
    inputPending.clear();
  });

  return inputWorker;
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const command = input ? `${script}\n${input}` : script;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const child = execFile(
      powershell,
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, maxBuffer: 30 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function screenInfo() {
  const out = await runPowerShell(`
${dpiAwareScript}
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@{ width = $b.Width; height = $b.Height } | ConvertTo-Json -Compress
`);
  return JSON.parse(out);
}

async function screenshot({ targetWidth = 0, quality = 55 } = {}) {
  const safeTargetWidth = Math.max(0, Math.min(2880, Number(targetWidth) || 0));
  const safeQuality = Math.max(25, Math.min(90, Number(quality) || 55));
  try {
    const worker = startScreenshotWorker();
    const id = String(++screenshotSeq);
    const request = Buffer.from(JSON.stringify({
      id,
      targetWidth: safeTargetWidth,
      quality: safeQuality
    }), "utf8").toString("base64");

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        screenshotPending.delete(id);
        reject(new Error("Screenshot worker timed out"));
      }, 8000);
      screenshotPending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      worker.stdin.write(`${request}\n`);
    });
    return result;
  } catch (error) {
    if (screenshotWorker) screenshotWorker.kill();
    console.error(`screenshot worker fallback: ${error.message}`);
  }

  const out = await runPowerShell(`
${dpiAwareScript}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
$graphics = [Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
$targetWidth = ${safeTargetWidth}
if ($targetWidth -gt 0 -and $targetWidth -lt $b.Width) {
  $targetHeight = [int][Math]::Round($b.Height * ($targetWidth / $b.Width))
} else {
  $targetWidth = $b.Width
  $targetHeight = $b.Height
}
$scaled = New-Object Drawing.Bitmap $targetWidth, $targetHeight
$scaledGraphics = [Drawing.Graphics]::FromImage($scaled)
$scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$scaledGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighSpeed
$scaledGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
$scaledGraphics.DrawImage($bmp, 0, 0, $targetWidth, $targetHeight)
$stream = New-Object IO.MemoryStream
$encoder = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
$encoderParams = New-Object Drawing.Imaging.EncoderParameters 1
$encoderParams.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ${safeQuality}L
$scaled.Save($stream, $encoder, $encoderParams)
$scaledGraphics.Dispose()
$scaled.Dispose()
$graphics.Dispose()
$bmp.Dispose()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@{ width = $b.Width; height = $b.Height; imageWidth = $targetWidth; imageHeight = $targetHeight; format = "jpeg"; image = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
`);
  return JSON.parse(out);
}

async function screenshotImage(options) {
  const shot = await screenshot(options);
  return {
    ...shot,
    buffer: Buffer.from(shot.image, "base64")
  };
}

async function mouse({ type, x, y, button, delta }) {
  try {
    const worker = startInputWorker();
    const id = String(++inputSeq);
    const request = Buffer.from(JSON.stringify({
      id,
      kind: "mouse",
      type,
      x,
      y,
      button,
      delta
    }), "utf8").toString("base64");

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        inputPending.delete(id);
        reject(new Error("Input worker timed out"));
      }, 3000);
      inputPending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      worker.stdin.write(`${request}\n`);
    });
    return;
  } catch (error) {
    if (inputWorker) inputWorker.kill();
    console.error(`input worker fallback: ${error.message}`);
  }

  const payload = Buffer.from(JSON.stringify({ type, x, y, button, delta }), "utf8").toString("base64");
  await runPowerShell(`
${dpiAwareScript}
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload}")) | ConvertFrom-Json
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  public const uint INPUT_MOUSE = 0;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;

  public static void MouseButton(uint flag) {
    INPUT[] input = new INPUT[1];
    input[0].type = INPUT_MOUSE;
    input[0].mi.dwFlags = flag;
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MouseWheel(int delta) {
    INPUT[] input = new INPUT[1];
    input[0].type = INPUT_MOUSE;
    input[0].mi.mouseData = unchecked((uint)delta);
    input[0].mi.dwFlags = WHEEL;
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
$x = [Math]::Max(0, [int]$payload.x)
$y = [Math]::Max(0, [int]$payload.y)
[NativeMouse]::SetCursorPos($x, $y) | Out-Null
$down = [NativeMouse]::LEFTDOWN
$up = [NativeMouse]::LEFTUP
if ($payload.button -eq "right") {
  $down = [NativeMouse]::RIGHTDOWN
  $up = [NativeMouse]::RIGHTUP
}
if ($payload.type -eq "down") {
  [NativeMouse]::MouseButton($down)
} elseif ($payload.type -eq "up") {
  [NativeMouse]::MouseButton($up)
} elseif ($payload.type -eq "click") {
  [NativeMouse]::MouseButton($down)
  Start-Sleep -Milliseconds 35
  [NativeMouse]::MouseButton($up)
} elseif ($payload.type -eq "wheel") {
  [NativeMouse]::MouseWheel([int]$payload.delta)
}
`);
}

function sendKeysFor(key) {
  const map = {
    enter: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    home: "{HOME}",
    end: "{END}",
    copy: "^c",
    paste: "^v",
    cut: "^x",
    selectAll: "^a"
  };
  return map[key] || "";
}

async function keyboard({ action, text, key }) {
  const sequence = action === "text" ? "^v" : sendKeysFor(key);
  if (!sequence) return;
  const payload = Buffer.from(JSON.stringify({ action, text: text || "", sequence }), "utf8").toString("base64");
  await runPowerShell(`
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload}")) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
if ($payload.action -eq "text") {
  Set-Clipboard -Value ([string]$payload.text)
  Start-Sleep -Milliseconds 80
}
[System.Windows.Forms.SendKeys]::SendWait($payload.sequence)
`);
}

async function getClipboard() {
  const out = await runPowerShell(`
$value = Get-Clipboard -Raw -ErrorAction SilentlyContinue
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$value))
`);
  const clean = out.trim();
  return clean ? Buffer.from(clean, "base64").toString("utf8") : "";
}

async function setClipboard(text) {
  const payload = Buffer.from(text || "", "utf8").toString("base64");
  await runPowerShell(`
$value = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload}"))
Set-Clipboard -Value ([string]$value)
`);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(data);
}

function binary(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function filePathFromRequest(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return defaultFileRoot;
  return path.resolve(raw);
}

async function listFiles(dirPath) {
  const resolved = filePathFromRequest(dirPath);
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  const rows = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(resolved, entry.name);
    let stat = null;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      // Keep unreadable entries visible.
    }
    return {
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory() ? "dir" : "file",
      size: stat?.size ?? 0,
      modified: stat?.mtime?.toISOString() || null
    };
  }));
  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
  });
  return {
    path: resolved,
    parent: path.dirname(resolved),
    entries: rows
  };
}

function downloadFile(filePath, res) {
  const resolved = filePathFromRequest(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    json(res, 400, { error: "Path is not a file" });
    return;
  }
  const filename = path.basename(resolved).replace(/"/g, "");
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": stat.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "no-store"
  });
  fs.createReadStream(resolved).pipe(res);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function authorized(req, body) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const given = req.headers["x-remote-token"] || url.searchParams.get("token") || body?.token;
  const givenBuffer = Buffer.from(String(given || ""));
  const tokenBuffer = Buffer.from(token);
  return givenBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(givenBuffer, tokenBuffer);
}

async function api(req, res) {
  let body = {};
  if (req.method !== "GET") body = await readBody(req);
  if (!authorized(req, body)) {
    json(res, 401, { error: "Bad token" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/info") json(res, 200, await screenInfo());
  else if (req.method === "GET" && url.pathname === "/api/screenshot") {
    json(res, 200, await screenshot({
      targetWidth: url.searchParams.get("w"),
      quality: url.searchParams.get("q")
    }));
  }
  else if (req.method === "GET" && url.pathname === "/api/screenshot.jpg") {
    const shot = await screenshotImage({
      targetWidth: url.searchParams.get("w"),
      quality: url.searchParams.get("q")
    });
    binary(res, 200, shot.buffer, {
      "content-type": "image/jpeg",
      "x-screen-width": String(shot.width),
      "x-screen-height": String(shot.height),
      "x-image-width": String(shot.imageWidth),
      "x-image-height": String(shot.imageHeight)
    });
  }
  else if (req.method === "GET" && url.pathname === "/api/stream.mjpg") {
    const fps = Math.max(1, Math.min(10, Number(url.searchParams.get("fps")) || 5));
    const interval = Math.round(1000 / fps);
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    res.writeHead(200, {
      "content-type": "multipart/x-mixed-replace; boundary=frame",
      "cache-control": "no-store",
      "connection": "close"
    });
    while (!closed) {
      const shot = await screenshotImage({
        targetWidth: url.searchParams.get("w"),
        quality: url.searchParams.get("q")
      });
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${shot.buffer.length}\r\n\r\n`);
      res.write(shot.buffer);
      res.write("\r\n");
      await wait(interval);
    }
  }
  else if (req.method === "POST" && url.pathname === "/api/signal/send") {
    const room = signalRoom(body.room || "main");
    const message = {
      id: room.nextId++,
      at: Date.now(),
      from: body.from,
      type: body.type,
      data: body.data
    };
    room.messages.push(message);
    if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
    json(res, 200, { ok: true, id: message.id });
  }
  else if (req.method === "GET" && url.pathname === "/api/signal/poll") {
    const room = signalRoom(url.searchParams.get("room") || "main");
    const role = url.searchParams.get("role") || "";
    const after = Number(url.searchParams.get("after") || 0);
    const cutoff = Date.now() - 120000;
    room.messages = room.messages.filter(message => message.at > cutoff);
    json(res, 200, {
      messages: room.messages.filter(message => message.id > after && message.from !== role),
      nextId: room.nextId
    });
  }
  else if (req.method === "POST" && url.pathname === "/api/mouse") {
    await mouse(body);
    json(res, 200, { ok: true });
  } else if (req.method === "POST" && url.pathname === "/api/keyboard") {
    await keyboard(body);
    json(res, 200, { ok: true });
  } else if (req.method === "GET" && url.pathname === "/api/clipboard") json(res, 200, { text: await getClipboard() });
  else if (req.method === "POST" && url.pathname === "/api/clipboard") {
    await setClipboard(body.text || "");
    json(res, 200, { ok: true });
  } else if (req.method === "GET" && url.pathname === "/api/files") {
    json(res, 200, await listFiles(url.searchParams.get("path")));
  } else if (req.method === "GET" && url.pathname === "/api/download") {
    downloadFile(url.searchParams.get("path"), res);
  } else {
    json(res, 404, { error: "Not found" });
  }
}

function staticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) await api(req, res);
    else staticFile(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Web remote control: http://${host}:${port}`);
  console.log(`Token: ${token}`);
  if (host === "127.0.0.1") console.log("Set HOST=0.0.0.0 to allow LAN access.");
});
