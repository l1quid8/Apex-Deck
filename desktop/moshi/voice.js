const status = document.getElementById('status'), transcript = document.getElementById('transcript');
const startButton = document.getElementById('start'), muteButton = document.getElementById('mute');
let stream, context, socket, node, muted = false, generation = 0, timer;
function stop(message) {
  generation++; clearTimeout(timer); socket?.close(); socket = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  node?.disconnect(); node = null; void context?.close().catch(() => {}); context = null;
  muted = false; muteButton.textContent = 'Mute microphone'; muteButton.setAttribute('aria-pressed', 'false'); muteButton.disabled = true;
  startButton.hidden = false; status.textContent = message;
}
async function start() {
  stop('Connecting microphone…'); const mine = generation; startButton.hidden = true; transcript.textContent = '';
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (mine !== generation) { media.getTracks().forEach(track => track.stop()); return; }
    stream = media; context = new AudioContext();
    await context.audioWorklet.addModule('audio-worklet.js');
    if (mine !== generation) return;
    await context.resume();
    if (mine !== generation) return;
    node = new AudioWorkletNode(context, 'voice-audio', { outputChannelCount: [1] });
    context.createMediaStreamSource(stream).connect(node); node.connect(context.destination);
    const ws = new WebSocket(`ws://${location.host}/api/chat`); socket = ws; ws.binaryType = 'arraybuffer';
    let ready = false, sentFrames = 0;
    timer = setTimeout(() => { if (mine === generation) stop('Voice connection timed out. Start again.'); }, 20000);
    node.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== WebSocket.OPEN) return;
      if (++sentFrames >= 22500) { stop('30-minute session ended. Start again for a new conversation.'); return; }
      if (ws.bufferedAmount > 24000 * 4) { stop('Audio fell behind. Start again.'); return; }
      const payload = new Uint8Array(1 + data.audio.byteLength); payload[0] = 1; payload.set(new Uint8Array(data.audio.buffer), 1); ws.send(payload);
    };
    ws.onmessage = ({ data }) => {
      if (mine !== generation || !(data instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(data);
      if (frame[0] === 0) { ready = true; clearTimeout(timer); status.textContent = 'Listening · Speak naturally'; muteButton.disabled = false; }
      else if (frame[0] === 1 && (frame.length - 1) % 4 === 0) {
        const audio = new Float32Array(data.slice(1)); node.port.postMessage({ audio }, [audio.buffer]);
      } else if (frame[0] === 2) { transcript.textContent = (transcript.textContent + new TextDecoder().decode(frame.subarray(1))).slice(-4000); transcript.scrollTop = transcript.scrollHeight; }
    };
    ws.onerror = () => { if (mine === generation) stop('Could not connect to local voice. Start again.'); };
    ws.onclose = () => { if (mine === generation) stop('Voice disconnected. Start again.'); };
  } catch (error) { if (mine === generation) stop(error instanceof Error ? error.message : String(error)); }
}
startButton.onclick = () => { location.href = '/restart'; };
muteButton.onclick = () => { muted = !muted; node?.port.postMessage({ mute: muted }); muteButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone'; muteButton.setAttribute('aria-pressed', String(muted)); status.textContent = muted ? 'Microphone muted' : 'Listening · Speak naturally'; };
document.getElementById('end').onclick = () => { stop('Call ended.'); window.close(); };
window.addEventListener('beforeunload', () => stop('Call ended.'));
void start();
