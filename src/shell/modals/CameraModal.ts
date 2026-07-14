/**
 * src/shell/modals/CameraModal.ts
 * Itera OS v2: Camera Capture Modal
 */

export interface CameraOptions {
  facingMode?: string;
  quality?: number;
}

export class CameraModal {
  constructor() {}

  async open(options?: CameraOptions): Promise<string | null> {
    return new Promise(async (resolve, reject) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return reject(new Error('Camera API is not supported in this browser.'));
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: options?.facingMode || 'environment',
          },
        });
      } catch (e: any) {
        return reject(new Error('Failed to access camera: ' + e.message));
      }

      // OSネイティブのフルスクリーンカメラUIを構築
      const overlay = document.createElement('div');
      overlay.className =
        'fixed inset-0 bg-black z-[9999] flex flex-col items-center justify-center itera-animate-fade select-none';

      const video = document.createElement('video');
      video.className = 'w-full h-full object-contain';
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;

      const controls = document.createElement('div');
      controls.className = 'absolute bottom-10 left-0 right-0 flex justify-center items-center gap-10';

      const btnCancel = document.createElement('button');
      btnCancel.className =
        'bg-panel hover:bg-hover text-text-main px-6 py-3 rounded-full font-bold shadow-lg border border-border-main transition';
      btnCancel.innerText = 'Cancel';

      const btnCapture = document.createElement('button');
      btnCapture.className =
        'w-16 h-16 bg-white rounded-full border-4 border-gray-300 shadow-[0_0_20px_rgba(255,255,255,0.5)] focus:outline-none active:scale-95 transition-transform';

      controls.appendChild(btnCancel);
      controls.appendChild(btnCapture);
      overlay.appendChild(video);
      overlay.appendChild(controls);
      document.body.appendChild(overlay);

      const cleanup = () => {
        stream.getTracks().forEach((track) => track.stop());
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 200);
      };

      btnCancel.onclick = () => {
        cleanup();
        resolve(null); // キャンセル時は null を返す
      };

      btnCapture.onclick = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }

        const quality = options?.quality || 0.8;
        const dataUrl = canvas.toDataURL('image/jpeg', quality);

        cleanup();
        resolve(dataUrl); // 撮影した画像のBase64を返す
      };
    });
  }
}
