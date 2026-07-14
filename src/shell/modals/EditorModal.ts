/**
 * src/shell/modals/EditorModal.ts
 * Itera OS v2: Host Code Editor Modal (Fallback UI)
 */

const DOM_IDS = {
  OVERLAY: 'editor-overlay',
  CONTAINER: 'code-editor',
  FILENAME: 'editor-filename',
  BTN_CLOSE: 'btn-close-editor',
  BTN_SAVE: 'btn-save-editor',
};

export class EditorModal {
  private els: Record<string, HTMLElement | null> = {};
  private events: Record<string, Function> = {};
  private currentPath: string | null = null;
  private editorInstance: any = null;
  private isMonacoLoaded: boolean = false;
  private currentTheme: string = 'vs-dark'; // Default
  private currentFontSize: number = 14;
  private currentMonoFont: string = 'monospace';

  constructor() {
    this._initElements();
    this._bindEvents();
  }

  on(event: string, callback: Function): void {
    this.events[event] = callback;
  }

  private _initElements(): void {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private _bindEvents(): void {
    if (this.els.BTN_CLOSE) {
      this.els.BTN_CLOSE.onclick = () => this.close();
    }
    if (this.els.BTN_SAVE) {
      this.els.BTN_SAVE.onclick = () => this._save();
    }
  }

  /**
   * エディタを開く
   * @param path 対象のファイルパス
   * @param content ファイルの中身の文字列
   */
  open(path: string, content: string): void {
    // Binary Guard
    if (path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|mp3|mp4|webm|ogg)$/i)) {
      if (window.AppUI) window.AppUI.notify('Binary file editing is not supported.', 'warning');
      return;
    }

    this.currentPath = path;
    if (this.els.FILENAME) this.els.FILENAME.textContent = path;
    if (this.els.OVERLAY) this.els.OVERLAY.classList.remove('hidden');

    if (!this.isMonacoLoaded) {
      this._initMonaco(() => this._setValue(path, content));
    } else {
      this._setValue(path, content);
    }
  }

  close(): void {
    if (this.els.OVERLAY) this.els.OVERLAY.classList.add('hidden');
    this.currentPath = null;
    // フォーカスを外す（ショートカット暴発防止）
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  setTheme(theme: string): void {
    this.currentTheme = theme === 'dark' ? 'vs-dark' : 'vs';
    if (this.editorInstance && (window as any).monaco) {
      (window as any).monaco.editor.setTheme(this.currentTheme);
    }
  }

  updateTypography(fontSize: number, monoFont: string): void {
    this.currentFontSize = fontSize;
    this.currentMonoFont = monoFont;
    if (this.editorInstance && (window as any).monaco) {
      this.editorInstance.updateOptions({
        fontSize: this.currentFontSize,
        fontFamily: this.currentMonoFont,
      });
    }
  }

  private _initMonaco(callback?: Function): void {
    if (typeof (window as any).require === 'undefined') {
      console.error('Monaco loader (require.js) not found.');
      return;
    }

    (window as any).require.config({
      paths: {
        vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs',
      },
    });

    (window as any).require(['vs/editor/editor.main'], () => {
      this.isMonacoLoaded = true;
      if (!this.els.CONTAINER) return;

      this.editorInstance = (window as any).monaco.editor.create(this.els.CONTAINER, {
        value: '',
        language: 'plaintext',
        theme: this.currentTheme,
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: this.currentFontSize,
        fontFamily: this.currentMonoFont,
        scrollBeyondLastLine: false,
        padding: { top: 10, bottom: 10 },
      });

      // Bind Ctrl+S / Cmd+S
      this.editorInstance.addCommand(
        (window as any).monaco.KeyMod.CtrlCmd | (window as any).monaco.KeyCode.KeyS,
        () => {
          this._save();
        },
      );

      if (callback) callback();
    });
  }

  private _setValue(path: string, content: string): void {
    if (!this.editorInstance) return;

    // 言語判定
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      js: 'javascript',
      html: 'html',
      css: 'css',
      json: 'json',
      md: 'markdown',
      py: 'python',
      ts: 'typescript',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      sql: 'sql',
      sh: 'shell',
    };
    const lang = langMap[ext] || 'plaintext';

    const model = this.editorInstance.getModel();
    if (model) {
      (window as any).monaco.editor.setModelLanguage(model, lang);
      this.editorInstance.setValue(content);
    }

    setTimeout(() => {
      this.editorInstance.layout();
      this.editorInstance.focus();
    }, 50);
  }

  private _save(): void {
    if (!this.currentPath || !this.editorInstance) return;

    const content = this.editorInstance.getValue();

    if (this.events['save']) {
      this.events['save'](this.currentPath, content);
    }

    // Visual Feedback
    if (this.els.BTN_SAVE) {
      const originalText = this.els.BTN_SAVE.textContent;
      this.els.BTN_SAVE.textContent = 'Saved!';
      this.els.BTN_SAVE.classList.remove('bg-primary');
      this.els.BTN_SAVE.classList.add('bg-success');

      setTimeout(() => {
        this.els.BTN_SAVE!.textContent = originalText;
        this.els.BTN_SAVE!.classList.remove('bg-success');
        this.els.BTN_SAVE!.classList.add('bg-primary');
      }, 1000);
    }
  }
}
