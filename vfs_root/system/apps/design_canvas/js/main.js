/**
 * デザインキャンバス — 起動・保存・読み込み・AI に送る
 *
 * - 起動の引数 file で設計ファイルを開く（関連付けから開いたとき）。無ければ新しい設計。
 * - 保存は版つきの書き込み（ifVersion）。外で書き換えられていたら、上書きするかを訊く。
 * - 開いているファイルが外で書き換えられたら（AI が write したなど）読み直す。
 *   未保存の変更があるときは勝手に捨てず、帯で知らせて選んでもらう。
 * - 「AI に送る」は保存してから、要約とファイルの場所をチャットに送る（MetaOS.chat.append）。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  // 保存先の既定（配布物ごとに違うのはこの 1 行。無ければ保存・開くの前に作る）
  const defaultDir = () => 'data/designs';
  const $ = (id) => document.getElementById(id);

  const state = { path: null, version: null, lastText: null };
  const model = new DesignModel(DesignDoc.emptyDoc());
  let editor;
  let preview;

  const toText = (doc) => JSON.stringify(doc, null, 2) + '\n';
  const baseName = (p) => (p ? p.split('/').pop() : '');
  const safeName = (s) =>
    String(s || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'design';

  function setStatus(msg, tone = 'muted') {
    const s = $('status');
    s.textContent = msg || '';
    s.className = `text-xs truncate ${tone === 'error' ? 'text-error' : tone === 'warn' ? 'text-warning' : 'text-text-muted'}`;
  }
  function refreshTitle() {
    const name = state.path ? baseName(state.path) : say('file.unsaved');
    $('file-label').textContent = (model.dirty ? '● ' : '') + name;
    $('file-label').title = state.path || '';
    $('btn-undo').disabled = !model.past.length;
    $('btn-redo').disabled = !model.future.length;
  }
  function showBanner(text, actions) {
    const b = $('banner');
    b.textContent = '';
    b.classList.remove('hidden');
    b.classList.add('flex');
    const t = document.createElement('span');
    t.className = 'flex-1';
    t.textContent = text;
    b.appendChild(t);
    for (const [label, fn] of actions) {
      const btn = document.createElement('button');
      btn.className = 'px-2 py-0.5 rounded border border-warning/60 hover:bg-warning/20';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        hideBanner();
        fn();
      });
      b.appendChild(btn);
    }
  }
  function hideBanner() {
    $('banner').classList.add('hidden');
    $('banner').classList.remove('flex');
  }

  // ---------- 読む ----------
  async function load(path, { quiet = false } = {}) {
    try {
      const { content, version } = await MetaOS.fs.read(path, { withVersion: true });
      const { doc, warnings } = DesignDoc.normalize(JSON.parse(content));
      state.path = path;
      state.version = version;
      state.lastText = content;
      model.replace(doc);
      hideBanner();
      if (!quiet) editor.fit();
      setStatus(
        warnings.length
          ? say('status.loadFixed', { list: warnings.join(say('list.sep')) })
          : say('status.opened', { path }),
        warnings.length ? 'warn' : 'muted',
      );
      return true;
    } catch (e) {
      console.error('[design_canvas] load failed', e);
      setStatus(say('status.openFailed', { path, error: e.message || e }), 'error');
      return false;
    }
  }

  // ---------- 書く ----------
  async function ensureDir() {
    try {
      const dir = defaultDir();
      if (!(await MetaOS.fs.exists(dir))) await MetaOS.fs.mkdir(dir);
    } catch (e) {
      console.warn('[design_canvas] mkdir failed', e);
    }
  }
  async function askPath() {
    await ensureDir();
    const p = await MetaOS.host.showSaveDialog({
      title: say('dialog.save'),
      filters: ['.design'],
      defaultDir: state.path ? state.path.split('/').slice(0, -1).join('/') : defaultDir(),
      defaultName: `${safeName(model.doc.title)}.design`,
    });
    if (!p) return null;
    return p.endsWith('.design') ? p : `${p}.design`;
  }
  /** 保存する。戻り値は保存したパス（取りやめたら null） */
  async function save({ as = false } = {}) {
    let path = state.path;
    if (!path || as) {
      path = await askPath();
      if (!path) return null;
    }
    const text = toText(model.doc);
    const samePath = path === state.path;
    try {
      const opts = { overwrite: true };
      if (samePath && state.version !== null && state.version !== undefined) opts.ifVersion = state.version;
      const res = await MetaOS.fs.write(path, text, opts);
      await afterWrite(path, text, res);
      return path;
    } catch (e) {
      if (e && e.code === 'ESTALE') {
        const ok = await AppUI.confirm(say('dialog.stale'), say('dialog.stale.title'));
        if (!ok) {
          setStatus(say('status.saveCancelled'), 'warn');
          return null;
        }
        const res = await MetaOS.fs.write(path, text, { overwrite: true });
        await afterWrite(path, text, res);
        return path;
      }
      console.error('[design_canvas] save failed', e);
      setStatus(say('status.saveFailed', { error: e.message || e }), 'error');
      return null;
    }
  }
  async function afterWrite(path, text, res) {
    state.path = path;
    state.lastText = text;
    let v = res && typeof res === 'object' ? res.version : undefined;
    if (v === undefined) {
      try {
        v = (await MetaOS.fs.stat(path)).version;
      } catch (_) {
        v = null;
      }
    }
    state.version = v ?? null;
    model.markSaved();
    hideBanner();
    setStatus(say('status.saved', { path }));
  }

  // ---------- 外からの書き換え ----------
  async function onMutation(m) {
    if (!m || !state.path || m.path !== state.path) return;
    let got;
    try {
      got = await MetaOS.fs.read(state.path, { withVersion: true });
    } catch (_) {
      setStatus(say('status.fileGone'), 'warn');
      return;
    }
    if (got.content === state.lastText) {
      state.version = got.version; // 自分の書き込み
      return;
    }
    if (!model.dirty) {
      await load(state.path, { quiet: true });
      setStatus(say('status.reloaded'));
      return;
    }
    showBanner(say('banner.changed'), [
      [say('banner.reload'), () => load(state.path, { quiet: true })],
      [say('banner.keep'), () => setStatus(say('status.keepEditing'), 'warn')],
    ]);
  }

  // ---------- AI に送る ----------
  /** 設計ファイルの横の「名前_screens/」に、画面ごとの PNG を書く。今の設計に無い画面の PNG は消す */
  async function writeScreens(path) {
    const dir = path.replace(/\.(design|json)$/i, '') + '_screens';
    if (!(await MetaOS.fs.exists(dir))) await MetaOS.fs.mkdir(dir);
    const keep = new Set(model.doc.screens.map((s) => `${s.id}.png`));
    try {
      for (const name of await MetaOS.fs.list(dir)) {
        const n = String(name).split('/').pop();
        if (n.endsWith('.png') && !keep.has(n)) await MetaOS.fs.delete(`${dir}/${n}`, { permanent: true });
      }
    } catch (e) {
      console.warn('[design_canvas] cleanup failed', e);
    }
    // 依頼の入力欄が閉じきるのを待ってから撮る
    await new Promise((r) => setTimeout(r, 300));
    return await DesignSnapshot.writeAll(model.doc, dir, (i, n, sc) =>
      setStatus(say('status.snapshot', { i, n, name: sc.name || sc.id })),
    );
  }

  async function send() {
    const path = model.dirty || !state.path ? await save() : state.path;
    if (!path) return;
    const request = await AppUI.prompt(say('send.prompt'), '', say('send.prompt.title'));
    if (request === null) return; // 取りやめ
    let text = DesignDoc.summarize(model.doc, path, request);
    // 画面ごとの PNG を「設計ファイル名_screens/」に書いて添付する
    const parts = [];
    try {
      const shots = await writeScreens(path);
      if (shots.length) {
        text +=
          `\n\n${say('send.images', { n: shots.length })}\n` +
          shots.map((s) => `- ${s.screen.name || s.screen.id}: ${s.path}`).join('\n');
        for (const s of shots) parts.push({ media: { path: s.path } });
      }
    } catch (e) {
      console.error('[design_canvas] snapshot failed', e);
      text += `\n\n${say('send.imagesFailed', { error: e.message || e })}`;
    }
    try {
      await MetaOS.chat.append('user', parts.length ? [{ text }, ...parts] : text, { wake: true });
      AppUI.notify(say('send.done'), 'success');
      setStatus(say('status.sent', { path }));
    } catch (e) {
      console.error('[design_canvas] send failed', e);
      setStatus(say('status.sendFailed', { error: e.message || e }), 'error');
    }
  }

  // ---------- そのほかの操作 ----------
  async function confirmDiscard() {
    if (!model.dirty) return true;
    return await AppUI.confirm(say('dialog.discard'), say('dialog.discard.title'));
  }
  async function newDoc() {
    if (!(await confirmDiscard())) return;
    state.path = null;
    state.version = null;
    state.lastText = null;
    model.replace(DesignDoc.emptyDoc());
    editor.fit();
    setStatus(say('status.new'));
  }
  async function openDialog() {
    if (!(await confirmDiscard())) return;
    await ensureDir();
    const p = await MetaOS.host.showOpenDialog({ title: say('dialog.open'), filters: ['.design', '.json'] });
    if (p) await load(p);
  }
  function openPreview(screenId) {
    const id = screenId || editor.targetScreen()?.id;
    editor.disabled = true;
    preview.open(id);
  }

  function buildPalette() {
    const pal = $('palette');
    pal.textContent = ''; // 言語が変わったときに作り直す
    for (const kind of DesignParts.KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.draggable = true;
      b.className = 'w-full text-left px-2 py-1.5 rounded text-sm text-text-main hover:bg-hover';
      b.textContent = DesignParts.SPEC[kind].name;
      b.title = say('app.palette.tip', { kind });
      b.addEventListener('click', () => editor.addFromPalette(kind));
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-design-kind', kind);
        e.dataTransfer.effectAllowed = 'copy';
      });
      pal.appendChild(b);
    }
  }

  // 画面の言語は OS の appearance.locale（AI の応答言語 preferences.language とは別）。読めなければ英語のまま
  async function initLocale() {
    try {
      const appearance = await App.Config.get('appearance');
      DesignI18n.setLocale(appearance && appearance.locale);
    } catch (e) {
      console.warn('[design_canvas] locale unavailable', e);
    }
    DesignI18n.applyStatic();
  }

  async function boot() {
    await initLocale();
    // 読み込み時に作った空の設計を、決まった言語で作り直す（画面の名前「Screen 1」／「画面 1」）
    model.replace(DesignDoc.emptyDoc());
    editor = new DesignEditor(model, $('viewport'));
    const panel = new DesignPanel(model, editor, $('panel'));
    preview = new DesignPreview(model, {
      onClose: (last) => {
        editor.disabled = false;
        if (last) {
          editor.select([last]);
          editor.focusScreen(last);
        }
      },
    });
    buildPalette();
    model.onChange(refreshTitle);

    $('btn-new').addEventListener('click', newDoc);
    $('btn-open').addEventListener('click', openDialog);
    $('btn-save').addEventListener('click', () => save());
    $('btn-saveas').addEventListener('click', () => save({ as: true }));
    $('btn-undo').addEventListener('click', () => model.undo());
    $('btn-redo').addEventListener('click', () => model.redo());
    $('btn-fit').addEventListener('click', () => editor.fit());
    $('btn-preview').addEventListener('click', () => openPreview());
    $('btn-send').addEventListener('click', send);
    $('btn-add-desktop').addEventListener('click', () => editor.select([model.addScreen()]));
    $('btn-add-phone').addEventListener('click', () => editor.select([model.addScreen({ phone: true })]));
    $('btn-add-note').addEventListener('click', () => {
      const s = model.doc.screens[0];
      editor.select([model.addNote({ x: s ? s.x : 0, y: s ? s.y - 240 : 0 })]);
    });
    global.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save({ as: e.shiftKey });
      }
    });

    if (global.MetaOS && MetaOS.system && MetaOS.system.on) {
      MetaOS.system.on('vfs_mutation', onMutation);
      // すでに開いているときに別のファイルで呼ばれた（関連付けから開き直した）
      MetaOS.system.on('route_changed', async (payload) => {
        const f = payload && payload.args && payload.args.file;
        if (f && f !== state.path && (await confirmDiscard())) await load(f);
      });
    }

    // OS の言語が変わったら、開いたままでも描き直す（設計の中身は変えない。下の帯の文は次に出るものから）
    try {
      App.Config.onChange('appearance', (appearance) => {
        if (!DesignI18n.setLocale(appearance && appearance.locale)) return;
        DesignI18n.applyStatic();
        buildPalette();
        editor.render();
        panel.render();
        refreshTitle();
      });
    } catch (e) {
      console.warn('[design_canvas] locale watch unavailable', e);
    }

    let args = {};
    try {
      args = (await MetaOS.system.getArgs()) || {};
    } catch (_) {
      /* 引数なし */
    }
    if (args.file) await load(args.file);
    else {
      editor.fit();
      setStatus(say('status.welcome'));
    }
    refreshTitle();
  }

  global.DesignApp = {
    model,
    get editor() {
      return editor;
    },
    preview: openPreview,
    save,
    load,
    send,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
