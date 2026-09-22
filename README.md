# DSH

一个**直连 DeepSeek API 的聊天客户端**，纯静态、无后端、无构建步骤。可以部署到 GitHub Pages，然后在 iPhone 上「添加到主屏幕」，像普通 App 一样全屏启动。

## 功能

- 多轮对话，会话历史保存在本机（localStorage）
- **流式输出**：逐字返回，不是等全部生成完才显示
- **深度思考**：单独展示模型的推理过程（`reasoning_content`），可折叠
- 两个模型可切换：`deepseek-flash`、`deepseek-v4-pro`
- 停止生成、复制回复、删除会话
- 离线可打开界面（对话本身需要联网，因为模型在云端）

## 部署到 GitHub Pages

1. 把这些文件提交到仓库根目录（分支 `main`）。
2. 打开 **Settings → Pages**。
3. **Source** 选 `Deploy from a branch`，**Branch** 选 `main`，目录选 `/ (root)`，然后 **Save**。
4. 等构建完成，打开 `https://<用户名>.github.io/<仓库名>/`。

## 在 iPhone 上安装

1. 用 **Safari** 打开上面的网址（必须 Safari，Chrome 无法添加到主屏）。
2. 点 **分享 → 添加到主屏幕**。
3. 从主屏启动，全屏运行，无地址栏。

## 填入 API Key（必做）

应用启动后点右上角设置图标，填入 DeepSeek API Key（[在这里创建](https://platform.deepseek.com/api_keys)），再点「测试连接」确认可用。

**关于 Key 的安全性，请务必注意：**

- 本仓库是**公开**的。Key 只保存在你手机浏览器的 localStorage 里，**不会上传到任何服务器，也不会写进任何文件**。
- 因此**绝对不要**把 Key 写进 `app.js`、`README.md` 或任何提交的文件里——一提交就等于公开泄露，任何人都能拿去消耗你的额度。
- 应用不经过任何第三方服务器：浏览器直接请求 `https://api.deepseek.com`。
- 换手机或清除浏览器数据后需要重新填入。

## 模型与参数说明

| 模型 | 特点 |
|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash，快，1M 上下文，支持看图 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro，推理更强，不支持看图 |

思考模式通过 `thinking: {"type": "enabled" | "disabled"}` 控制，强度用 `reasoning_effort`（`low` / `high` / `max`），默认开启且为 `high`。

思考模式下 `temperature`、`presence_penalty`、`frequency_penalty` 均**不生效**（发了也会被静默忽略），所以本应用不提供这些设置，以免造成"调了没用"的误解。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构 |
| `styles.css` | 样式（含 iOS 安全区适配） |
| `app.js` | 对话逻辑、SSE 流式解析、本地存储 |
| `sw.js` | Service Worker：只缓存应用外壳，**不缓存 API 响应** |
| `manifest.webmanifest` | PWA 清单，决定添加到主屏后的表现 |
| `apple-touch-icon.png` | iOS 主屏图标（180×180 PNG，iOS 不支持 SVG 图标） |
| `icon-192.png` / `icon-512.png` | 其他平台/尺寸的图标 |
| `.nojekyll` | 让 GitHub Pages 原样输出文件，不做 Jekyll 处理 |

## 已知限制

- 没有工具能力：不能读写你的文件、不能执行命令——这些必须在你的电脑上运行。本应用只是手机端聊天界面。
- 不支持图片上传（`deepseek-flash` 支持视觉，但本应用尚未实现附件上传）。
- 会话数量多或单条回复很长时，localStorage 有容量上限（约 5MB），届时需清理旧会话。
