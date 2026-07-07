/**
 * src/shell/modals/AudioModal.ts
 * Itera OS v2: Audio Recording Modal
 */

export interface AudioOptions {
  maxDurationMs?: number;
}

export class AudioModal {
  constructor() {}

  async open(options?: AudioOptions): Promise<string | null> {
    return new Promise(async (resolve, reject) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return reject(new Error("Audio API is not supported in this browser."));
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
      } catch (e: any) {
        return reject(new Error("Failed to access microphone: " + e.message));
      }

      const mediaRecorder = new MediaRecorder(stream);
      const audioChunks: Blob[] = [];

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      });

      // OSネイティブの録音中UIを構築
      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 bg-black/80 backdrop-blur-sm z-[9999] flex flex-col items-center justify-center itera-animate-fade select-none";

      const box = document.createElement("div");
      box.className =
        "bg-panel p-8 rounded-3xl flex flex-col items-center border border-border-main shadow-2xl";

      const indicator = document.createElement("div");
      indicator.className =
        "w-20 h-20 bg-error/20 text-error rounded-full flex items-center justify-center text-4xl mb-4 animate-pulse shadow-[0_0_30px_rgba(220,38,38,0.4)]";
      indicator.innerText = "🎙️";

      const timeDisplay = document.createElement("div");
      timeDisplay.className =
        "text-3xl font-mono text-text-main mb-8 tabular-nums tracking-widest";
      timeDisplay.innerText = "00:00";

      const controls = document.createElement("div");
      controls.className = "flex gap-4";

      const btnCancel = document.createElement("button");
      btnCancel.className =
        "bg-card hover:bg-hover text-text-muted hover:text-text-main px-6 py-3 rounded-xl font-bold border border-border-main transition";
      btnCancel.innerText = "Cancel";

      const btnStop = document.createElement("button");
      btnStop.className =
        "bg-error hover:bg-error/80 text-white px-8 py-3 rounded-xl font-bold shadow-lg transition flex items-center gap-2";
      btnStop.innerHTML = `<div class="w-3 h-3 bg-white rounded-sm"></div> Stop & Save`;

      controls.appendChild(btnCancel);
      controls.appendChild(btnStop);
      box.appendChild(indicator);
      box.appendChild(timeDisplay);
      box.appendChild(controls);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const startTime = Date.now();
      let timerId: ReturnType<typeof setInterval>;
      let autoStopId: ReturnType<typeof setTimeout> | null = null;
      let isCancelled = false; // キャンセルフラグ

      timerId = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
        const s = String(elapsed % 60).padStart(2, "0");
        timeDisplay.innerText = `${m}:${s}`;
      }, 1000);

      const cleanup = () => {
        clearInterval(timerId);
        if (autoStopId) clearTimeout(autoStopId);
        stream.getTracks().forEach((track) => track.stop());
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 200);
      };

      btnCancel.onclick = () => {
        isCancelled = true;
        cleanup();
        resolve(null); // キャンセル時は null を返す
      };

      btnStop.onclick = () => {
        if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
      };

      mediaRecorder.addEventListener("stop", () => {
        // Cancelが押されていた場合は破棄して終了
        if (isCancelled) return;

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onloadend = () => {
          cleanup();
          resolve(reader.result as string);
        };
        reader.onerror = () => {
          cleanup();
          reject(new Error("Failed to read audio blob"));
        };
        reader.readAsDataURL(audioBlob);
      });

      mediaRecorder.start();

      // 制限時間が指定されている場合の自動停止
      if (options?.maxDurationMs) {
        autoStopId = setTimeout(() => {
          if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
        }, options.maxDurationMs);
      }
    });
  }
}
