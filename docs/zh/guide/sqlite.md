# SQLite 数据库插件

这个 Fork 已经把 Tauri SQLite 插件接入到桌面壳。它适合给需要本地持久化的单页应用使用：数据库文件放在 Tauri 的应用数据目录，不会写进 `.app` 资源，也不应该提交到 Git。

## 已经完成的壳侧配置

以下配置已经在 Fork 中完成：

- `src-tauri/Cargo.toml` 增加 `tauri-plugin-sql`，启用 SQLite 驱动；
- `src-tauri/src/lib.rs` 注册 `tauri_plugin_sql::Builder`；
- `src-tauri/capabilities/default.json` 增加 `sql:default` 与 `sql:allow-execute`；
- `tauri.conf.json` 已启用 `withGlobalTauri`，所以注入脚本可以使用 `window.__TAURI__.sql`。

## 给目标网页接入桥接

1. 打开 PakePlus 的自定义 JavaScript 配置。
2. 复制 `src-tauri/data/sql-bridge.example.js` 的完整内容到自定义脚本输入框。
3. 重新预览或重新打包目标网页。
4. 目标网页等待 `window.__WB_SQL_READY__`，从 Promise 得到 `window.__WB_SQL__` 后再读写数据库。

PakePlus 会把自定义脚本写入生成应用的 `config/inject/custom.js`，并在网页加载前注入。不要把数据库文件复制到 `dist` 或 `.app` 内，也不要把运行时数据库提交到 Git。

## 目标网页需要实现的最小接口

```js
await window.__WB_SQL_READY__;
await window.__WB_SQL__.init({ database: "sqlite:科研工作台.db" });
var snapshot = await window.__WB_SQL__.loadSnapshot();
await window.__WB_SQL__.saveSnapshot(state, { reason: "state_save" });
```

网页直接在浏览器中运行时不需要这段脚本，继续使用自己的 `localStorage` 降级层即可。桥接加载失败也应自动回退，不要阻断页面启动。

## 常见问题

### 只配置了自定义脚本，为什么没有数据库？

自定义脚本只是调用壳提供的 API。必须使用包含 SQL 插件的这个 Fork 重新预览/打包；只在官方旧版壳里粘贴脚本，`window.__TAURI__.sql` 不会存在。

### 为什么要同时有 `sql:default` 和 `sql:allow-execute`？

`sql:default` 提供数据库加载、查询和关闭能力；保存快照还需要执行建表、插入、更新和事务语句，因此需要额外的 `sql:allow-execute`。

### 如何判断是否生效？

在目标网页控制台执行：

```js
await window.__WB_SQL_READY__
```

成功会返回包含 `backend: "sqlite"` 的桥接对象。之后检查应用自己的存储状态提示，确认已经显示 SQLite。若 Promise 失败，先检查是否使用了本 Fork 的重新构建产物，以及 `default.json` 是否被目标构建覆盖。
