(function(){
  "use strict";
  var DRAWIO_URL = "https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min";
  var CHANNEL_NAME = "research-workbench-drawio";
  var f = document.getElementById("f");
  var status = document.getElementById("hostStatus");
  var title = document.getElementById("hostTitle");
  var text = document.getElementById("hostText");
  var actions = document.getElementById("hostActions");
  var note = document.getElementById("hostNote");
  var T = window.__TAURI__;
  var ready = false, timeoutId = null, channel = null, bridge = "";

  function setWaiting(message){
    ready = false;
    status.hidden = false;
    status.classList.remove("is-error");
    title.textContent = "正在加载 draw.io";
    text.textContent = message || "正在连接在线编辑器，首次打开可能需要 10–30 秒。";
    actions.hidden = true;
    note.hidden = true;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(function(){
      if(ready) return;
      status.classList.add("is-error");
      title.textContent = "draw.io 尚未完成加载";
      text.textContent = "窗口本身已打开，但在线编辑器没有返回初始化消息。请检查网络，或确认 PakePlus 的 CSP 允许 frame-src https://embed.diagrams.net。";
      actions.hidden = false;
      note.hidden = false;
    }, 18000);
  }
  function setReady(){
    ready = true;
    clearTimeout(timeoutId);
    status.hidden = true;
  }
  function closeCurrentWindow(){
    try{
      var api = T && (T.webviewWindow || T.window);
      var current = api && typeof api.getCurrentWebviewWindow === "function" ? api.getCurrentWebviewWindow()
        : (api && api.WebviewWindow && typeof api.WebviewWindow.getCurrent === "function" ? api.WebviewWindow.getCurrent() : null);
      if(current && typeof current.close === "function"){ current.close(); return; }
    }catch(e){}
    window.close();
  }
  function postToMain(type, payload){
    if(bridge === "broadcast" && channel){ channel.postMessage({ type:type, payload:payload }); return; }
    if(bridge === "tauri-event" && T && T.event){ T.event.emit(type, payload); }
  }
  function postToEditor(payload){
    try{ f.contentWindow.postMessage(typeof payload === "string" ? payload : JSON.stringify(payload), "*"); }catch(e){}
  }
  function bindBridge(){
    if(typeof window.BroadcastChannel === "function"){
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = function(e){
        var d = e.data || {};
        if(d.type === "drawio-load" || d.type === "drawio-cmd") postToEditor(d.payload);
      };
      bridge = "broadcast";
      return true;
    }
    if(T && T.event && T.event.listen && T.event.emit){
      T.event.listen("drawio-load", function(e){ postToEditor(e.payload); });
      T.event.listen("drawio-cmd", function(e){ postToEditor(e.payload); });
      bridge = "tauri-event";
      return true;
    }
    return false;
  }

  document.getElementById("hostRetry").addEventListener("click", function(){
    setWaiting("正在重新连接在线编辑器……");
    f.src = "about:blank";
    setTimeout(function(){ f.src = DRAWIO_URL + "&r=" + Date.now(); }, 80);
  });
  document.getElementById("hostDirect").addEventListener("click", function(){ window.location.href = "https://app.diagrams.net/"; });
  document.getElementById("hostClose").addEventListener("click", closeCurrentWindow);
  f.addEventListener("load", function(){ if(!ready) text.textContent = "编辑器页面已载入，正在等待初始化……"; });

  if(!bindBridge()){
    status.classList.add("is-error");
    title.textContent = "窗口通信能力不可用";
    text.textContent = "当前壳既不支持 BroadcastChannel，也未向子窗口注入 Tauri event API，无法与科研工作台交换图数据。";
    actions.hidden = false;
    note.hidden = false;
    return;
  }
  window.addEventListener("message", function(ev){
    if(ev.origin !== "https://embed.diagrams.net") return;
    var msg;
    try{ msg = JSON.parse(ev.data); }catch(err){ return; }
    if(msg && msg.event === "init") setReady();
    postToMain("drawio-msg", msg);
  });
  setWaiting();
})();
