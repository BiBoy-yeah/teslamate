# 🚗 TeslaMate Dashboard Demo

TeslaMate 自定义数据看板 —— 最小可用的后端 + 前端 Demo。

## 功能

- ✅ 实时车辆状态（电量、里程、状态）
- ✅ 电池电量趋势图（24小时 / 7天 / 30天）
- ✅ 最近行程列表
- ✅ 最近充电记录
- ✅ 自动刷新（每30秒）
- ✅ 响应式布局，支持手机端

## 项目结构

```
.
├── server.js          # Express 后端 API
├── package.json       # 依赖配置
├── .env.example       # 环境变量模板
├── public/
│   └── index.html     # 前端页面（单文件，零构建）
└── README.md
```

## 快速开始

### 1. 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量模板并填写
 cp .env.example .env
# 编辑 .env，填入你的 PostgreSQL 连接信息

# 启动
npm run dev
```

访问 http://localhost:3000

### 2. 部署到 Railway

**方法一：直接部署（推荐）**

1. 在 Railway 项目里点击 **"New"** → **"Service"** → **"GitHub Repo"**
2. 把这个代码推送到 GitHub，选择仓库部署
3. 在 Railway 里添加环境变量（从 PostgreSQL 服务复制）
4. 暴露端口 `3000`，生成域名
5. 访问域名即可

**方法二：Docker Image**

1. 本地构建镜像并推送到 Docker Hub
2. 在 Railway 选择 "Docker Image" 部署

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_HOST` | ✅ | PostgreSQL 主机 |
| `DATABASE_PORT` | ❌ | 端口，默认 5432 |
| `DATABASE_NAME` | ✅ | 数据库名 |
| `DATABASE_USER` | ✅ | 用户名 |
| `DATABASE_PASS` | ✅ | 密码 |
| `DATABASE_SSL` | ❌ | 是否启用 SSL，Railway 建议设为 `true` |
| `PORT` | ❌ | 服务端口，默认 3000 |

### API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/cars` | 车辆列表 |
| `GET /api/car-status` | 实时状态 |
| `GET /api/battery-history?days=7` | 电池历史 |
| `GET /api/recent-drives?limit=10` | 最近行程 |
| `GET /api/recent-charges?limit=10` | 最近充电 |

## 技术栈

- **后端**: Node.js + Express + node-postgres
- **前端**: 原生 HTML/JS + ECharts（无构建工具）
- **数据库**: TeslaMate PostgreSQL

## 扩展建议

- 🔐 添加 JWT 认证（目前无鉴权，建议内网使用或加 Nginx Basic Auth）
- 📍 添加地图展示（用 Leaflet 显示行驶轨迹）
- 📊 添加更多图表（能耗分析、充电效率）
- 🔔 添加 WebSocket 实时推送
- 📱 打包成 PWA（可添加到手机桌面）

## 安全提醒

⚠️ 当前 Demo **没有用户认证**。部署到公网时，请务必：
1. 添加 JWT / Session 认证
2. 或用 Nginx 加 Basic Auth
3. 限制数据库用户权限（只读）

## License

MIT
