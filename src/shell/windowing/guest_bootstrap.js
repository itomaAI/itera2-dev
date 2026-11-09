/**
 * src/shell/windowing/guest_bootstrap.js
 * Itera OS v2: ゲストの二段起動 — 1 段目（T-0770 / T-0784）
 *
 * ProcessManager が iframe の srcdoc に置く小さな文書のスクリプト。ホストに自分の本体を頼み（sys:boot）、
 * 返ってきた { html, hash, assets } から**自分のオリジンで** object URL を作り、本文の目印を置き換えて
 * document.write で**同じ文書**に本体を書く。ナビゲーションしないので「URL を作った文書 ＝ それを読む文書」が保たれる。
 *
 * ここにブリッジは無い（本体にインラインで入っている）。IPC の要求は素のメッセージで組む。
 * 🔴 document.open() は Window のイベントリスナを全部外す（仕様。Chromium・Firefox で確認）。
 *    このスクリプトのリスナは応答を受けた時点で自分で外し、本体のブリッジは書き直しで新しく立つ。
 * 書式は ES5（srcdoc にそのまま置く。ビルドの変換は通らない）。
 * 試験: guest_bootstrap.test.ts（jsdom で読み込み、要求と document.write の中身を見る）。
 */
(function (win, doc) {
  'use strict';
  var PROTOCOL = 'itera:ipc:v2';
  var pid = win.__ITERA_PID__;

  function fail(message) {
    // 本体が無いので、見えるのはこの文字だけ。ホストのコンソールにも同じ失敗が出ている
    doc.body.textContent = message;
  }

  /** 後順（子が先）の資源から object URL を作る。text の資源は、先に並ぶ資源の URL で目印を置き換えてから Blob にする */
  function objectUrls(assets) {
    var urls = [];
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      var blob = a.kind === 'text' ? new Blob([substitute(a.text, urls)], { type: a.mime }) : a.blob;
      urls.push([a.id, URL.createObjectURL(blob)]);
    }
    return urls;
  }

  /** 目印 → URL の置換（全部の出現。目印は 1 回の compile に固有の印を含むので誤って当たらない） */
  function substitute(text, urls) {
    for (var i = 0; i < urls.length; i++) text = text.split(urls[i][0]).join(urls[i][1]);
    return text;
  }

  function mount(body) {
    var html = substitute(body.html, objectUrls(body.assets || []));
    if (body.hash) win.location.hash = body.hash;
    doc.open();
    doc.write(html);
    doc.close();
  }

  if (typeof pid !== 'string' || !pid) {
    fail('Itera bootstrap: __ITERA_PID__ is missing');
    return;
  }

  var request = {
    protocol: PROTOCOL,
    type: 'req',
    id: 'boot-' + pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
    source: pid,
    target: 'host',
    action: 'sys:boot',
    payload: {},
    error: null,
  };

  function onResponse(e) {
    var m = e.data;
    if (e.source !== win.parent) return;
    if (!m || m.protocol !== PROTOCOL || m.type !== 'res' || m.id !== request.id) return;
    win.removeEventListener('message', onResponse);
    if (m.error) {
      fail('Itera: failed to start "' + pid + '": ' + m.error);
      return;
    }
    mount(m.payload);
  }

  win.addEventListener('message', onResponse);
  win.parent.postMessage(request, '*');
})(window, document);
