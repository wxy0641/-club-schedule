# 社团协同课表

面向高校社团的课表收集与时间协调工具。成员按整周课表提交，负责人按日期和节次查看谁有课、谁没课、谁声明了忙碌，并在征得成员确认后安排活动。

项目是一个无前端框架的静态应用加一个 Edge Function：浏览器端为原生 HTML/CSS/JavaScript，服务端为 Deno 模块，数据存放在 PostgreSQL 的 `app` schema 中。

## 功能

- 账号与空间：自建用户名密码账号、空间创建、邀请码加入、空间内姓名。
- 课表：按节次填写课程，支持每周/单周/双周统一规则；保存草稿与整表提交分离。
- 收集：负责人按日期和节次查看成员课程、没课与个人忙碌；空白提交表示“没课”。
- 日历例外：成员可按具体日期停课或声明忙碌/有空，日期共享需单独同意。
- 事件与安排：负责人创建空间事件或发出时间安排请求，接收人接受后才占用对应节次。
- 导出：负责人按周导出 7 个工作表的 XLSX 文件。
- 隐私：草稿不对负责人或其他成员展示；未共享的日期例外不泄露；所有写操作带版本条件与幂等请求号。

## 目录

```
functions/      Edge Function 路由、校验、会话、日历投影、收集、事件与导出
web/            静态前端（原生 JS），含 Noto Sans SC 子集字体
dev/            契约测试、浏览器脚本测试与内存假数据库
schema.sql      PostgreSQL 表结构（app schema）
```

## 本地运行

需要 Node.js 22 或更高版本。

```bash
# 静态前端 + 内存假数据库，不连接真实数据库
node dev/preview-server.mjs
# 打开 http://localhost:8787
```

本地预览只用于前端状态回归，账号与数据都在内存中，重启即清空。

## 测试

```bash
node --test dev/check.mjs
node --test dev/check-s1.mjs
node --test dev/check-s2a.mjs
node --test dev/check-s2b.mjs
node --test dev/check-s3.mjs
node --test dev/check-s4.mjs
node --test dev/check-round14.mjs
```

`dev/check-*-ui.mjs` 是浏览器脚本测试，需要本机安装 Edge 或 Chrome，默认读取 Windows 常见安装路径，可按文件顶部的候选列表调整。

这些测试直接调用真实服务端模块，只把数据层替换为内存假数据库；它们不能替代真实数据库、网关准入或托管环境的全链路验收。

## 部署

本项目按 Qoder Sites 的 Edge Function 形态编写，`functions/index.ts` 依赖部署时注入的 `./_qoder/backend.mjs`（平台适配层）。该文件不在仓库中，因此克隆后不能直接作为独立服务启动；本地可用 `dev/preview-server.mjs` 运行前端与路由逻辑。

部署到兼容环境时需要：

1. 配置 PostgreSQL，并执行 `schema.sql` 创建 `app` schema 与表。
2. 提供 `APP_PUBLIC_ORIGIN` 环境变量，值为站点完整来源（例如 `https://example.com`）。它用于写请求的来源校验；未配置时相关请求返回 `application_auth_not_configured`。
3. 让静态文件（`web/`）与函数路由同源；前端固定请求 `/functions/v1/app`。
4. 函数运行时需要平台提供 `createSiteContext`、`createDatabaseClient` 与 `errorResponse` 适配，或自行实现等价适配层。

## 安全说明

- 密码使用 PBKDF2-SHA256 存储，不保存明文；会话令牌只保存摘要。
- 写请求校验 `Origin`，会话 Cookie 为 HttpOnly、SameSite=Lax。
- 数据访问同时校验空间成员关系与角色；负责人不能读取成员草稿。
- 课表、日期例外与事件更新使用版本条件，重复请求通过请求号幂等处理。

## 许可证

代码以 MIT License 发布，见 `LICENSE`。

`web/fonts/` 中的 Noto Sans SC 子集字体按 SIL Open Font License 1.1 分发，见 `web/fonts/OFL.txt`。
